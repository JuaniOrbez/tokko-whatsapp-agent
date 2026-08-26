import Anthropic from "@anthropic-ai/sdk";
import { getEntriesForPhone, listRecentConversations } from "../agent/conversationLog.js";
import { buildDailySummary } from "../agent/dailySummary.js";
import { logger } from "../logger.js";

const anthropic = new Anthropic();

const FLOW_SYSTEM_PROMPT = `Convertís una conversación de WhatsApp entre un
cliente y un agente inmobiliario en un diagrama de flujo en sintaxis
Mermaid (flowchart TD). Cada nodo representa un momento clave de la charla
(una pregunta del cliente, una respuesta relevante del agente, una
derivación a un humano, un resultado/cierre) — no hace falta un nodo por
cada mensaje, agrupá lo que tenga sentido. Texto corto por nodo (máximo
~8 palabras). Devolvé ÚNICAMENTE código Mermaid válido, sin explicaciones
ni bloques de markdown \`\`\`, arrancando directo con "flowchart TD".`;

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function pageShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --brand: #6d5ef8; --brand-dark: #5646e0; --bg: #f4f5fb; --card: #ffffff; --border: #eaeaf3; --text: #16162a; --text-muted: #75758c; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; margin: 0; background: var(--bg); color: var(--text); }
  header { background: linear-gradient(120deg, var(--brand) 0%, var(--brand-dark) 55%, #4433c9 100%); color: white; padding: 22px 24px; display: flex; align-items: center; gap: 12px; }
  header a { color: white; text-decoration: none; font-size: 0.85rem; opacity: 0.85; }
  header h1 { font-size: 1.15rem; margin: 0; font-weight: 700; }
  main { max-width: 780px; margin: 28px auto 64px; padding: 0 16px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px; margin-bottom: 12px; box-shadow: 0 1px 2px rgba(23,21,60,0.05); }
  .card a { color: var(--text); text-decoration: none; display: flex; justify-content: space-between; align-items: center; }
  .card a:hover { color: var(--brand); }
  .card .meta { font-size: 0.8rem; color: var(--text-muted); }
  .empty { color: var(--text-muted); padding: 20px 0; }
  .mermaid { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 24px; }
  .msg-log { margin-top: 24px; }
  .msg { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; margin-bottom: 8px; font-size: 0.88rem; }
  .msg.user { border-left: 3px solid var(--brand); }
  .msg.assistant { border-left: 3px solid var(--text-muted); }
  .msg .role { font-weight: 600; font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.03em; }
</style>
</head>
<body>
  <header>
    <div>
      <a href="/admin">← Panel</a>
      <h1>${esc(title)}</h1>
    </div>
  </header>
  <main>${body}</main>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <script>if (window.mermaid) mermaid.initialize({ startOnLoad: true });</script>
</body>
</html>`;
}

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
