import { listRecentConversations } from "../agent/conversationLog.js";
import { getLatestStageByPhone } from "../agent/stageLog.js";
import { esc, pageShell as pageShellBase } from "./layout.js";

function pageShell(title: string, body: string): string {
  return pageShellBase(title, body, "/admin", { wide: true });
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

  const rows = conversations
    .map((c) => {
      const stage = stageByPhone.get(c.phone);
      const stageHtml = stage
        ? `<span class="stage-badge">${esc(stage.stageLabel)}</span>${stage.reason ? `<span class="meta">${esc(stage.reason)}</span>` : ""}`
        : `<span class="meta">Sin etapa anotada</span>`;
      return `
      <div class="card contact-card">
        <a href="/admin/conversations/${encodeURIComponent(c.phone)}">
          <div class="contact-main">
            <span>${esc(c.name)} · ${esc(c.phone)}</span>
            <span class="meta">Último mensaje: ${esc(new Date(c.lastTs).toLocaleString("es-AR"))}</span>
          </div>
          <div class="contact-stage">${stageHtml}</div>
        </a>
      </div>`;
    })
    .join("\n");

  const body = `
    <div class="hint" style="margin-bottom: 16px;">
      Etapa según lo que detectó el agente en la charla — Tokko no permite actualizarla por API, así que hay que aplicarla a mano en tu cuenta de Tokko. Tocá un contacto para ver la conversación completa.
    </div>
    ${rows}
    <style>
      .contact-card a { flex-direction: column; align-items: stretch; gap: 8px; }
      .contact-main { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }
      .contact-stage { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .stage-badge {
        display: inline-block; background: var(--brand); color: white; font-size: 0.78rem;
        font-weight: 600; padding: 3px 10px; border-radius: 999px;
      }
      .hint { font-size: 0.85rem; color: var(--text-muted); line-height: 1.5; }
    </style>
  `;
  return pageShell("Contactos", body);
}
