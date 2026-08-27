import { getEntriesForPhone, listRecentConversations, type ConversationLogEntry } from "../agent/conversationLog.js";
import { getLatestStageByPhone, type StageLogEntry } from "../agent/stageLog.js";
import { getLatestTierByPhone, type TierLogEntry } from "../agent/tierLog.js";
import { valuesByPhone } from "../agent/toolUsageLog.js";
import { esc, pageShell as pageShellBase } from "./layout.js";

function pageShell(title: string, body: string, backHref = "/admin/contacts"): string {
  return pageShellBase(title, body, backHref, { wide: true });
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

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

/**
 * Agenda de contactos: cada cliente que escribió, con la última etapa de
 * Oportunidades y el tier que el agente detectó en la charla (ver
 * stageLog.ts / tierLog.ts) — Tokko no permite escribir el estado por API,
 * así que esta lista es la forma de que alguien del equipo la revise y
 * aplique los cambios a mano en Tokko. Es solo un índice compacto — tocar
 * un contacto abre su ficha completa (renderContactDetail).
 */
export function renderContactsList(): string {
  const conversations = listRecentConversations();
  if (conversations.length === 0) {
    return pageShell("Contactos", '<div class="empty">Todavía no hay contactos registrados.</div>', "/admin");
  }
  const stageByPhone = getLatestStageByPhone();
  const tierByPhone = getLatestTierByPhone();
  const developmentsByPhone = valuesByPhone("development");
  const locationsByPhone = valuesByPhone("location");

  const rows = conversations
    .map((c) => {
      const stage = stageByPhone.get(c.phone);
      const tier = tierByPhone.get(c.phone);
      const interests = [...(developmentsByPhone.get(c.phone) ?? []), ...(locationsByPhone.get(c.phone) ?? [])];
      // Para el email hace falta el texto completo de la charla — se
      // recalcula acá (barato: listas chicas) para que el buscador también
      // encuentre por email desde esta pantalla, sin tener que entrar al
      // detalle de cada contacto.
      const email = findEmail(getEntriesForPhone(c.phone));

      const searchBlob = [c.name, c.phone, email, ...interests, stage?.stageLabel, tier?.tierLabel]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return `
      <div class="card contact-row" data-search="${esc(searchBlob)}">
        <a href="/admin/contacts/${encodeURIComponent(c.phone)}">
          <span class="contact-row-main">
            <span class="contact-row-name">${esc(c.name)}</span>
            <span class="contact-row-badges">
              ${tier ? `<span class="badge tier-badge">${esc(tier.tierLabel)}</span>` : ""}
              ${stage ? `<span class="badge stage-badge">${esc(stage.stageLabel)}</span>` : ""}
            </span>
          </span>
          <span class="meta">${esc(c.phone)}</span>
        </a>
      </div>`;
    })
    .join("\n");

  const body = `
    <div class="search-field">
      <input type="text" id="contactSearch" placeholder="Buscar por nombre, apellido, teléfono, email, propiedad, emprendimiento o etapa...">
    </div>
    <div id="contactRows">
      ${rows}
    </div>
    <div id="contactEmpty" class="empty" style="display:none;">No hay contactos que coincidan con la búsqueda.</div>
    <script>
      (function () {
        var input = document.getElementById('contactSearch');
        var empty = document.getElementById('contactEmpty');
        var cards = document.querySelectorAll('#contactRows .contact-row');
        input.addEventListener('input', function () {
          var q = input.value.trim().toLowerCase();
          var visible = 0;
          cards.forEach(function (card) {
            var match = !q || card.getAttribute('data-search').indexOf(q) !== -1;
            card.style.display = match ? '' : 'none';
            if (match) visible++;
          });
          empty.style.display = visible === 0 ? '' : 'none';
        });
      })();
    </script>
    <style>
      .contact-row-main { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .contact-row-name { font-weight: 600; }
      .contact-row-badges { display: flex; gap: 6px; flex-wrap: wrap; }
      .badge { display: inline-block; font-size: 0.72rem; font-weight: 600; padding: 2px 9px; border-radius: 999px; }
      .tier-badge { background: #fdf0d8; color: #93650c; }
      .stage-badge { background: var(--brand-soft, #efedfe); color: var(--brand-dark, #5646e0); }
      .search-field { margin-bottom: 16px; }
      .search-field input {
        width: 100%; padding: 11px 14px; font-size: 0.92rem; font-family: inherit;
        border: 1.5px solid var(--border); border-radius: 10px; background: #fff; color: var(--text);
      }
      .search-field input:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px rgba(109,94,248,0.15); }
    </style>
  `;
  return pageShell("Contactos", body, "/admin");
}

function fichaRow(icon: string, value: string): string {
  return `<div class="ficha-row"><span class="ficha-icon">${icon}</span><span>${value}</span></div>`;
}

/**
 * Ficha de un contacto — pensada al estilo de la ficha de contacto de
 * Tokko (avatar, nombre, mail, teléfono, estado como badge), más los datos
 * propios que Tokko no tiene: tier, actividad, y por qué preguntó. El link
 * de abajo lleva a la conversación completa (misma vista que "Ver
 * conversaciones").
 */
export function renderContactDetail(phone: string): string {
  const entries = getEntriesForPhone(phone);
  if (entries.length === 0) {
    return pageShell("Contacto", '<div class="empty">No hay datos para este número.</div>');
  }
  const name = entries[entries.length - 1].name;
  const stage: StageLogEntry | undefined = getLatestStageByPhone().get(phone);
  const tier: TierLogEntry | undefined = getLatestTierByPhone().get(phone);
  const email = findEmail(entries);
  const interests = [...(valuesByPhone("development").get(phone) ?? []), ...(valuesByPhone("location").get(phone) ?? [])];

  const body = `
    <div class="ficha-card">
      <div class="ficha-avatar">${esc(initials(name))}</div>
      <div class="ficha-name">${esc(name)}</div>
      <div class="ficha-badges">
        ${tier ? `<span class="badge tier-badge">${esc(tier.tierLabel)}</span>` : `<span class="meta">Sin tier anotado</span>`}
        ${stage ? `<span class="badge stage-badge">${esc(stage.stageLabel)}</span>` : `<span class="meta">Sin etapa anotada</span>`}
      </div>
      <div class="ficha-contact-rows">
        ${fichaRow("✉️", email ? esc(email) : '<span class="meta">Sin datos</span>')}
        ${fichaRow("📞", esc(phone))}
        ${fichaRow("💬", esc(phone))}
      </div>
    </div>

    <div class="ficha-section">
      <div class="ficha-section-title">Actividad</div>
      <div>${esc(summarizeActivity(entries))}</div>
    </div>

    <div class="ficha-section">
      <div class="ficha-section-title">Preguntó por</div>
      <div>${interests.length > 0 ? esc(interests.join(", ")) : '<span class="meta">Sin datos</span>'}</div>
    </div>

    ${
      tier?.reasoning
        ? `<div class="ficha-section">
      <div class="ficha-section-title">Motivo del tier</div>
      <div>${esc(tier.reasoning)}</div>
    </div>`
        : ""
    }

    ${
      stage?.reason
        ? `<div class="ficha-section">
      <div class="ficha-section-title">Motivo de la etapa</div>
      <div>${esc(stage.reason)}</div>
    </div>`
        : ""
    }

    <a class="ficha-link" href="/admin/conversations/${encodeURIComponent(phone)}">Ver conversación completa →</a>

    <style>
      .ficha-card {
        background: var(--card); border: 1px solid var(--border); border-radius: 16px;
        padding: 28px 24px; text-align: center; box-shadow: 0 1px 2px rgba(23,21,60,0.05); margin-bottom: 18px;
      }
      .ficha-avatar {
        width: 72px; height: 72px; border-radius: 50%; background: var(--brand-soft, #efedfe);
        color: var(--brand-dark, #5646e0); display: flex; align-items: center; justify-content: center;
        font-size: 1.4rem; font-weight: 700; margin: 0 auto 14px;
      }
      .ficha-name { font-size: 1.15rem; font-weight: 700; margin-bottom: 10px; }
      .ficha-badges { display: flex; justify-content: center; gap: 8px; flex-wrap: wrap; margin-bottom: 18px; }
      .ficha-contact-rows {
        display: inline-flex; flex-direction: column; gap: 8px; text-align: left;
        border-top: 1px solid var(--border); padding-top: 16px; margin: 0 auto;
      }
      .ficha-row { display: flex; align-items: center; gap: 10px; font-size: 0.92rem; }
      .ficha-icon { width: 20px; text-align: center; }
      .ficha-section {
        background: var(--card); border: 1px solid var(--border); border-radius: 14px;
        padding: 14px 18px; margin-bottom: 10px; box-shadow: 0 1px 2px rgba(23,21,60,0.05);
      }
      .ficha-section-title { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-muted); font-weight: 600; margin-bottom: 4px; }
      .ficha-link { display: inline-block; margin-top: 8px; color: var(--brand); text-decoration: none; font-weight: 600; font-size: 0.9rem; }
      .ficha-link:hover { text-decoration: underline; }
      .badge { display: inline-block; font-size: 0.75rem; font-weight: 600; padding: 3px 11px; border-radius: 999px; }
      .tier-badge { background: #fdf0d8; color: #93650c; }
      .stage-badge { background: var(--brand-soft, #efedfe); color: var(--brand-dark, #5646e0); }
    </style>
  `;
  return pageShell(name, body);
}
