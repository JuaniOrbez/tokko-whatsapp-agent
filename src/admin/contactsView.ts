import { getEntriesForPhone, listRecentConversations, type ConversationLogEntry } from "../agent/conversationLog.js";
import { getLatestStageByPhone } from "../agent/stageLog.js";
import { valuesByPhone } from "../agent/toolUsageLog.js";
import { esc, pageShell as pageShellBase } from "./layout.js";

function pageShell(title: string, body: string): string {
  return pageShellBase(title, body, "/admin", { wide: true });
}

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

/** Primer mail que escribió el cliente en la charla, si dio alguno — no hay ningún otro lugar de donde sacarlo (Tokko no expone el contacto por teléfono). */
function findEmail(entries: ConversationLogEntry[]): string | undefined {
  for (const e of entries) {
    if (e.role !== "user") continue;
    const match = e.text.match(EMAIL_REGEX);
    if (match) return match[0];
  }
  return undefined;
}

function summarizeActivity(entries: ConversationLogEntry[]): string {
  const messageCount = entries.filter((e) => e.role === "user").length;
  const first = new Date(entries[0].ts).toLocaleDateString("es-AR");
  const last = new Date(entries[entries.length - 1].ts).toLocaleDateString("es-AR");
  const range = first === last ? `el ${first}` : `del ${first} al ${last}`;
  const channel = entries.find((e) => e.channel)?.channel;
  return `${messageCount} mensaje${messageCount === 1 ? "" : "s"} · ${range}${channel ? ` · ${channel}` : ""}`;
}

/**
 * Agenda de contactos: cada cliente que escribió, con la última etapa de
 * Oportunidades que el agente detectó en la charla (ver stageLog.ts) — Tokko
 * no permite escribir el estado por API, así que esta lista es la forma de
 * que alguien del equipo la revise y la aplique a mano en Tokko.
 */
export function renderContactsList(): string {
  const conversations = listRecentConversations();
  if (conversations.length === 0) {
    return pageShell("Contactos", '<div class="empty">Todavía no hay contactos registrados.</div>');
  }
  const stageByPhone = getLatestStageByPhone();
  const developmentsByPhone = valuesByPhone("development");
  const locationsByPhone = valuesByPhone("location");

  const rows = conversations
    .map((c) => {
      const entries = getEntriesForPhone(c.phone);
      const stage = stageByPhone.get(c.phone);
      const email = findEmail(entries);
      const interests = [...(developmentsByPhone.get(c.phone) ?? []), ...(locationsByPhone.get(c.phone) ?? [])];

      return `
      <div class="card contact-card">
        <div class="contact-header">
          <span class="contact-name">${esc(c.name)}</span>
          ${stage ? `<span class="stage-badge">${esc(stage.stageLabel)}</span>` : `<span class="meta">Sin etapa anotada</span>`}
        </div>
        <div class="contact-fields">
          <div class="contact-field"><span class="field-label">Teléfono</span><span>${esc(c.phone)}</span></div>
          <div class="contact-field"><span class="field-label">Email</span><span>${email ? esc(email) : '<span class="meta">Sin datos</span>'}</span></div>
          <div class="contact-field"><span class="field-label">Actividad</span><span>${esc(summarizeActivity(entries))}</span></div>
          <div class="contact-field"><span class="field-label">Preguntó por</span><span>${interests.length > 0 ? esc(interests.join(", ")) : '<span class="meta">Sin datos</span>'}</span></div>
          ${stage?.reason ? `<div class="contact-field"><span class="field-label">Motivo de etapa</span><span>${esc(stage.reason)}</span></div>` : ""}
        </div>
        <a class="contact-link" href="/admin/conversations/${encodeURIComponent(c.phone)}">Ver conversación completa →</a>
      </div>`;
    })
    .join("\n");

  const body = `
    <div class="hint" style="margin-bottom: 16px;">
      Etapa según lo que detectó el agente en la charla — Tokko no permite actualizarla por API, así que hay que aplicarla a mano en tu cuenta de Tokko.
    </div>
    ${rows}
    <style>
      .contact-card { display: flex; flex-direction: column; gap: 12px; }
      .contact-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
      .contact-name { font-weight: 700; font-size: 1rem; }
      .contact-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 20px; }
      @media (max-width: 560px) { .contact-fields { grid-template-columns: 1fr; } }
      .contact-field { display: flex; flex-direction: column; gap: 2px; font-size: 0.88rem; }
      .field-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-muted); font-weight: 600; }
      .contact-card a.contact-link { display: inline; align-self: flex-start; color: var(--brand); text-decoration: none; font-size: 0.85rem; font-weight: 600; }
      .contact-card a.contact-link:hover { text-decoration: underline; }
      .stage-badge {
        display: inline-block; background: var(--brand); color: white; font-size: 0.78rem;
        font-weight: 600; padding: 3px 10px; border-radius: 999px;
      }
      .hint { font-size: 0.85rem; color: var(--text-muted); line-height: 1.5; }
    </style>
  `;
  return pageShell("Contactos", body);
}
