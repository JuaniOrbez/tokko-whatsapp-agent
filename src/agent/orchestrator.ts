import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { tokkoClient } from "../tokko/client.js";
import { sendText } from "../whatsapp/client.js";
import { agentTools, executeTool, type AgentContext } from "./tools.js";
import { getHistory, saveHistory } from "./sessionStore.js";

const anthropic = new Anthropic(); // toma ANTHROPIC_API_KEY del entorno

const SYSTEM_PROMPT = `Sos el asistente de WhatsApp de una inmobiliaria. Respondés
consultas usando exclusivamente datos reales de Tokko (herramientas
search_properties / get_property_details) — nunca inventes precios,
direcciones ni características de una propiedad.

Estilo: español rioplatense, tono cordial y directo, mensajes cortos aptos
para WhatsApp (sin markdown de títulos, listas simples si hace falta).

Cuándo usar cada herramienta:
- search_properties / get_property_details: antes de responder cualquier
  pregunta sobre propiedades disponibles, precios o características.
- share_file: cuando pidan fotos, planos, folleto o ficha de una propiedad
  y exista un archivo relacionado en Drive.
- save_lead_notes: cuando el cliente comparta presupuesto, zona de interés,
  plazos u otra info relevante para el seguimiento comercial.
- update_opportunity_stage: cuando el estado real de la conversación cambie
  (fue contactado, se calificaron sus necesidades, agendó una visita, está
  negociando, cerró o se cayó el negocio). No la uses en cada mensaje, solo
  cuando corresponda un cambio real.

Si no tenés información suficiente para responder, pedí la información que
falta en vez de asumir.`;

const MAX_TOOL_ITERATIONS = 6;

interface IncomingMessage {
  from: string;
  name: string;
  text: string;
}

export async function handleIncomingMessage(msg: IncomingMessage): Promise<void> {
  const { from, name, text } = msg;

  try {
    const contact = await tokkoClient.ensureContact({ name, phone: from });
    const opportunity = await tokkoClient.ensureOpportunity(contact.id);

    tokkoClient.addNote(contact.id, `WhatsApp — ${name}: ${text}`).catch((error) => {
      logger.warn("tokko.add_inbound_note_failed", { contactId: contact.id, error: String(error) });
    });

    const ctx: AgentContext = {
      customerPhone: from,
      contactId: contact.id,
      opportunityId: opportunity.id,
    };

    const messages: Anthropic.MessageParam[] = [...getHistory(from), { role: "user", content: text }];

    const replyText = await runAgentLoop(messages, ctx);

    if (replyText) {
      await sendText(from, replyText);
    }
    saveHistory(from, messages);
  } catch (error) {
    logger.error("agent.orchestration_failed", { from, error: String(error) });
    await sendText(
      from,
      "Perdón, tuvimos un problema técnico procesando tu consulta. Ya te contactamos a la brevedad.",
    ).catch(() => {});
  }
}

async function runAgentLoop(messages: Anthropic.MessageParam[], ctx: AgentContext): Promise<string> {
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
        content = JSON.stringify({ error: String(error) });
      }
      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content });
    }
    messages.push({ role: "user", content: toolResults });
  }

  logger.warn("agent.max_iterations_reached", { contactId: ctx.contactId });
  return "Estoy revisando tu consulta con más detalle, te respondo en breve.";
}
