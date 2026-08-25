import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { tokkoClient } from "../tokko/client.js";
import { sendText } from "../whatsapp/client.js";
import { agentTools, executeTool, type AgentContext } from "./tools.js";
import { escalateToHumans } from "./escalation.js";
import {
  getHistory,
  saveHistory,
  hasSubmittedInquiry,
  markInquirySubmitted,
} from "./sessionStore.js";

const anthropic = new Anthropic(); // toma ANTHROPIC_API_KEY del entorno

const SYSTEM_PROMPT = `Sos el asistente de WhatsApp de una inmobiliaria. Respondés
consultas usando exclusivamente datos reales de Tokko (herramientas
search_properties / search_developments / get_property_details) — nunca
inventes precios, direcciones ni características de una propiedad.

Estilo: español rioplatense, tono cordial y directo, mensajes cortos aptos
para WhatsApp (sin markdown de títulos, listas simples si hace falta).

Cuándo usar cada herramienta:
- search_properties / get_property_details: antes de responder cualquier
  pregunta sobre propiedades disponibles, precios o características.
  search_properties devuelve "shown_count" (cuántas te muestra) y
  "matched_at_least" con "total_is_exact": si total_is_exact es false,
  "matched_at_least" es un piso, no el total real — decí "al menos N" o
  "más de N", nunca afirmes un número exacto de unidades/propiedades salvo
  que total_is_exact sea true.
- search_developments: cuando el cliente mencione el nombre de un
  emprendimiento/proyecto en vez de (o además de) una zona genérica —
  confirmá el nombre comercial ahí antes de decir que no figura.
- Si una propiedad pertenece a un emprendimiento, "address" ya viene
  priorizando la ubicación del emprendimiento (más confiable) por sobre la
  de la unidad individual — usá ese valor tal cual te lo devuelve la
  herramienta, no lo cuestiones ni lo compares con otra fuente.
- get_development_details: después de ubicar un emprendimiento con
  search_developments, usala si el cliente pide más info, la descripción o
  el link ("url") de la publicación — pasale ese link tal cual, no lo
  inventes ni lo armes a mano.
- get_zonaprop_link: solo si el cliente pide específicamente el link de
  Zonaprop (no el link general de la publicación, para eso ya alcanza con
  "url"). Puede no encontrar nada ("found" false) — en ese caso decilo con
  naturalidad, no inventes un link.
- share_file: cuando pidan fotos, planos, brochure/folleto o ficha (de una
  propiedad o de un emprendimiento) y exista un archivo relacionado en
  Drive. Buscá con palabras clave del nombre del proyecto/propiedad. Si no
  aparece nada ("sent" es false), la herramienta ya le avisó sola a un
  agente humano (ver "escalated") — no llames aparte a escalate_to_human
  para lo mismo. En tu respuesta confirmá explícitamente qué le avisaste al
  equipo (ej. "ya le avisé al equipo que buscás el brochure de X, en breve
  te lo mandan") antes de ofrecer cualquier otra cosa — no cambies de tema
  a ofrecer fotos u otro material sin primero dejar claro que estás
  consultando por lo que pidió.
- save_lead_notes: cuando el cliente comparta presupuesto, zona de interés,
  plazos u otra info con valor comercial real — queda como una consulta
  nueva pendiente de revisión en Tokko, así que no la uses para cada
  mensaje.
- update_opportunity_stage: cuando el estado real de la conversación cambie
  dentro del embudo de Oportunidades (ver el enum de la herramienta para el
  significado de cada etapa). Puede no tener efecto si el contacto todavía
  no fue aprobado del lado humano — no pasa nada si falla, seguí la
  conversación con normalidad.
- escalate_to_human: cuando el cliente pida algo que ninguna herramienta te
  puede resolver (un dato que no está en Tokko/Drive, una condición
  comercial particular, reclamo, o simplemente no sabés la respuesta),
  usala para avisarle a un agente humano y decile al cliente que en breve
  lo contacta alguien del equipo. No es lo mismo que save_lead_notes (esa
  es para guardar info comercial, no para pedir ayuda).

Si no tenés información suficiente para responder y ninguna herramienta te
la puede dar, no inventes: pedí la información que falta o escalá con
escalate_to_human.

Si el cliente repite o insiste con un pedido que ya escalaste antes en esta
misma conversación (share_file o escalate_to_human) y no ves en el
historial que alguien del equipo ya haya contestado, volvé a escalarlo —
no asumas que "ya está resuelto" solo porque lo mencionaste antes. Si
alguien del equipo sí contestó (vas a ver ese mensaje como tuyo en el
historial, ya que se integra a la charla), seguí la conversación con esa
info con normalidad, sin volver a escalar lo mismo.`;

const MAX_TOOL_ITERATIONS = 6;

interface IncomingMessage {
  from: string;
  name: string;
  text: string;
}

export async function handleIncomingMessage(msg: IncomingMessage): Promise<void> {
  const { from, name, text } = msg;

  try {
    // El CRM es best-effort: si algo falla del lado de Tokko, el bot igual
    // tiene que poder responder la consulta con datos de solo lectura —
    // nunca debe cortar la respuesta al cliente por esto.
    let contactId: number | null = null;
    try {
      const existing = await tokkoClient.findContactByPhone(from);
      if (existing) {
        contactId = existing.id;
      } else if (!hasSubmittedInquiry(from)) {
        // Contacto nuevo: manda la consulta a Tokko (queda pendiente de
        // aprobación manual — no hay forma de saltear ese paso por API,
        // ver src/tokko/client.ts). Solo una vez por número mientras el
        // proceso siga corriendo, para no inundar la bandeja de Pendientes.
        await tokkoClient.submitInquiry({ name, phone: from, text, tags: ["WhatsApp"] });
        markInquirySubmitted(from);
      }
    } catch (error) {
      logger.warn("tokko.crm_sync_failed", { from, error: String(error) });
    }

    const ctx: AgentContext = { customerPhone: from, customerName: name, contactId };

    const messages: Anthropic.MessageParam[] = [...getHistory(from), { role: "user", content: text }];

    const replyText = await runAgentLoop(messages, ctx, text);

    if (replyText) {
      await sendText(from, replyText);
    }
    saveHistory(from, messages);
  } catch (error) {
    logger.error("agent.orchestration_failed", { from, error: String(error) });
    await escalateToHumans({
      customerPhone: from,
      customerName: name,
      question: text,
      reason: `Falla técnica procesando el mensaje: ${String(error)}`,
    }).catch((e) => logger.warn("agent.escalation_failed", { error: String(e) }));
    await sendText(
      from,
      "Perdón, tuvimos un problema técnico procesando tu consulta. Ya te contactamos a la brevedad.",
    ).catch(() => {});
  }
}

async function runAgentLoop(
  messages: Anthropic.MessageParam[],
  ctx: AgentContext,
  originalText: string,
): Promise<string> {
  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await anthropic.messages.create({
      model: "claude-opus-5",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: agentTools,
      messages,
      output_config: { effort: "medium" },
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "pause_turn") {
      continue;
    }

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUseBlocks.length === 0) {
      return response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUseBlocks) {
      let content: string;
      try {
        content = await executeTool(toolUse.name, toolUse.input as Record<string, unknown>, ctx);
      } catch (error) {
        // Antes esto quedaba solo del lado del modelo (silencioso en la
        // terminal) — lo logueamos también acá para poder diagnosticar
        // fallas reales (ej. Drive mal configurado) sin adivinar.
        logger.error("agent.tool_failed", {
          tool: toolUse.name,
          input: toolUse.input,
          error: String(error),
        });
        content = JSON.stringify({ error: String(error) });
      }
      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content });
    }
    messages.push({ role: "user", content: toolResults });
  }

  logger.warn("agent.max_iterations_reached", { contactId: ctx.contactId });
  await escalateToHumans({
    customerPhone: ctx.customerPhone,
    customerName: ctx.customerName,
    question: originalText,
    reason: "El agente se quedó dando vueltas sin poder cerrar una respuesta.",
  }).catch((error) => logger.warn("agent.escalation_failed", { error: String(error) }));
  return "Estoy revisando tu consulta con más detalle, te respondo en breve.";
}
