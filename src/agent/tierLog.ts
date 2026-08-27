import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";

/**
 * Registro del tier que el agente le asignó a cada cliente, según los
 * criterios en lenguaje natural configurados en /admin/config (ver
 * settings.ts#TierDefinition y tools.ts#buildClassifyTierTool). JSONL
 * append-only, mismo patrón que stageLog.ts — el agente puede reclasificar
 * a un cliente más de una vez si cambian las señales; siempre gana la
 * última.
 */
export interface TierLogEntry {
  ts: number; // epoch ms
  phone: string;
  name: string;
  tierKey: string;
  tierLabel: string; // la etiqueta configurada en el momento — queda fija aunque después se edite el tier en /admin
  reasoning: string;
}

const LOG_PATH = path.resolve(process.cwd(), "data", "tiers.jsonl");

export function appendTierLog(entry: TierLogEntry): void {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
  } catch (error) {
    logger.warn("tier_log.append_failed", { error: String(error) });
  }
}

function readAllEntries(): TierLogEntry[] {
  if (!fs.existsSync(LOG_PATH)) return [];
  const lines = fs.readFileSync(LOG_PATH, "utf-8").split("\n").filter(Boolean);
  const entries: TierLogEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as TierLogEntry);
    } catch (error) {
      logger.warn("tier_log.corrupt_line", { error: String(error) });
    }
  }
  return entries;
}

/** Último tier anotado por teléfono (el más reciente gana si hubo más de uno). */
export function getLatestTierByPhone(): Map<string, TierLogEntry> {
  const byPhone = new Map<string, TierLogEntry>();
  for (const e of readAllEntries()) {
    const existing = byPhone.get(e.phone);
    if (!existing || e.ts > existing.ts) byPhone.set(e.phone, e);
  }
  return byPhone;
}
