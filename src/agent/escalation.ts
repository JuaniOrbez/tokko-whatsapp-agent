import { sendText } from "../whatsapp/client.js";
import { config } from "../config.js";

interface PendingEscalation {
  customerPhone: string;
  question: string;
  createdAt: number;
}

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

// SID del mensaje de alerta que le mandamos al humano -> a qué cliente hay
// que reenviarle la respuesta cuando conteste (citando ese mensaje).
const pendingBySid = new Map<string, PendingEscalation>();
// Respaldo para cuando el humano contesta sin citar el mensaje (por
// ejemplo si su cliente de WhatsApp no manda esa info, o en el sandbox):
// el último pendiente que le mandamos a ese número.
const lastPendingByHuman = new Map<string, string>();

function cleanup(): void {
  const now = Date.now();
  for (const [sid, pending] of pendingBySid) {
    if (now - pending.createdAt > PENDING_TTL_MS) pendingBySid.delete(sid);
  }
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

export function isHumanEscalationNumber(phone: string): boolean {
  const numbers = config.HUMAN_ESCALATION_WHATSAPP_NUMBERS ?? [];
  const normalized = normalizePhone(phone);
  return numbers.some((n) => normalizePhone(n) === normalized);
}

/**
 * Le avisa a los números de HUMAN_ESCALATION_WHATSAPP_NUMBERS y deja
 * registrada la consulta para poder reenviarle la respuesta al cliente
 * cuando alguno conteste (ver resolveHumanReply). Devuelve false si no hay
 * ningún número configurado.
 */
export async function escalateToHumans(input: {
  customerPhone: string;
  customerName: string;
  question: string;
  reason?: string;
}): Promise<boolean> {
  const numbers = config.HUMAN_ESCALATION_WHATSAPP_NUMBERS;
  if (!numbers || numbers.length === 0) return false;

  const alertText =
    `🔔 Consulta necesita revisión humana\n` +
    `Cliente: ${input.customerName} (${input.customerPhone})\n` +
    `Pregunta: ${input.question}` +
    (input.reason ? `\nMotivo: ${input.reason}` : "") +
    `\n\nRespondé citando este mensaje (mantené presionado → Responder) y tu respuesta se le manda directo al cliente.`;

  cleanup();
  await Promise.all(
    numbers.map(async (number) => {
      const sid = await sendText(number, alertText);
      pendingBySid.set(sid, {
        customerPhone: input.customerPhone,
        question: input.question,
        createdAt: Date.now(),
      });
      lastPendingByHuman.set(number, sid);
    }),
  );
  return true;
}

/**
 * Busca a qué consulta corresponde la respuesta de un humano y la saca de
 * la lista de pendientes. Prioriza el mensaje citado (`repliedToSid`); si
 * no citó ninguno, usa como respaldo el último pendiente para ese número.
 */
export function resolveHumanReply(
  humanNumber: string,
  repliedToSid: string | undefined,
): PendingEscalation | undefined {
  cleanup();

  if (repliedToSid) {
    const pending = pendingBySid.get(repliedToSid);
    if (pending) {
      pendingBySid.delete(repliedToSid);
      return pending;
    }
  }

  const fallbackSid = lastPendingByHuman.get(humanNumber);
  if (fallbackSid) {
    const pending = pendingBySid.get(fallbackSid);
    if (pending) {
      pendingBySid.delete(fallbackSid);
      lastPendingByHuman.delete(humanNumber);
      return pending;
    }
  }

  return undefined;
}
