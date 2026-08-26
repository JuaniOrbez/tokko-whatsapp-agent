import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";

/**
 * Registro de qué emprendimiento y qué tipología preguntó cada conversación
 * — se completa desde tools.ts cuando el agente usa search_developments,
 * get_development_details o search_properties. Es la base del desglose por
 * emprendimiento/tipología en /admin/metrics (ver conversationLog.ts para
 * el registro de mensajes en sí, que es donde vive el canal de origen).
 */
export interface ToolUsageEntry {
  ts: number;
  phone: string;
  kind: "development" | "typology";
  value: string;
}

const LOG_PATH = path.resolve(process.cwd(), "data", "tool_usage.jsonl");

export function appendToolUsage(entry: ToolUsageEntry): void {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
  } catch (error) {
    logger.warn("tool_usage_log.append_failed", { error: String(error) });
  }
}

function readAllEntries(): ToolUsageEntry[] {
  if (!fs.existsSync(LOG_PATH)) return [];
  const lines = fs.readFileSync(LOG_PATH, "utf-8").split("\n").filter(Boolean);
  const entries: ToolUsageEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as ToolUsageEntry);
    } catch (error) {
      logger.warn("tool_usage_log.corrupt_line", { error: String(error) });
    }
  }
  return entries;
}

/** Primer valor mencionado por teléfono para un tipo dado — representa "qué preguntó" esa conversación. */
export function firstValueByPhone(kind: ToolUsageEntry["kind"]): Map<string, string> {
  const result = new Map<string, { value: string; ts: number }>();
  for (const e of readAllEntries()) {
    if (e.kind !== kind) continue;
    const existing = result.get(e.phone);
    if (!existing || e.ts < existing.ts) {
      result.set(e.phone, { value: e.value, ts: e.ts });
    }
  }
  return new Map([...result.entries()].map(([phone, v]) => [phone, v.value]));
}
