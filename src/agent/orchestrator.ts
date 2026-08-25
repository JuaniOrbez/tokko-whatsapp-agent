import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { tokkoClient } from "../tokko/client.js";
import { sendText, sendTemplate } from "../whatsapp/client.js";
import { getSettings } from "../settings.js";
import { getAgentTools, executeTool, type AgentContext } from "./tools.js";
import { escalateToHumans } from "./escalation.js";
import {
  getHistory,
  saveHistory,
  appendAssistantMessage,
  hasSubmittedInquiry,
  markInquirySubmitted,
} from "./sessionStore.js";

const anthropic = new Anthropic(); // toma ANTHROPIC_API_KEY del entorno

const SYSTEM_PROMPT_BASE = `Sos el asistente de WhatsApp de una inmobiliaria. Respondés
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
  aparece nada ("sent" es false), la herramienta ya escaló sola por
  detrás (ver "escalated") — no llames aparte a escalate_to_human para lo
  mismo. En tu respuesta confirmá explícitamente qué estás gestionando
  (ej. "lo estoy consultando, en cuanto lo tenga te lo paso") antes de
  ofrecer cualquier otra cosa — no cambies de tema a ofrecer fotos u otro
  material sin primero dejar claro que estás averiguando lo que pidió.
  Hablá siempre en primera persona vos como si lo estuvieras resolviendo
  vos mismo — nunca menciones "el equipo", "un compañero" ni que hay un
  humano de por medio, aunque en la práctica lo haya.
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
  usala para escalarlo por detrás. Igual que con share_file: contale al
  cliente en primera persona que lo estás averiguando/consultando y que en
  breve le confirmás, sin mencionar "el equipo" ni que hay un humano
  resolviéndolo. No es lo mismo que save_lead_notes (esa es para guardar
  info comercial, no para pedir ayuda).

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

/**
 * Arma el system prompt completo agregándole el estilo de comunicación
 * configurado en /admin. No hay matching automático por código: se le pasa
 * al modelo la lista entera de tonos especiales por propiedad/emprendimiento
 * y es él quien decide, según de qué habla la conversación, cuál aplicar.
 */
function buildSystemPrompt(): string {
  const style = getSettings().communicationStyle;
  let extra = "";

  if (style.general.trim()) {
    extra += `\n\nEstilo de comunicación configurado por la inmobiliaria (además de lo de arriba):\n${style.general.trim()}`;
  }

  if (style.overrides.length > 0) {
    const lines = style.overrides
      .filter((o) => o.match.trim() && o.style.trim())
      .map((o) => `- ${o.match.trim()}: ${o.style.trim()}`)
      .join("\n");
    if (lines) {
      extra +=
        `\n\nTonos especiales por propiedad/emprendimiento — si la conversación es sobre ` +
        `alguno de estos en particular, adaptá el tono según corresponda (si no coincide con ` +
        `ninguno, usá el estilo general):\n${lines}`;
    }
  }

  return SYSTEM_PROMPT_BASE + extra;
}

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
      system: buildSystemPrompt(),
      tools: getAgentTools(),
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

const RELAY_SYSTEM_PROMPT = `Sos el mismo asistente de WhatsApp de la inmobiliaria de siempre,
en la misma conversación con este cliente. Alguien del equipo te acaba de
pasar la info que faltaba para contestarle algo que le habías dicho que
ibas a averiguar/consultar.

Redactá el mensaje final para el cliente entregándole esa información como
si la hubieras conseguido vos — nunca menciones que fue un humano quien
respondió, ni "el equipo", ni ningún hand-off. Estilo español rioplatense,
corto, directo, sin markdown de títulos. No agregues datos que no estén en
la info que te paso, y no repreguntes nada — es un mensaje final, no un
turno de herramientas.`;

/**
 * Redacta y manda al cliente la respuesta que un humano dejó para una
 * consulta escalada (ver webhook.ts#handleHumanReply / escalation.ts). Usa
 * el historial de la conversación para que la redacción quede natural y en
 * contexto, en vez de pegar el texto del humano tal cual.
 */
export async function relayHumanReply(customerPhone: string, humanText: string): Promise<void> {
  const history = getHistory(customerPhone);
  const response = await anthropic.messages.create({
    model: "claude-opus-5",
    max_tokens: 512,
    system: RELAY_SYSTEM_PROMPT,
    messages: [
      ...history,
      { role: "user", content: `[Info que te pasó el equipo para el cliente]: "${humanText}"` },
    ],
  });

  const replyText = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  if (!replyText) {
    logger.warn("agent.relay_human_reply_empty", { customerPhone });
    return;
  }

  await sendText(customerPhone, replyText);
  appendAssistantMessage(customerPhone, replyText);
}

/**
 * Inicia una conversación con alguien que todavía no le escribió al agente
 * (ej. un comercial que atendió una llamada y quiere que el agente haga el
 * seguimiento por WhatsApp). WhatsApp no permite mandar texto libre en este
 * caso — exige un Content Template aprobado por Meta (ver
 * initiateConversationTemplateSid en /admin y docs/SETUP.md). Devuelve un
 * error legible si falta esa configuración o si Twilio rechaza el envío.
 */
export async function initiateConversation(input: {
  phone: string;
  customerName: string;
  reason: string;
}): Promise<{ ok: boolean; error?: string }> {
  const settings = getSettings();
  const templateSid = settings.initiateConversationTemplateSid;
  if (!templateSid) {
    return {
      ok: false,
      error: "Falta configurar el Content SID del template en /admin (sección Iniciar conversación).",
    };
  }

  try {
    await sendTemplate(input.phone, templateSid, { "1": input.customerName, "2": input.reason });
  } catch (error) {
    logger.error("agent.initiate_conversation_failed", { phone: input.phone, error: String(error) });
    return { ok: false, error: String(error) };
  }

  // Twilio no devuelve el texto ya renderizado del template al mandarlo —
  // reconstruimos lo que el cliente vio a partir del texto configurado, así
  // el agente tiene contexto real de lo que ya se le dijo cuando conteste.
  const templateText =
    settings.initiateConversationTemplateText ??
    "Hola {{1}}! Somos de ismo Propiedades. Nos comentaron que estás buscando {{2}}. ¿En qué te podemos ayudar?";
  const renderedText = templateText.replace("{{1}}", input.customerName).replace("{{2}}", input.reason);
  appendAssistantMessage(input.phone, renderedText);

  logger.info("agent.conversation_initiated", { phone: input.phone });
  return { ok: true };
}
