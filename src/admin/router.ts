import { Router, type Request, type Response, type NextFunction } from "express";
import { config } from "../config.js";
import { getSettings, saveSettings, type AppSettings } from "../settings.js";
import { logger } from "../logger.js";
import type { OpportunityStageKey } from "../config.js";

export const adminRouter = Router();

const STAGE_LABELS: Record<OpportunityStageKey, string> = {
  aun_no_contactados: "Aún no fueron contactados",
  sin_seguimiento: "Sin seguimiento",
  contactar: "Contactar",
  primer_contacto: "Primer contacto hecho",
  volver_a_contactar: "Volver a contactar",
  evolucionando: "Evolucionando",
  tomar_accion: "Tomar acción (default de contactos nuevos)",
  congelado: "Congelado",
  cerrado: "Cerrado",
};

const STAGE_KEYS = Object.keys(STAGE_LABELS) as OpportunityStageKey[];

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

adminRouter.post("/admin", (req: Request, res: Response) => {
  const body = req.body as Record<string, string>;

  const escalationNumbers = (body.escalationNumbers ?? "")
    .split("\n")
    .map((n) => n.trim())
    .filter(Boolean);

  const toNumberOrUndefined = (v: string | undefined): number | undefined => {
    if (!v || v.trim() === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const stages = {} as Record<OpportunityStageKey, number | undefined>;
  for (const key of STAGE_KEYS) {
    stages[key] = toNumberOrUndefined(body[`stage_${key}`]);
  }

  const settings: AppSettings = {
    escalationNumbers,
    zonapropLinksFileName: (body.zonapropLinksFileName ?? "").trim() || "Links Zonaprop",
    tokko: {
      operationIdSale: toNumberOrUndefined(body.operationIdSale),
      operationIdRent: toNumberOrUndefined(body.operationIdRent),
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

function renderPage(settings: AppSettings, saved: boolean): string {
  const stageInputs = STAGE_KEYS.map(
    (key) => `
      <div class="field">
        <label for="stage_${key}">${esc(STAGE_LABELS[key])}</label>
        <input type="number" id="stage_${key}" name="stage_${key}" value="${esc(settings.tokko.stages[key])}" placeholder="ID en Tokko">
      </div>`,
  ).join("\n");

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Configuración del agente</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; color: #222; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  .field { margin-bottom: 14px; }
  label { display: block; font-size: 0.9rem; margin-bottom: 4px; color: #444; }
  input[type=text], input[type=number], textarea {
    width: 100%; box-sizing: border-box; padding: 8px; font-size: 1rem;
    border: 1px solid #ccc; border-radius: 6px;
  }
  textarea { min-height: 80px; font-family: inherit; }
  .hint { font-size: 0.82rem; color: #777; margin-top: 4px; }
  .stages { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; }
  button { margin-top: 24px; padding: 10px 20px; font-size: 1rem; background: #1a7f4b; color: white; border: none; border-radius: 6px; cursor: pointer; }
  button:hover { background: #156138; }
  .banner { background: #e6f4ea; border: 1px solid #1a7f4b; padding: 10px 14px; border-radius: 6px; margin-bottom: 16px; }
</style>
</head>
<body>
  <h1>Configuración del agente</h1>
  ${saved ? '<div class="banner">Guardado correctamente.</div>' : ""}
  <form method="POST" action="/admin">

    <h2>Escalamiento a humano</h2>
    <div class="field">
      <label for="escalationNumbers">Números de WhatsApp (uno por línea, formato +54911...)</label>
      <textarea id="escalationNumbers" name="escalationNumbers">${esc(settings.escalationNumbers.join("\n"))}</textarea>
      <div class="hint">Cada número tiene que estar sumado al sandbox de Twilio mientras no se pase a un número productivo.</div>
    </div>

    <h2>Google Drive</h2>
    <div class="field">
      <label for="zonapropLinksFileName">Nombre del archivo con los links de Zonaprop</label>
      <input type="text" id="zonapropLinksFileName" name="zonapropLinksFileName" value="${esc(settings.zonapropLinksFileName)}">
      <div class="hint">Un archivo de texto/Doc/Sheet en Drive con líneas "nombre,link".</div>
    </div>

    <h2>Tokko — operaciones</h2>
    <div class="field">
      <label for="operationIdSale">ID de operación: Venta</label>
      <input type="number" id="operationIdSale" name="operationIdSale" value="${esc(settings.tokko.operationIdSale)}">
    </div>
    <div class="field">
      <label for="operationIdRent">ID de operación: Alquiler</label>
      <input type="number" id="operationIdRent" name="operationIdRent" value="${esc(settings.tokko.operationIdRent)}">
    </div>

    <h2>Tokko — etapas de Oportunidades</h2>
    <div class="stages">
      ${stageInputs}
    </div>

    <button type="submit">Guardar</button>
  </form>
</body>
</html>`;
}
