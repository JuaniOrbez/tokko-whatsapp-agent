import { Router, type Request, type Response, type NextFunction } from "express";
import { config } from "../config.js";
import { getSettings, saveSettings, type AppSettings, type TokkoStage } from "../settings.js";
import { logger } from "../logger.js";

export const adminRouter = Router();

// Una fila vacía de más como respaldo si el navegador tuviera JS
// deshabilitado — normalmente se agregan filas con el botón "+ Agregar
// etapa" (ver script al final de renderPage), sin límite de cantidad.
const EXTRA_BLANK_STAGE_ROWS = 1;

function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.ADMIN_PASSWORD) {
    res
      .status(503)
      .send("Panel de administración no configurado — falta ADMIN_PASSWORD en el .env del servidor.");
    return;
  }

  const header = req.header("authorization") ?? "";
  const expected =
    "Basic " + Buffer.from(`admin:${config.ADMIN_PASSWORD}`).toString("base64");
  if (header !== expected) {
    res.set("WWW-Authenticate", 'Basic realm="Panel de administración"');
    res.status(401).send("Autenticación requerida.");
    return;
  }
  next();
}

adminRouter.use("/admin", requireAdminAuth);

adminRouter.get("/admin", (req: Request, res: Response) => {
  const saved = req.query.saved === "1";
  res.type("html").send(renderPage(getSettings(), saved));
});

// req.body.stageKey/stageLabel/stageId pueden venir como string (si hay una
// sola fila) o array (si hay varias) — el parser de express con
// extended:false colecciona los campos repetidos así.
function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string") return [value];
  return [];
}

adminRouter.post("/admin", (req: Request, res: Response) => {
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

  const settings: AppSettings = {
    escalationNumbers,
    zonapropLinksFileName: String(body.zonapropLinksFileName ?? "").trim() || "Links Zonaprop",
    driveFolderId: String(body.driveFolderId ?? "").trim() || undefined,
    tokko: {
      operationIdSale: toNumberOrUndefined(body.operationIdSale as string | undefined),
      operationIdRent: toNumberOrUndefined(body.operationIdRent as string | undefined),
      stages,
    },
  };

  saveSettings(settings);
  logger.info("admin.settings_updated");
  res.redirect("/admin?saved=1");
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

function renderPage(settings: AppSettings, saved: boolean): string {
  const stageRows = [
    ...settings.tokko.stages.map(renderStageRow),
    ...Array.from({ length: EXTRA_BLANK_STAGE_ROWS }, () => renderStageRow({})),
  ].join("\n");

  const numberRows = [
    ...settings.escalationNumbers.map(renderNumberRow),
    renderNumberRow(""),
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
  }
  header {
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
  main { max-width: 680px; margin: 28px auto 64px; padding: 0 16px; }
  .banner {
    background: #e9fbf4; border: 1px solid #9be8ce; color: #0d7a5a;
    padding: 11px 16px; border-radius: 10px; margin-bottom: 20px; font-size: 0.9rem;
    box-shadow: var(--shadow-sm); font-weight: 500;
  }
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
    <div class="logo">🤖</div>
    <div>
      <h1>Agente WhatsApp</h1>
      <p>Panel de configuración</p>
    </div>
  </header>
  <main>
    ${saved ? '<div class="banner">✓ Guardado correctamente.</div>' : ""}
    <form method="POST" action="/admin">

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

      <div class="actions">
        <button type="submit">Guardar cambios</button>
      </div>
    </form>
  </main>

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
  </script>
</body>
</html>`;
}
