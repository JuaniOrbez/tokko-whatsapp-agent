import { listConversationOrigins } from "../agent/conversationLog.js";
import { firstValueByPhone } from "../agent/toolUsageLog.js";
import { esc, pageShell } from "./layout.js";

const ARGENTINA_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAYS_TO_SHOW = 14;

type DimKey = "channel" | "development" | "typology";
const DIM_LABELS: Record<DimKey, string> = {
  channel: "Canal de origen",
  development: "Emprendimiento",
  typology: "Tipología",
};
const ALL_DIMS: DimKey[] = ["channel", "development", "typology"];

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

function renderDimSection(title: string, valueByPhone: Map<string, string>): string {
  const counts = new Map<string, number>();
  for (const value of valueByPhone.values()) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, c]) => c));
  const bars = entries.map(([value, count]) => renderBar(value, count, max)).join("\n");
  return `
    <div class="card">
      <h2 style="margin-top:0;font-size:1rem;">${esc(title)}</h2>
      <div class="bars">${bars || '<div class="empty">Todavía no hay datos.</div>'}</div>
    </div>`;
}

function renderCrossTab(titleA: string, titleB: string, byA: Map<string, string>, byB: Map<string, string>): string {
  const counts = new Map<string, number>();
  for (const [phone, a] of byA) {
    const b = byB.get(phone);
    if (!b) continue;
    const key = `${a} · ${b}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
  const tableRows = rows
    .map(([key, count]) => {
      const [a, b] = key.split(" · ");
      return `<tr><td>${esc(a)}</td><td>${esc(b)}</td><td class="num">${count}</td></tr>`;
    })
    .join("\n");
  return `
    <div class="card">
      <h2 style="margin-top:0;font-size:1rem;">${esc(titleA)} + ${esc(titleB)}</h2>
      ${
        rows.length > 0
          ? `<table class="crosstab"><thead><tr><th>${esc(titleA)}</th><th>${esc(titleB)}</th><th class="num">Conversaciones</th></tr></thead><tbody>${tableRows}</tbody></table>`
          : '<div class="empty">Todavía no hay conversaciones con datos en ambas dimensiones.</div>'
      }
    </div>`;
}

function renderDimCheckboxes(selected: Set<DimKey>): string {
  const boxes = ALL_DIMS.map((dim) => {
    const checked = selected.has(dim) ? "checked" : "";
    return `
      <label class="dim-check">
        <input type="checkbox" name="dims" value="${dim}" ${checked}>
        ${esc(DIM_LABELS[dim])}
      </label>`;
  }).join("\n");
  return `
    <form method="GET" action="/admin/metrics" class="dim-picker">
      <input type="hidden" name="submitted" value="1">
      <div class="dim-picker-label">Ver por:</div>
      ${boxes}
      <button type="submit">Ver</button>
    </form>`;
}

export function renderMetricsView(selectedDims?: DimKey[]): string {
  // undefined = primera visita, sin selección todavía -> mostrar todo.
  // [] = el usuario desmarcó todo a propósito y envió el formulario.
  const selected = new Set<DimKey>(selectedDims ?? ALL_DIMS);

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

  const valueByPhone: Record<DimKey, Map<string, string>> = {
    channel: new Map(origins.map((o) => [o.phone, o.channel])),
    development: firstValueByPhone("development"),
    typology: firstValueByPhone("typology"),
  };

  const selectedList = [...selected];
  const dimSections = selectedList.map((dim) => renderDimSection(DIM_LABELS[dim], valueByPhone[dim])).join("\n");

  // Con exactamente dos dimensiones elegidas, además de cada una por separado
  // se arma el cruce entre ellas — no tiene mucho sentido con una sola ni
  // con las tres (quedaría una tabla enorme y poco legible).
  const crossTab =
    selectedList.length === 2
      ? renderCrossTab(
          DIM_LABELS[selectedList[0]],
          DIM_LABELS[selectedList[1]],
          valueByPhone[selectedList[0]],
          valueByPhone[selectedList[1]],
        )
      : "";

  const body = `
    <div class="card">
      <h2 style="margin-top:0;font-size:1rem;">Consultas nuevas por día (últimos ${DAYS_TO_SHOW} días)</h2>
      <div class="bars">${dayBars || '<div class="empty">Todavía no hay datos.</div>'}</div>
    </div>

    ${renderDimCheckboxes(selected)}

    ${dimSections}
    ${crossTab}

    <div class="card">
      <div class="meta">
        Canal: IG/FB se detecta automático (datos de referral del anuncio); Zonaprop se infiere
        del texto del primer mensaje — puede necesitar ajuste con casos reales. Emprendimiento y
        tipología se completan cuando el cliente pregunta por un proyecto puntual o una cantidad
        de ambientes — no todas las conversaciones van a tener esos datos.
      </div>
    </div>

    <style>
      .bars { display: flex; flex-direction: column; gap: 8px; }
      .bar-row { display: grid; grid-template-columns: 110px 1fr 32px; align-items: center; gap: 10px; font-size: 0.85rem; }
      .bar-track { background: #efedfe; border-radius: 999px; height: 10px; overflow: hidden; }
      .bar-fill { background: linear-gradient(120deg, #6d5ef8, #5646e0); height: 100%; border-radius: 999px; }
      .bar-count { text-align: right; color: #75758c; font-variant-numeric: tabular-nums; }
      .dim-picker { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; background: #fff; border: 1px solid #eaeaf3; border-radius: 14px; padding: 14px 18px; margin-bottom: 12px; }
      .dim-picker-label { font-size: 0.85rem; font-weight: 600; color: #75758c; }
      .dim-check { display: flex; align-items: center; gap: 6px; font-size: 0.88rem; cursor: pointer; }
      .dim-picker button { margin-left: auto; padding: 8px 18px; font-size: 0.85rem; font-weight: 600; background: linear-gradient(120deg,#6d5ef8,#5646e0); color: white; border: none; border-radius: 8px; cursor: pointer; }
      .crosstab { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
      .crosstab th, .crosstab td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #eaeaf3; }
      .crosstab .num { text-align: right; font-variant-numeric: tabular-nums; color: #75758c; }
    </style>
  `;
  return pageShell("Métricas", body, "/admin");
}
