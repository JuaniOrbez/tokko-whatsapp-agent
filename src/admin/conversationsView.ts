import Anthropic from "@anthropic-ai/sdk";
import { getEntriesForPhone, listRecentConversations } from "../agent/conversationLog.js";
import { buildDailySummary } from "../agent/dailySummary.js";
import { logger } from "../logger.js";
import { esc, pageShell as pageShellBase } from "./layout.js";

const anthropic = new Anthropic();
function pageShell(title: string, body: string): string {
  return pageShellBase(title, body, "/admin/config");
}

const FLOW_SYSTEM_PROMPT = `Convertís una conversación de WhatsApp entre un
cliente y un agente inmobiliario en un diagrama de flujo en sintaxis
Mermaid (flowchart TD). Cada nodo representa un momento clave de la charla
(una pregunta del cliente, una respuesta relevante del agente, una
derivación a un humano, un resultado/cierre) — no hace falta un nodo por
cada mensaje, agrupá lo que tenga sentido. Texto corto por nodo (máximo
~8 palabras). Devolvé ÚNICAMENTE código Mermaid válido, sin explicaciones
ni bloques de markdown \`\`\`, arrancando directo con "flowchart TD".`;

export function renderConversationsList(): string {
  const conversations = listRecentConversations();
  if (conversations.length === 0) {
    return pageShell("Conversaciones", '<div class="empty">Todavía no hay conversaciones registradas.</div>');
  }
  const rows = conversations
    .map(
      (c) => `
      <div class="card">
        <a href="/admin/conversations/${encodeURIComponent(c.phone)}">
          <span>${esc(c.name)} · ${esc(c.phone)}</span>
          <span class="meta">${esc(new Date(c.lastTs).toLocaleString("es-AR"))}</span>
        </a>
      </div>`,
    )
    .join("\n");
  return pageShell("Conversaciones", rows);
}

export async function renderConversationDetail(phone: string): Promise<string> {
  const entries = getEntriesForPhone(phone);
  if (entries.length === 0) {
    return pageShell("Conversación", '<div class="empty">No hay mensajes registrados para este número.</div>');
  }

  const transcript = entries
    .map((e) => `[${new Date(e.ts).toLocaleString("es-AR")}] ${e.role === "user" ? "Cliente" : "Agente"}: ${e.text}`)
    .join("\n");

  let mermaidCode = "flowchart TD\n  a[No se pudo generar el diagrama]";
  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-5",
      max_tokens: 1024,
      system: FLOW_SYSTEM_PROMPT,
      messages: [{ role: "user", content: transcript }],
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) mermaidCode = text;
  } catch (error) {
    logger.error("admin.conversation_diagram_failed", { phone, error: String(error) });
  }

  const messagesHtml = entries
    .map(
      (e) => `
      <div class="msg ${e.role}">
        <div class="role">${e.role === "user" ? "Cliente" : "Agente"} · ${esc(new Date(e.ts).toLocaleString("es-AR"))}</div>
        <div>${esc(e.text)}</div>
      </div>`,
    )
    .join("\n");

  const body = `
    <pre class="mermaid">${esc(mermaidCode)}</pre>
    <div class="msg-log">${messagesHtml}</div>
  `;
  return pageShell(`${entries[0].name} · ${phone}`, body);
}

export async function renderDailySummaryView(): Promise<string> {
  let result;
  try {
    result = await buildDailySummary();
  } catch (error) {
    logger.error("admin.daily_summary_view_failed", { error: String(error) });
    return pageShell("Resumen de hoy", '<div class="empty">No se pudo generar el resumen. Probá de nuevo en un momento.</div>');
  }

  if (!result) {
    return pageShell("Resumen de hoy", '<div class="empty">Todavía no hubo actividad hoy.</div>');
  }

  const summaryHtml = esc(result.text).replace(/\n/g, "<br>");
  const body = `
    <div class="card">
      <div class="meta" style="margin-bottom: 10px;">${result.entryCount} mensajes registrados hoy</div>
      <div>${summaryHtml}</div>
    </div>
  `;
  return pageShell("Resumen de hoy", body);
}
