import { Router, type Request, type Response } from "express";
import {
  getSettings,
  saveSettings,
  type AppSettings,
  type TokkoStage,
  type CommunicationStyleOverride,
} from "../settings.js";
import { initiateConversation } from "../agent/orchestrator.js";
import { renderConversationsList, renderConversationDetail, renderDailySummaryView } from "./conversationsView.js";
import { renderMetricsView } from "./metricsView.js";
import { requireAdminAuth, checkPassword, setSessionCookie, clearSessionCookie, getSessionUsername } from "./auth.js";
import { pageShell as layoutPageShell } from "./layout.js";
import { logger } from "../logger.js";

export const adminRouter = Router();

// Una fila vacía de más como respaldo si el navegador tuviera JS
// deshabilitado — normalmente se agregan filas con el botón "+ Agregar"
// (ver scripts al final de renderPage), sin límite de cantidad.
const EXTRA_BLANK_STAGE_ROWS = 1;
const EXTRA_BLANK_STYLE_OVERRIDE_ROWS = 1;

adminRouter.use("/admin", requireAdminAuth);

adminRouter.get("/admin/login", (req: Request, res: Response) => {
  const error = req.query.error === "1";
  const next = typeof req.query.next === "string" ? req.query.next : "/admin";
  res.type("html").send(renderLoginPage({ error, next }));
});

adminRouter.post("/admin/login", (req: Request, res: Response) => {
  const body = req.body as Record<string, string>;
  const username = (body.username ?? "").trim();
  const password = body.password ?? "";
  const next = body.next && body.next.startsWith("/admin") ? body.next : "/admin";
  if (!checkPassword(password)) {
    res.redirect(`/admin/login?error=1&next=${encodeURIComponent(next)}`);
    return;
  }
  setSessionCookie(res, username);
  res.redirect(next);
});

adminRouter.post("/admin/logout", (_req: Request, res: Response) => {
  clearSessionCookie(res);
  res.redirect("/admin/login");
});

adminRouter.get("/admin", (req: Request, res: Response) => {
  res.type("html").send(renderLandingPage(getSessionUsername(req) ?? "admin"));
});

adminRouter.get("/admin/metrics", (req: Request, res: Response) => {
  // Los checkboxes del selector de dimensiones mandan "dims" repetido
  // (?dims=a&dims=b) — express lo parsea como array salvo que sea uno
  // solo, ahí queda como string. "submitted" distingue la primera visita
  // (sin selección todavía -> mostrar todo) de haber desmarcado todo a
  // propósito y enviado el formulario (-> no mostrar nada).
  const validDims = new Set(["channel", "development", "typology"]);
  const raw = req.query.dims;
  const rawList = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
  const dims = rawList.filter(
    (d): d is "channel" | "development" | "typology" => typeof d === "string" && validDims.has(d),
  );
  const wasSubmitted = req.query.submitted === "1";
  res.type("html").send(renderMetricsView(wasSubmitted ? dims : undefined));
});

adminRouter.get("/admin/config", (req: Request, res: Response) => {
  const saved = req.query.saved === "1";
  const started = req.query.started === "1";
  const startError = typeof req.query.startError === "string" ? req.query.startError : undefined;
  res.type("html").send(renderPage(getSettings(), { saved, started, startError }));
});

adminRouter.get("/admin/conversations", (_req: Request, res: Response) => {
  res.type("html").send(renderConversationsList());
});

adminRouter.get("/admin/conversations/:phone", (req: Request, res: Response) => {
  renderConversationDetail(req.params.phone)
    .then((html) => res.type("html").send(html))
    .catch((error) => {
      logger.error("admin.conversation_detail_failed", { error: String(error) });
      res.status(500).send("Error armando la conversación.");
    });
});

adminRouter.get("/admin/daily-summary", (_req: Request, res: Response) => {
  renderDailySummaryView()
    .then((html) => res.type("html").send(html))
    .catch((error) => {
      logger.error("admin.daily_summary_view_route_failed", { error: String(error) });
      res.status(500).send("Error armando el resumen.");
    });
});

// req.body.stageKey/stageLabel/stageId pueden venir como string (si hay una
// sola fila) o array (si hay varias) — el parser de express con
// extended:false colecciona los campos repetidos así.
function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string") return [value];
  return [];
}

adminRouter.post("/admin/config", (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;

  const escalationNumbers = toArray(body.escalationNumber)
    .map((n) => n.trim())
    .filter(Boolean);

  const toNumberOrUndefined = (v: string | undefined): number | undefined => {
    if (!v || v.trim() === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const stageKeys = toArray(body.stageKey);
  const stageLabels = toArray(body.stageLabel);
  const stageIds = toArray(body.stageId);
  const stages: TokkoStage[] = stageKeys
    .map((key, i) => ({
      key: key.trim(),
      label: (stageLabels[i] ?? "").trim(),
      tokkoId: toNumberOrUndefined(stageIds[i]),
    }))
    .filter((s) => s.key !== "");

  const overrideMatches = toArray(body.styleOverrideMatch);
  const overrideStyles = toArray(body.styleOverrideStyle);
  const overrides: CommunicationStyleOverride[] = overrideMatches
    .map((match, i) => ({ match: match.trim(), style: (overrideStyles[i] ?? "").trim() }))
    .filter((o) => o.match !== "" && o.style !== "");

  const settings: AppSettings = {
    escalationNumbers,
    zonapropLinksFileName: String(body.zonapropLinksFileName ?? "").trim() || "Links Zonaprop",
    driveFolderId: String(body.driveFolderId ?? "").trim() || undefined,
    tokko: {
      operationIdSale: toNumberOrUndefined(body.operationIdSale as string | undefined),
      operationIdRent: toNumberOrUndefined(body.operationIdRent as string | undefined),
      stages,
    },
    communicationStyle: {
      general: String(body.styleGeneral ?? "").trim(),
      overrides,
    },
    initiateConversationTemplateSid: String(body.initiateTemplateSid ?? "").trim() || undefined,
    initiateConversationTemplateText: String(body.initiateTemplateText ?? "").trim() || undefined,
    dailySummaryHour: toNumberOrUndefined(body.dailySummaryHour as string | undefined) ?? 20,
  };

  saveSettings(settings);
  logger.info("admin.settings_updated");
  res.redirect("/admin/config?saved=1");
});

adminRouter.post("/admin/start-conversation", (req: Request, res: Response) => {
  const body = req.body as Record<string, string>;
  const phone = (body.startPhone ?? "").trim();
  const customerName = (body.startName ?? "").trim();
  const reason = (body.startReason ?? "").trim();

  if (!phone || !customerName || !reason) {
    res.redirect("/admin/config?startError=" + encodeURIComponent("Completá número, nombre y motivo."));
    return;
  }

  initiateConversation({ phone, customerName, reason })
    .then((result) => {
      if (result.ok) {
        res.redirect("/admin/config?started=1");
      } else {
        res.redirect("/admin/config?startError=" + encodeURIComponent(result.error ?? "Error desconocido."));
      }
    })
    .catch((error) => {
      logger.error("admin.start_conversation_failed", { error: String(error) });
      res.redirect("/admin/config?startError=" + encodeURIComponent(String(error)));
    });
});

function esc(value: string | number | undefined): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => {
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

function renderStageRow(stage: Partial<TokkoStage>): string {
  return `
              <div class="stage-row">
                <input type="text" name="stageKey" value="${esc(stage.key)}" placeholder="clave_interna">
                <input type="text" name="stageLabel" value="${esc(stage.label)}" placeholder="Nombre visible">
                <input type="number" name="stageId" value="${esc(stage.tokkoId)}" placeholder="ID Tokko">
              </div>`;
}

function renderNumberRow(value: string): string {
  return `
            <div class="number-row">
              <input type="text" name="escalationNumber" value="${esc(value)}" placeholder="+5491122334455">
            </div>`;
}

function renderStyleOverrideRow(o: Partial<CommunicationStyleOverride>): string {
  return `
              <div class="override-row">
                <input type="text" name="styleOverrideMatch" value="${esc(o.match)}" placeholder="Nombre de propiedad/emprendimiento">
                <input type="text" name="styleOverrideStyle" value="${esc(o.style)}" placeholder="Instrucciones de tono">
              </div>`;
}

const NARROW_PAGE_STYLE = `
  <style>
    .narrow { max-width: 460px; margin: 40px auto 0; display: flex; flex-direction: column; gap: 16px; }
    .hello { font-size: 0.9rem; color: #75758c; text-align: center; margin-bottom: 2px; }
    .tile-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .tile { display: flex; flex-direction: column; justify-content: space-between; min-height: 160px; background: #fff; border: 1px solid #eaeaf3; border-radius: 24px; padding: 22px; text-decoration: none; color: #16162a; box-shadow: 0 1px 2px rgba(23,21,60,0.05); transition: box-shadow .15s ease, transform .1s ease; }
    .tile:hover { box-shadow: 0 6px 18px rgba(23,21,60,0.1); transform: translateY(-1px); }
    .tile-icon { width: 52px; height: 52px; border-radius: 15px; background: #efedfe; display: flex; align-items: center; justify-content: center; font-size: 1.6rem; }
    .tile-title { display: block; font-weight: 700; font-size: 1.05rem; margin-top: 16px; line-height: 1.25; }
    .tile-sub { display: block; font-size: 0.8rem; color: #75758c; margin-top: 4px; line-height: 1.35; }
    .logout-btn { width: 100%; padding: 8px 16px; font-size: 0.82rem; background: none; color: #75758c; border: 1px solid #eaeaf3; border-radius: 8px; cursor: pointer; margin-top: 4px; }
    .narrow-card { background: #fff; border: 1px solid #eaeaf3; border-radius: 14px; padding: 22px 20px; box-shadow: 0 1px 2px rgba(23,21,60,0.05); }
    .narrow-field label { display: block; font-size: 0.82rem; font-weight: 600; margin-bottom: 5px; }
    .narrow-field input { width: 100%; padding: 9px 11px; border: 1.5px solid #eaeaf3; border-radius: 10px; font-size: 0.92rem; font-family: inherit; }
    .narrow-field input:focus { outline: none; border-color: #6d5ef8; box-shadow: 0 0 0 3px #efedfe; }
    .narrow-form { display: flex; flex-direction: column; gap: 12px; }
    .narrow-submit { padding: 10px 18px; background: linear-gradient(120deg,#6d5ef8,#5646e0); color: white; border: none; border-radius: 10px; cursor: pointer; font-weight: 600; font-size: 0.92rem; }
  </style>
`;

function renderLandingPage(username: string): string {
  const body = `
    <div class="narrow">
      <div class="hello">Hola, ${esc(username)}</div>
      <div class="tile-grid">
        <a class="tile" href="/admin/metrics">
          <span class="tile-icon">📊</span>
          <span>
            <span class="tile-title">Métricas</span>
            <span class="tile-sub">Consultas, canales de origen</span>
          </span>
        </a>
        <a class="tile" href="/admin/config">
          <span class="tile-icon">⚙️</span>
          <span>
            <span class="tile-title">Configuración</span>
            <span class="tile-sub">Números, Drive, Tokko, estilo</span>
          </span>
        </a>
        <a class="tile" href="/admin/conversations">
          <span class="tile-icon">💬</span>
          <span>
            <span class="tile-title">Ver conversaciones</span>
            <span class="tile-sub">Historial y diagrama por cliente</span>
          </span>
        </a>
        <a class="tile" href="/admin/daily-summary">
          <span class="tile-icon">📋</span>
          <span>
            <span class="tile-title">Resumen de hoy</span>
            <span class="tile-sub">Actividad del día hasta ahora</span>
          </span>
        </a>
      </div>
      <form method="POST" action="/admin/logout">
        <button type="submit" class="logout-btn">Cerrar sesión</button>
      </form>
    </div>
    ${NARROW_PAGE_STYLE}
  `;
  return layoutPageShell("Agente WhatsApp", body, "/admin");
}

function renderLoginPage(opts: { error: boolean; next: string }): string {
  const body = `
    <div class="narrow">
      <div class="narrow-card">
        <form method="POST" action="/admin/login" class="narrow-form">
          <input type="hidden" name="next" value="${esc(opts.next)}">
          <div class="narrow-field">
            <label for="username">Usuario</label>
            <input type="text" id="username" name="username" autofocus placeholder="tu nombre">
          </div>
          <div class="narrow-field">
            <label for="password">Contraseña</label>
            <input type="password" id="password" name="password">
          </div>
          ${opts.error ? '<div style="color:#a31c1c;font-size:0.85rem;">Contraseña incorrecta.</div>' : ""}
          <button type="submit" class="narrow-submit">Entrar</button>
        </form>
      </div>
    </div>
    ${NARROW_PAGE_STYLE}
  `;
  return layoutPageShell("Agente WhatsApp — Ingresar", body, "/admin/login");
}

interface PageNotices {
  saved: boolean;
  started: boolean;
  startError?: string;
}

function renderPage(settings: AppSettings, notices: PageNotices): string {
  const { saved, started, startError } = notices;
  const stageRows = [
    ...settings.tokko.stages.map(renderStageRow),
    ...Array.from({ length: EXTRA_BLANK_STAGE_ROWS }, () => renderStageRow({})),
  ].join("\n");

  const numberRows = [
    ...settings.escalationNumbers.map(renderNumberRow),
    renderNumberRow(""),
  ].join("\n");

  const overrideRows = [
    ...settings.communicationStyle.overrides.map(renderStyleOverrideRow),
    ...Array.from({ length: EXTRA_BLANK_STYLE_OVERRIDE_ROWS }, () => renderStyleOverrideRow({})),
  ].join("\n");

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agente WhatsApp — Configuración</title>
<style>
  :root {
    --brand: #6d5ef8;
    --brand-dark: #5646e0;
    --brand-soft: #efedfe;
    --accent: #22c3a6;
    --bg: #f4f5fb;
    --card: #ffffff;
    --border: #eaeaf3;
    --text: #16162a;
    --text-muted: #75758c;
    --shadow-sm: 0 1px 2px rgba(23, 21, 60, 0.05), 0 1px 3px rgba(23, 21, 60, 0.06);
    --shadow-md: 0 4px 14px rgba(23, 21, 60, 0.08);
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    margin: 0; background: var(--bg); color: var(--text); -webkit-font-smoothing: antialiased;
    min-height: 100vh; display: flex; flex-direction: column;
  }
  header, footer {
    background: linear-gradient(120deg, var(--brand) 0%, var(--brand-dark) 55%, #4433c9 100%);
    color: white; padding: 28px 24px 32px;
    display: flex; align-items: center; gap: 14px;
    box-shadow: 0 4px 20px rgba(86, 70, 224, 0.25);
  }
  header .logo {
    width: 42px; height: 42px; border-radius: 13px; background: rgba(255,255,255,0.16);
    border: 1px solid rgba(255,255,255,0.25);
    display: flex; align-items: center; justify-content: center; font-size: 1.4rem;
    box-shadow: inset 0 1px 1px rgba(255,255,255,0.2);
  }
  header h1 { font-size: 1.25rem; margin: 0; font-weight: 700; letter-spacing: -0.01em; }
  header p { margin: 3px 0 0; font-size: 0.85rem; opacity: 0.82; }
  main { flex: 1; max-width: 680px; margin: 28px auto 64px; padding: 0 16px; width: 100%; }
  .banner {
    background: #e9fbf4; border: 1px solid #9be8ce; color: #0d7a5a;
    padding: 11px 16px; border-radius: 10px; margin-bottom: 20px; font-size: 0.9rem;
    box-shadow: var(--shadow-sm); font-weight: 500;
  }
  .banner-error { background: #fdecec; border-color: #f3a9a9; color: #a31c1c; }
  form { display: flex; flex-direction: column; gap: 18px; }
  details.section {
    background: var(--card); border: 1px solid var(--border); border-radius: 16px;
    overflow: hidden; box-shadow: var(--shadow-sm);
    transition: box-shadow 0.2s ease;
  }
  details.section[open] { box-shadow: var(--shadow-md); }
  details.section[open] summary { border-bottom: 1px solid var(--border); }
  details.section summary {
    list-style: none; cursor: pointer; padding: 18px 22px;
    display: flex; align-items: center; gap: 12px;
    font-weight: 600; font-size: 1rem; user-select: none;
    transition: background 0.15s ease;
  }
  details.section summary:hover { background: #fafafe; }
  details.section summary::-webkit-details-marker { display: none; }
  details.section summary .icon {
    font-size: 1.05rem; width: 34px; height: 34px; border-radius: 10px;
    background: var(--brand-soft); display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  details.section summary .chevron {
    margin-left: auto; color: var(--text-muted); font-size: 1.1rem;
    transition: transform 0.2s ease; transform: rotate(0deg);
  }
  details.section[open] summary .chevron { transform: rotate(90deg); color: var(--brand); }
  details.section summary .subtitle { font-weight: 400; font-size: 0.82rem; color: var(--text-muted); }
  .section-body { padding: 6px 22px 24px; display: flex; flex-direction: column; gap: 16px; }
  .field label { display: block; font-size: 0.85rem; margin-bottom: 6px; color: var(--text); font-weight: 600; }
  input[type=text], input[type=number], textarea {
    width: 100%; padding: 10px 12px; font-size: 0.95rem;
    border: 1.5px solid var(--border); border-radius: 10px; font-family: inherit;
    background: #fbfbfd; color: var(--text); transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  input::placeholder, textarea::placeholder { color: #b3b3c6; }
  input:focus, textarea:focus {
    outline: none; border-color: var(--brand); background: #fff;
    box-shadow: 0 0 0 3.5px var(--brand-soft);
  }
  textarea { min-height: 76px; resize: vertical; }
  .hint { font-size: 0.8rem; color: var(--text-muted); margin-top: 6px; line-height: 1.5; }
  .stages { display: grid; grid-template-columns: 1fr 1fr; gap: 16px 16px; }
  @media (max-width: 480px) { .stages { grid-template-columns: 1fr; } }
  .number-rows { display: flex; flex-direction: column; gap: 9px; margin-bottom: 4px; }
  .override-rows { display: flex; flex-direction: column; gap: 9px; margin-bottom: 4px; }
  .override-row { display: grid; grid-template-columns: 1fr 1.6fr; gap: 8px; }
  @media (max-width: 480px) { .override-row { grid-template-columns: 1fr; } }
  .stage-rows { display: flex; flex-direction: column; gap: 9px; }
  .stage-row-header {
    display: grid; grid-template-columns: 1fr 1.4fr 90px; gap: 8px;
    font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--text-muted); padding: 0 2px; font-weight: 600;
  }
  .stage-row { display: grid; grid-template-columns: 1fr 1.4fr 90px; gap: 8px; }
  @media (max-width: 480px) { .stage-row, .stage-row-header { grid-template-columns: 1fr; } }
  .actions { position: sticky; bottom: 16px; padding-top: 4px; }
  button {
    padding: 13px 22px; font-size: 0.95rem; font-weight: 600;
    background: linear-gradient(120deg, var(--brand), var(--brand-dark));
    color: white; border: none; border-radius: 12px; cursor: pointer; width: 100%;
    box-shadow: var(--shadow-md); transition: transform 0.12s ease, box-shadow 0.12s ease;
  }
  button:hover { box-shadow: 0 6px 20px rgba(86, 70, 224, 0.32); transform: translateY(-1px); }
  button:active { transform: translateY(0); }
  .add-row-btn {
    width: auto; padding: 8px 16px; font-size: 0.84rem; font-weight: 600;
    background: var(--brand-soft); color: var(--brand-dark); border: none;
    box-shadow: none; margin-top: 2px; align-self: flex-start; border-radius: 999px;
  }
  .add-row-btn:hover { background: #e1ddfd; box-shadow: none; transform: none; }
</style>
</head>
<body>
  <header>
    <a href="/admin" style="color:white;text-decoration:none;font-size:0.85rem;opacity:0.85;margin-right:2px;">← Panel</a>
    <div class="logo">🤖</div>
    <div style="flex:1">
      <h1>Agente WhatsApp</h1>
      <p>Configuración</p>
    </div>
  </header>
  <main>
    ${saved ? '<div class="banner">✓ Guardado correctamente.</div>' : ""}
    ${started ? '<div class="banner">✓ Conversación iniciada — se mandó el template por WhatsApp.</div>' : ""}
    ${startError ? `<div class="banner banner-error">✕ No se pudo iniciar la conversación: ${esc(startError)}</div>` : ""}
    <form method="POST" action="/admin/config">

      <details class="section" open>
        <summary><span class="icon">👥</span> Números de contacto<span class="chevron">›</span></summary>
        <div class="section-body">
          <div class="field">
            <label>Números de WhatsApp que reciben los escalamientos</label>
            <div class="number-rows" id="numberRows">
              ${numberRows}
            </div>
            <button type="button" class="add-row-btn" id="addNumberRowBtn">+ Agregar número</button>
            <div class="hint">No puede ser un grupo de WhatsApp (la API no lo permite) — cada fila es un número individual. Mientras estés en el sandbox de Twilio, cada uno tiene que sumarse mandándole "join &lt;palabra-clave&gt;" al número del sandbox.</div>
          </div>
        </div>
      </details>

      <details class="section">
        <summary><span class="icon">📁</span> Google Drive<span class="chevron">›</span></summary>
        <div class="section-body">
          <div class="field">
            <label for="driveFolderId">Carpeta donde buscar archivos (opcional)</label>
            <input type="text" id="driveFolderId" name="driveFolderId" value="${esc(settings.driveFolderId)}" placeholder="ID de la carpeta">
            <div class="hint">De la URL de Drive: drive.google.com/drive/folders/<b>ESTE_ID</b>. Busca también en subcarpetas. Si lo dejás vacío, busca en todo lo que la cuenta de servicio tenga compartido.</div>
          </div>
          <div class="field">
            <label for="zonapropLinksFileName">Nombre del archivo con los links de Zonaprop</label>
            <input type="text" id="zonapropLinksFileName" name="zonapropLinksFileName" value="${esc(settings.zonapropLinksFileName)}">
            <div class="hint">Un archivo de texto/Doc/Sheet en Drive con líneas "nombre,link" (uno por propiedad/emprendimiento).</div>
          </div>
        </div>
      </details>

      <details class="section">
        <summary><span class="icon">🏢</span> Tokko<span class="subtitle">operaciones y etapas</span><span class="chevron">›</span></summary>
        <div class="section-body">
          <div class="field">
            <label for="operationIdSale">ID de operación: Venta</label>
            <input type="number" id="operationIdSale" name="operationIdSale" value="${esc(settings.tokko.operationIdSale)}">
          </div>
          <div class="field">
            <label for="operationIdRent">ID de operación: Alquiler</label>
            <input type="number" id="operationIdRent" name="operationIdRent" value="${esc(settings.tokko.operationIdRent)}">
          </div>
          <div class="field">
            <label>Etapas del workflow de Oportunidades</label>
            <div class="hint">"Clave" es el identificador interno que usa el agente (sin espacios, ej. tomar_accion), "Nombre" es lo que ve el agente para entender qué significa, e "ID Tokko" es el número real de esa etapa en tu cuenta. Para sacar una etapa, borrale la Clave.</div>
            <div class="stage-rows" id="stageRows">
              <div class="stage-row-header"><span>Clave</span><span>Nombre</span><span>ID Tokko</span></div>
              ${stageRows}
            </div>
            <button type="button" class="add-row-btn" id="addStageRowBtn">+ Agregar etapa</button>
          </div>
        </div>
      </details>

      <details class="section">
        <summary><span class="icon">🎙️</span> Estilo del agente<span class="chevron">›</span></summary>
        <div class="section-body">
          <div class="field">
            <label for="styleGeneral">Instrucciones generales de tono y estilo (opcional)</label>
            <textarea id="styleGeneral" name="styleGeneral" placeholder="Ej: usá menos signos de exclamación, firmá como 'Equipo ismo', evitá emojis">${esc(settings.communicationStyle.general)}</textarea>
            <div class="hint">Se suma a las instrucciones base del agente (rioplatense, cordial, mensajes cortos) — no las reemplaza.</div>
          </div>
          <div class="field">
            <label>Tonos especiales por propiedad o emprendimiento</label>
            <div class="override-rows" id="overrideRows">
              ${overrideRows}
            </div>
            <button type="button" class="add-row-btn" id="addOverrideRowBtn">+ Agregar tono especial</button>
            <div class="hint">Es el agente quien decide cuándo aplica cada uno, según de qué habla la conversación — no hace falta que el nombre sea exacto. Para sacar uno, borrale el nombre de la propiedad/emprendimiento.</div>
          </div>
        </div>
      </details>

      <details class="section">
        <summary><span class="icon">🚀</span> Iniciar conversación<span class="chevron">›</span></summary>
        <div class="section-body">
          <div class="field">
            <label for="initiateTemplateSid">Content SID del template aprobado (HX...)</label>
            <input type="text" id="initiateTemplateSid" name="initiateTemplateSid" value="${esc(settings.initiateConversationTemplateSid)}" placeholder="HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx">
            <div class="hint">Lo conseguís en Twilio → Content Template Builder, una vez que Meta lo aprueba (ver docs/SETUP.md).</div>
          </div>
          <div class="field">
            <label for="initiateTemplateText">Texto del template (tal cual quedó aprobado)</label>
            <textarea id="initiateTemplateText" name="initiateTemplateText" placeholder="Hola {{1}}! Somos de ismo Propiedades...">${esc(settings.initiateConversationTemplateText)}</textarea>
            <div class="hint">Usá {{1}} para el nombre y {{2}} para el motivo, en ese orden — tiene que coincidir con lo que aprobaste en Twilio, si no el agente va a "recordar" algo distinto de lo que el cliente recibió.</div>
          </div>
        </div>
      </details>

      <details class="section">
        <summary><span class="icon">📋</span> Resumen diario<span class="chevron">›</span></summary>
        <div class="section-body">
          <div class="field">
            <label for="dailySummaryHour">Hora local (Argentina) en la que se manda</label>
            <input type="number" id="dailySummaryHour" name="dailySummaryHour" min="0" max="23" value="${esc(settings.dailySummaryHour)}">
            <div class="hint">Se manda por WhatsApp a los números de la sección "Números de contacto", con lo que pasó ese día. Si no hubo actividad, no manda nada.</div>
          </div>
        </div>
      </details>

      <details class="section" id="startConversationSection">
        <summary><span class="icon">💬</span> Contactar a un cliente ahora<span class="chevron">›</span></summary>
        <div class="section-body">
          <div class="field">
            <label for="startPhone">Número de WhatsApp del cliente</label>
            <input type="text" id="startPhone" name="startPhone" placeholder="+5491122334455">
          </div>
          <div class="field">
            <label for="startName">Nombre del cliente</label>
            <input type="text" id="startName" name="startName" placeholder="Juan">
          </div>
          <div class="field">
            <label for="startReason">¿Qué está buscando / motivo del contacto?</label>
            <input type="text" id="startReason" name="startReason" placeholder="un depto de 2 ambientes en Núñez">
          </div>
          <button type="submit" formaction="/admin/start-conversation" formmethod="post">Iniciar conversación</button>
          <div class="hint">Requiere tener cargado el Content SID en la sección "Iniciar conversación" de más arriba, y que el template ya esté aprobado por Meta.</div>
        </div>
      </details>

      <div class="actions">
        <button type="submit">Guardar cambios</button>
      </div>
    </form>
  </main>

  <footer></footer>

  <template id="stageRowTemplate">
    <div class="stage-row">
      <input type="text" name="stageKey" placeholder="clave_interna">
      <input type="text" name="stageLabel" placeholder="Nombre visible">
      <input type="number" name="stageId" placeholder="ID Tokko">
    </div>
  </template>
  <template id="numberRowTemplate">
    <div class="number-row">
      <input type="text" name="escalationNumber" placeholder="+5491122334455">
    </div>
  </template>
  <template id="overrideRowTemplate">
    <div class="override-row">
      <input type="text" name="styleOverrideMatch" placeholder="Nombre de propiedad/emprendimiento">
      <input type="text" name="styleOverrideStyle" placeholder="Instrucciones de tono">
    </div>
  </template>
  <script>
    document.getElementById('addStageRowBtn').addEventListener('click', function () {
      var tpl = document.getElementById('stageRowTemplate');
      var row = tpl.content.cloneNode(true);
      document.getElementById('stageRows').appendChild(row);
    });
    document.getElementById('addNumberRowBtn').addEventListener('click', function () {
      var tpl = document.getElementById('numberRowTemplate');
      var row = tpl.content.cloneNode(true);
      document.getElementById('numberRows').appendChild(row);
    });
    document.getElementById('addOverrideRowBtn').addEventListener('click', function () {
      var tpl = document.getElementById('overrideRowTemplate');
      var row = tpl.content.cloneNode(true);
      document.getElementById('overrideRows').appendChild(row);
    });
  </script>
</body>
</html>`;
}
