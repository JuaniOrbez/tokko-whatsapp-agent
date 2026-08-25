import fs from "node:fs";
import path from "node:path";
import { config, OPPORTUNITY_STAGES, type OpportunityStageKey } from "./config.js";
import { logger } from "./logger.js";

/**
 * Configuración de negocio editable en vivo desde /admin (a diferencia de
 * lo que vive en .env, que son credenciales/infra y requieren reiniciar el
 * servidor). Se guarda en un JSON en disco — no es una base de datos real,
 * pero alcanza para un solo proceso y evita reeditar código para cambiar
 * un número de teléfono o un ID de Tokko.
 */
export interface AppSettings {
  // Números de WhatsApp (E.164) que reciben los avisos de escalate_to_human
  // / share_file. Ver docs/SETUP.md — no puede ser un grupo, la API de
  // WhatsApp no lo permite.
  escalationNumbers: string[];
  // Nombre del archivo en Drive que mapea nombre de propiedad -> link de
  // Zonaprop (ver findZonapropLink en drive/client.ts).
  zonapropLinksFileName: string;
  // ID de la carpeta de Drive donde buscar archivos (de la URL,
  // drive.google.com/drive/folders/ESTE_ID). Opcional: si se deja vacío,
  // busca en todo lo que la cuenta de servicio tenga compartido.
  driveFolderId?: string;
  tokko: {
    operationIdSale?: number;
    operationIdRent?: number;
    stages: Record<OpportunityStageKey, number | undefined>;
  };
}

const SETTINGS_PATH = path.resolve(process.cwd(), "data", "settings.json");

function defaultSettings(): AppSettings {
  // La primera vez que corre, arranca con lo que ya estaba en .env (si
  // había algo) para no perder una configuración que ya funcionaba.
  return {
    escalationNumbers: config.HUMAN_ESCALATION_WHATSAPP_NUMBERS ?? [],
    zonapropLinksFileName: "Links Zonaprop",
    driveFolderId: undefined,
    tokko: {
      operationIdSale: config.TOKKO_OPERATION_ID_SALE,
      operationIdRent: config.TOKKO_OPERATION_ID_RENT,
      stages: { ...OPPORTUNITY_STAGES },
    },
  };
}

let cache: AppSettings | null = null;

export function getSettings(): AppSettings {
  if (cache) return cache;
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      cache = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8")) as AppSettings;
      return cache;
    } catch (error) {
      logger.error("settings.load_failed", { error: String(error) });
    }
  }
  cache = defaultSettings();
  saveSettings(cache);
  return cache;
}

export function saveSettings(settings: AppSettings): void {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  cache = settings;
}
