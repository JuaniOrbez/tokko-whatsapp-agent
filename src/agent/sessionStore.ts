import type Anthropic from "@anthropic-ai/sdk";

// Historial de conversación en memoria por número de teléfono. Se pierde si
// el proceso se reinicia (las notas guardadas en Tokko son el registro
// durable); para producción de mayor volumen, reemplazar por Redis/DB.
const sessions = new Map<string, Anthropic.MessageParam[]>();

const MAX_MESSAGES = 20;

export function getHistory(phone: string): Anthropic.MessageParam[] {
  return sessions.get(phone) ?? [];
}

export function saveHistory(phone: string, messages: Anthropic.MessageParam[]): void {
  sessions.set(phone, messages.slice(-MAX_MESSAGES));
}
