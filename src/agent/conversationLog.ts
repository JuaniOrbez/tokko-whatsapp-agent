import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";

/**
 * Registro durable de mensajes visibles (cliente/agente), separado del
 * historial en memoria de sessionStore.ts (que solo sirve para el loop
 * del agente y se pierde al reiniciar). Este log es la base del resumen
 * diario y del diagrama de conversación en /admin — un JSONL append-only,
 * simple y suficiente para el volumen de una sola inmobiliaria.
 */
export interface ConversationLogEntry {
  ts: number; // epoch ms
  phone: string;
  name: string;
  role: "user" | "assistant";
  text: string;
}

const LOG_PATH = path.resolve(process.cwd(), "data", "conversations.jsonl");

export function appendConversationLog(entry: ConversationLogEntry): void {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
  } catch (error) {
    logger.warn("conversation_log.append_failed", { error: String(error) });
  }
}

function readAllEntries(): ConversationLogEntry[] {
  if (!fs.existsSync(LOG_PATH)) return [];
  const lines = fs.readFileSync(LOG_PATH, "utf-8").split("\n").filter(Boolean);
  const entries: ConversationLogEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as ConversationLogEntry);
    } catch (error) {
      logger.warn("conversation_log.corrupt_line", { error: String(error) });
    }
  }
  return entries;
}

export function getEntriesSince(sinceTs: number): ConversationLogEntry[] {
  return readAllEntries().filter((e) => e.ts >= sinceTs);
}

export function getEntriesForPhone(phone: string): ConversationLogEntry[] {
  return readAllEntries()
    .filter((e) => e.phone === phone)
    .sort((a, b) => a.ts - b.ts);
}

/** Último nombre conocido para un teléfono (según el log), o el teléfono mismo si no hay nada. */
export function getLastKnownName(phone: string): string {
  const entries = getEntriesForPhone(phone);
  return entries.length > 0 ? entries[entries.length - 1].name : phone;
}

/** Últimos números que escribieron, más reciente primero — para elegir cuál ver en /admin/conversations. */
export function listRecentConversations(limit = 50): { phone: string; name: string; lastTs: number }[] {
  const byPhone = new Map<string, { phone: string; name: string; lastTs: number }>();
  for (const e of readAllEntries()) {
    const existing = byPhone.get(e.phone);
    if (!existing || e.ts > existing.lastTs) {
      byPhone.set(e.phone, { phone: e.phone, name: e.name, lastTs: e.ts });
    }
  }
  return [...byPhone.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, limit);
}
