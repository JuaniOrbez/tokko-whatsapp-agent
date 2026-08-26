import { listConversationOrigins } from "../agent/conversationLog.js";
import { esc, pageShell } from "./layout.js";

const ARGENTINA_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAYS_TO_SHOW = 14;

function argentinaDayKey(ts: number): string {
  const d = new Date(ts - ARGENTINA_UTC_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function argentinaDayLabel(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" });
}

function renderBar(label: string, count: number, max: number): string {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  return `
    <div class="bar-row">
      <div class="bar-label">${esc(label)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      <div class="bar-count">${count}</div>
    </div>`;
}

export function renderMetricsView(): string {
  const origins = listConversationOrigins();

  const today = argentinaDayKey(Date.now());
  const dayKeys: string[] = [];
  for (let i = DAYS_TO_SHOW - 1; i >= 0; i--) {
    dayKeys.push(argentinaDayKey(Date.now() - i * 24 * 60 * 60 * 1000));
  }
  const countsByDay = new Map<string, number>(dayKeys.map((k) => [k, 0]));
  for (const o of origins) {
    const key = argentinaDayKey(o.firstTs);
    if (countsByDay.has(key)) countsByDay.set(key, (countsByDay.get(key) ?? 0) + 1);
  }
  const maxPerDay = Math.max(1, ...countsByDay.values());
  const dayBars = dayKeys
    .map((key) => renderBar(key === today ? "Hoy" : argentinaDayLabel(key), countsByDay.get(key) ?? 0, maxPerDay))
    .join("\n");

  const countsByChannel = new Map<string, number>();
  for (const o of origins) {
    countsByChannel.set(o.channel, (countsByChannel.get(o.channel) ?? 0) + 1);
  }
  const channelEntries = [...countsByChannel.entries()].sort((a, b) => b[1] - a[1]);
  const maxPerChannel = Math.max(1, ...channelEntries.map(([, c]) => c));
  const channelBars = channelEntries.map(([channel, count]) => renderBar(channel, count, maxPerChannel)).join("\n");

  const body = `
    <div class="card">
      <h2 style="margin-top:0;font-size:1rem;">Consultas nuevas por día (últimos ${DAYS_TO_SHOW} días)</h2>
      <div class="bars">${dayBars || '<div class="empty">Todavía no hay datos.</div>'}</div>
    </div>
    <div class="card">
      <h2 style="margin-top:0;font-size:1rem;">Canal de origen</h2>
      <div class="bars">${channelBars || '<div class="empty">Todavía no hay datos.</div>'}</div>
      <div class="meta" style="margin-top:10px;">
        IG/FB se detecta automático (datos de referral del anuncio). Zonaprop se infiere del texto
        del primer mensaje — puede necesitar ajuste una vez que se vean casos reales. Las
        conversaciones que arrancaron antes de esta función quedan como "Sin datos".
      </div>
    </div>
    <div class="card">
      <h2 style="margin-top:0;font-size:1rem;">Próximamente</h2>
      <div class="meta">Desglose por tipología y por emprendimiento consultado — todavía no se está registrando esa información por conversación.</div>
    </div>
    <style>
      .bars { display: flex; flex-direction: column; gap: 8px; }
      .bar-row { display: grid; grid-template-columns: 70px 1fr 32px; align-items: center; gap: 10px; font-size: 0.85rem; }
      .bar-track { background: #efedfe; border-radius: 999px; height: 10px; overflow: hidden; }
      .bar-fill { background: linear-gradient(120deg, #6d5ef8, #5646e0); height: 100%; border-radius: 999px; }
      .bar-count { text-align: right; color: #75758c; font-variant-numeric: tabular-nums; }
    </style>
  `;
  return pageShell("Métricas", body, "/admin");
}
