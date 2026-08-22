import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { markAsRead } from "./client.js";
import type { WhatsAppWebhookPayload } from "./types.js";
import { handleIncomingMessage } from "../agent/orchestrator.js";

export const webhookRouter = Router();

// Meta reintenta la entrega si no respondemos rápido; guardamos los IDs de
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

function isValidSignature(req: Request): boolean {
  if (!config.WHATSAPP_APP_SECRET) return true; // firma no configurada: se omite la validación
  const signature = req.header("x-hub-signature-256");
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!signature || !rawBody) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", config.WHATSAPP_APP_SECRET).update(rawBody).digest("hex");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Meta llama a esto una vez, al configurar el webhook en el panel de la app.
webhookRouter.get("/webhook", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.WHATSAPP_VERIFY_TOKEN) {
    logger.info("whatsapp.webhook_verified");
    res.status(200).send(challenge);
    return;
  }
  res.sendStatus(403);
});

webhookRouter.post("/webhook", (req: Request, res: Response) => {
  if (!isValidSignature(req)) {
    logger.warn("whatsapp.invalid_signature");
    res.sendStatus(401);
    return;
  }

  // Responder 200 enseguida: Meta espera una respuesta rápida y reintenta si
  // no la recibe. El procesamiento real sigue en segundo plano.
  res.sendStatus(200);

  const payload = req.body as WhatsAppWebhookPayload;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const contactsByWaId = new Map(
        (value?.contacts ?? []).map((c) => [c.wa_id, c.profile.name]),
      );

      for (const message of value?.messages ?? []) {
        if (message.type !== "text" || !message.text) {
          logger.info("whatsapp.unsupported_message_type", { type: message.type });
          continue;
        }
        if (alreadyProcessed(message.id)) continue;

        void markAsRead(message.id);

        const senderName = contactsByWaId.get(message.from) ?? message.from;
        handleIncomingMessage({
          from: message.from,
          name: senderName,
          text: message.text.body,
        }).catch((error) => {
          logger.error("agent.handle_message_failed", {
            from: message.from,
            error: String(error),
          });
        });
      }
    }
  }
});
