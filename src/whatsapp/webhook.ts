import twilio from "twilio";
import { Router, type Request, type Response, type NextFunction } from "express";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { handleIncomingMessage } from "../agent/orchestrator.js";
import { isHumanEscalationNumber, resolveHumanReply } from "../agent/escalation.js";
import { sendText } from "./client.js";

export const webhookRouter = Router();

// Twilio reintenta la entrega si no respondemos rápido; guardamos los IDs de
// mensaje ya procesados un rato para no duplicar respuestas/acciones en Tokko.
const processedMessageIds = new Map<string, number>();
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

function alreadyProcessed(messageId: string): boolean {
  const now = Date.now();
  for (const [id, seenAt] of processedMessageIds) {
    if (now - seenAt > DEDUPE_WINDOW_MS) processedMessageIds.delete(id);
  }
  if (processedMessageIds.has(messageId)) return true;
  processedMessageIds.set(messageId, now);
  return false;
}

function validateTwilioSignature(req: Request, res: Response, next: NextFunction): void {
  if (!config.TWILIO_VALIDATE_SIGNATURE) {
    next();
    return;
  }
  if (!config.PUBLIC_WEBHOOK_URL) {
    logger.warn("whatsapp.signature_check_skipped_no_public_url");
    next();
    return;
  }

  const signature = req.header("x-twilio-signature") ?? "";
  const valid = twilio.validateRequest(
    config.TWILIO_AUTH_TOKEN,
    signature,
    config.PUBLIC_WEBHOOK_URL,
    req.body as Record<string, string>,
  );

  if (!valid) {
    logger.warn("whatsapp.invalid_signature");
    res.sendStatus(401);
    return;
  }
  next();
}

webhookRouter.post("/webhook", validateTwilioSignature, (req: Request, res: Response) => {
  // Responder rápido: Twilio espera una respuesta pronta y reintenta si no
  // la recibe. El procesamiento real sigue en segundo plano.
  res.status(200).type("text/xml").send("<Response></Response>");

  const body = req.body as Record<string, string>;
  const messageId = body.MessageSid;
  const from = (body.From ?? "").replace(/^whatsapp:/, "");
  const text = body.Body;
  const senderName = body.ProfileName || from;

  if (!messageId || !from || !text) {
    logger.info("whatsapp.unsupported_or_incomplete_message", { hasBody: Boolean(text) });
    return;
  }
  if (alreadyProcessed(messageId)) return;

  // Un número de escalamiento (ver HUMAN_ESCALATION_WHATSAPP_NUMBERS) nunca
  // pasa por el agente — si nos escribe, es (idealmente) respondiendo a una
  // consulta que le reenviamos, así que la enganchamos con esa consulta y
  // se la mandamos directo al cliente en vez de tratarlo como un cliente más.
  if (isHumanEscalationNumber(from)) {
    handleHumanReply(from, text, body.OriginalRepliedMessageSid).catch((error) => {
      logger.error("agent.handle_human_reply_failed", { from, error: String(error) });
    });
    return;
  }

  handleIncomingMessage({ from, name: senderName, text }).catch((error) => {
    logger.error("agent.handle_message_failed", { from, error: String(error) });
  });
});

async function handleHumanReply(
  from: string,
  text: string,
  repliedToSid: string | undefined,
): Promise<void> {
  const pending = resolveHumanReply(from, repliedToSid);
  if (!pending) {
    logger.warn("agent.human_reply_unmatched", { from });
    await sendText(
      from,
      "No encontré ninguna consulta pendiente para reenviar esta respuesta — puede que ya se haya resuelto o vencido.",
    ).catch(() => {});
    return;
  }
  await sendText(pending.customerPhone, `Te escribe alguien de nuestro equipo:\n\n${text}`);
  logger.info("agent.human_reply_relayed", { from, customerPhone: pending.customerPhone });
}
