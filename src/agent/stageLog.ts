import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";

/**
 * Registro de cambios de etapa detectados por el agente durante la charla.
 * Tokko confirmó que su API no permite escribir el estado de un contacto
 * (`/contact/{id}/` devuelve 405 para PATCH, ver src/tokko/client.ts) — no
 * es un problema de permisos, la API de Tokko simplemente no es
 * bidireccional. Por eso esto no intenta escribir nada en Tokko: queda
 * anotado acá para que alguien del equipo lo revise en /admin/contacts y lo
 * aplique a mano en la cuenta de Tokko. JSONL append-only, mismo patrón que
 * conversationLog.ts.
 */
export interface StageLogEntry {
  ts: number; // epoch ms
  phone: string;
  name: string;
  stageKey: string;
  stageLabel: string; // la etiqueta configurada en el momento — queda fija aunque después se edite/borre la etapa en /admin
  reason?: string;
}

const LOG_PATH = path.resolve(process.cwd(), "data", "stages.jsonl");

export function appendStageLog(entry: StageLogEntry): void {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
  } catch (error) {
    logger.warn("stage_log.append_failed", { error: String(error) });
  }
}

function readAllEntries(): StageLogEntry[] {
  if (!fs.existsSync(LOG_PATH)) return [];
  const lines = fs.readFileSync(LOG_PATH, "utf-8").split("\n").filter(Boolean);
  const entries: StageLogEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as StageLogEntry);
    } catch (error) {
      logger.warn("stage_log.corrupt_line", { error: String(error) });
    }
  }
  return entries;
}

/** Última etapa anotada por teléfono (la más reciente gana si hubo más de una). */
export function getLatestStageByPhone(): Map<string, StageLogEntry> {
  const byPhone = new Map<string, StageLogEntry>();
  for (const e of readAllEntries()) {
    const existing = byPhone.get(e.phone);
    if (!existing || e.ts > existing.ts) byPhone.set(e.phone, e);
  }
  return byPhone;
}
