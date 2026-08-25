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

/**
 * Agrega un mensaje "del asistente" al historial sin pasar por el agente —
 * usado cuando la respuesta de un humano se reenvía al cliente (ver
 * orchestrator.ts#relayHumanReply), para que quede en el contexto de la
 * conversación como si el agente ya lo hubiera dicho.
 */
export function appendAssistantMessage(phone: string, text: string): void {
  const history = getHistory(phone);
  saveHistory(phone, [...history, { role: "assistant", content: text }]);
}

// Evita mandar una "Consulta" nueva a Tokko en cada mensaje mientras el
// contacto todavía no fue aprobado a mano (ver tokkoClient.submitInquiry).
// Se pierde al reiniciar el proceso — en el peor caso se manda una consulta
// de más, no es grave.
const inquirySubmitted = new Set<string>();

export function hasSubmittedInquiry(phone: string): boolean {
  return inquirySubmitted.has(phone);
}

export function markInquirySubmitted(phone: string): void {
  inquirySubmitted.add(phone);
}
