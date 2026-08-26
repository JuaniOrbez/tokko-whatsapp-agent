import Anthropic from "@anthropic-ai/sdk";
import { getEntriesSince } from "./conversationLog.js";
import { sendText } from "../whatsapp/client.js";
import { getSettings } from "../settings.js";
import { logger } from "../logger.js";

const anthropic = new Anthropic();

// Argentina no tiene horario de verano actualmente: UTC-3 fijo todo el año.
const ARGENTINA_UTC_OFFSET_HOURS = 3;

function startOfTodayArgentina(): number {
  const now = new Date();
  const artNow = new Date(now.getTime() - ARGENTINA_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  return Date.UTC(
    artNow.getUTCFullYear(),
    artNow.getUTCMonth(),
    artNow.getUTCDate(),
    ARGENTINA_UTC_OFFSET_HOURS,
    0,
    0,
    0,
  );
}

const SUMMARY_SYSTEM_PROMPT = `Sos un asistente que arma resúmenes diarios de
actividad de WhatsApp para una inmobiliaria, a partir del registro de
mensajes del día (cliente y agente). Armá un resumen corto y accionable
para el dueño de la inmobiliaria: agrupá por cliente, contá brevemente qué
preguntó/buscaba cada uno y en qué quedó (si escaló a un humano, si pidió
una visita o un archivo, si quedó algo pendiente). Estilo español
rioplatense, directo, corto, apto para WhatsApp (sin markdown de títulos).
No inventes nada que no esté en el registro — si algo quedó sin resolver,
decilo tal cual.`;

export interface DailySummaryResult {
  text: string;
  entryCount: number;
}

/**
 * Arma el resumen del día (desde medianoche hora Argentina hasta ahora) a
 * partir del registro de conversaciones. Devuelve null si todavía no hubo
 * actividad — se usa tanto para el envío automático por WhatsApp
 * (generateAndSendDailySummary) como para verlo on-demand en /admin.
 */
export async function buildDailySummary(): Promise<DailySummaryResult | null> {
  const entries = getEntriesSince(startOfTodayArgentina());
  if (entries.length === 0) return null;

  const transcript = entries
    .map((e) => `[${e.phone} - ${e.name}] ${e.role === "user" ? "Cliente" : "Agente"}: ${e.text}`)
    .join("\n");

  const response = await anthropic.messages.create({
    model: "claude-opus-5",
    max_tokens: 1024,
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: "user", content: transcript }],
  });

  const summary = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  if (!summary) return null;
  return { text: summary, entryCount: entries.length };
}

/**
 * Arma y manda el resumen del día a los números de escalamiento. No hace
 * nada si no hubo actividad hoy, o si no hay ningún número configurado.
 * Se dispara desde src/scheduler.ts según la hora configurada en /admin.
 */
export async function generateAndSendDailySummary(): Promise<void> {
  const result = await buildDailySummary();
  if (!result) {
    logger.info("daily_summary.no_activity");
    return;
  }

  const numbers = getSettings().escalationContacts.map((c) => c.phone);
  if (numbers.length === 0) {
    logger.warn("daily_summary.no_recipients");
    return;
  }

  const message = `📋 Resumen del día (${result.entryCount} mensajes)\n\n${result.text}`;
  await Promise.all(numbers.map((n) => sendText(n, message)));
  logger.info("daily_summary.sent", { recipients: numbers.length, entryCount: result.entryCount });
}
