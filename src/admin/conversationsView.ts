import Anthropic from "@anthropic-ai/sdk";
import { getEntriesForPhone, listRecentConversations } from "../agent/conversationLog.js";
import { buildDailySummary } from "../agent/dailySummary.js";
import { logger } from "../logger.js";
import { esc, pageShell as pageShellBase } from "./layout.js";

const anthropic = new Anthropic();
function pageShell(title: string, body: string): string {
  return pageShellBase(title, body, "/admin");
}

const FLOW_SYSTEM_PROMPT = `Convertís una conversación de WhatsApp entre un
cliente y un agente inmobiliario en un diagrama de flujo en sintaxis
Mermaid (flowchart LR, de izquierda a derecha). Cada nodo representa un
momento clave de la charla — no hace falta un nodo por cada mensaje,
agrupá lo que tenga sentido. Texto corto por nodo (máximo ~8 palabras).

Reglas de sintaxis, estrictas:
- Cada nodo se define como id(Texto del nodo) — rectángulo redondeado,
  nunca otra forma (nada de {}, [[ ]], (( )), etc.).
- Cada nodo termina con exactamente una de estas tres clases, sin
  excepción — no declares vos los classDef, ya están definidos aparte:
  :::cliente   → algo que preguntó o dijo el cliente
  :::agente    → una respuesta o acción del agente
  :::evento    → una derivación a un humano, o un resultado/cierre de la charla

Ejemplo de una línea válida: a(Pregunta por 2 ambientes en Núñez):::cliente

Devolvé ÚNICAMENTE código Mermaid válido, sin explicaciones ni bloques de
markdown \`\`\`, arrancando directo con "flowchart LR".`;

// Colores fijos (no los define el LLM) — misma paleta categórica validada
// que en metricsView.ts (node scripts/validate_palette.js de la skill de
// dataviz), extendiendo el violeta de marca del resto del panel.
const FLOW_CLASS_DEFS = `
classDef cliente fill:#1a9c85,color:#ffffff,stroke:#158066,stroke-width:1px,rx:10,ry:10;
classDef agente fill:#6d5ef8,color:#ffffff,stroke:#5646e0,stroke-width:1px,rx:10,ry:10;
classDef evento fill:#c9820a,color:#ffffff,stroke:#a36a08,stroke-width:1px,rx:10,ry:10;
`;

const FLOW_LEGEND = `
  <div class="flow-legend">
    <span class="legend-item"><span class="swatch" style="background:#1a9c85"></span>Cliente</span>
    <span class="legend-item"><span class="swatch" style="background:#6d5ef8"></span>Agente</span>
    <span class="legend-item"><span class="swatch" style="background:#c9820a"></span>Derivación / resultado</span>
  </div>`;

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

  let mermaidCode = "flowchart LR\n  a(No se pudo generar el diagrama):::evento";
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
  // Los colores los define el código, no el LLM — se agregan siempre, así
  // el diagrama nunca depende de que el modelo los haya declarado bien.
  mermaidCode += `\n${FLOW_CLASS_DEFS}`;

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
    <div class="mermaid-card">
      <pre class="mermaid">${esc(mermaidCode)}</pre>
      ${FLOW_LEGEND}
    </div>
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
