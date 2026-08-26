import { sendText } from "../whatsapp/client.js";
import { getSettings } from "../settings.js";

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
  const contacts = getSettings().escalationContacts;
  const normalized = normalizePhone(phone);
  return contacts.some((c) => normalizePhone(c.phone) === normalized);
}

/**
 * Le avisa a los contactos de escalamiento (ver /admin) y deja registrada
 * la consulta para poder reenviarle la respuesta al cliente cuando alguno
 * conteste (ver resolveHumanReply). Devuelve false si no hay ningún
 * contacto configurado.
 *
 * Si se pasa `category`, avisa solo a los contactos cuyo motivo coincide
 * exactamente (ver tools.ts#buildEscalateToHumanTool) — si ninguno
 * coincide, o no se pasó categoría, avisa a todos, para que la consulta
 * nunca quede sin nadie enterado.
 */
export async function escalateToHumans(input: {
  customerPhone: string;
  customerName: string;
  question: string;
  reason?: string;
  category?: string;
}): Promise<boolean> {
  const contacts = getSettings().escalationContacts;
  if (contacts.length === 0) return false;

  const matched = input.category ? contacts.filter((c) => c.reason === input.category) : [];
  const targets = matched.length > 0 ? matched : contacts;

  const alertText =
    `🔔 Consulta necesita revisión humana\n` +
    `Cliente: ${input.customerName} (${input.customerPhone})\n` +
    `Pregunta: ${input.question}` +
    (input.reason ? `\nMotivo: ${input.reason}` : "") +
    `\n\nRespondé citando este mensaje (mantené presionado → Responder) y tu respuesta se le manda directo al cliente.`;

  cleanup();
  await Promise.all(
    targets.map(async (contact) => {
      const sid = await sendText(contact.phone, alertText);
      pendingBySid.set(sid, {
        customerPhone: input.customerPhone,
        question: input.question,
        createdAt: Date.now(),
      });
      lastPendingByHuman.set(contact.phone, sid);
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
