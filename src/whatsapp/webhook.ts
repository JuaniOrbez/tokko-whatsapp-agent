import twilio from "twilio";
import { Router, type Request, type Response, type NextFunction } from "express";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { handleIncomingMessage, relayHumanReply } from "../agent/orchestrator.js";
import { isHumanEscalationNumber, resolveHumanReply } from "../agent/escalation.js";
import { appendAssistantMessage } from "../agent/sessionStore.js";
import { appendConversationLog, getLastKnownName } from "../agent/conversationLog.js";
import { sendText, sendDocumentByLink, withTwilioMediaAuth } from "./client.js";
import { isEmailChannelId } from "../mail/client.js";
import { sendFileToCustomer } from "../agent/channelSend.js";

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

  // PUBLIC_WEBHOOK_URL apunta a /webhook, pero esta misma validación también
  // se usa para /webhook/status — hay que armar la URL real de cada pedido
  // (Twilio firma contra la URL exacta a la que le pega), no siempre la de
  // /webhook.
  const url = `${new URL(config.PUBLIC_WEBHOOK_URL).origin}${req.originalUrl}`;
  const signature = req.header("x-twilio-signature") ?? "";
  const valid = twilio.validateRequest(config.TWILIO_AUTH_TOKEN, signature, url, req.body as Record<string, string>);

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
  const text = body.Body ?? "";
  const senderName = body.ProfileName || from;
  // Twilio manda los adjuntos aparte del texto (NumMedia/MediaUrlN) — un
  // mensaje con un archivo puede no tener nada en Body.
  const hasMedia = Number(body.NumMedia ?? "0") > 0;
  const mediaUrl = hasMedia ? body.MediaUrl0 : undefined;
  const mediaContentType = hasMedia ? body.MediaContentType0 : undefined;

  if (!messageId || !from || (!text && !mediaUrl)) {
    logger.info("whatsapp.unsupported_or_incomplete_message", { hasBody: Boolean(text), hasMedia });
    return;
  }
  if (alreadyProcessed(messageId)) return;

  // Un número de escalamiento (ver HUMAN_ESCALATION_WHATSAPP_NUMBERS) nunca
  // pasa por el agente — si nos escribe, es (idealmente) respondiendo a una
  // consulta que le reenviamos, así que la enganchamos con esa consulta y
  // se la mandamos directo al cliente en vez de tratarlo como un cliente más.
  if (isHumanEscalationNumber(from)) {
    handleHumanReply(from, text, body.OriginalRepliedMessageSid, mediaUrl, mediaContentType).catch(
      (error) => {
        logger.error("agent.handle_human_reply_failed", { from, error: String(error) });
      },
    );
    return;
  }

  const channel = detectChannel(body, text);
  handleIncomingMessage({ from, name: senderName, text, channel }).catch((error) => {
    logger.error("agent.handle_message_failed", { from, error: String(error) });
  });
});

// Callback de estado de entrega que Twilio pega para los mensajes que se
// mandan con statusCallback (por ahora, los documentos por link — ver
// sendDocumentByLink). messages.create() solo confirma que Twilio aceptó el
// pedido; si el archivo en sí no llega (tipo de media no soportado, etc.)
// se entera recién acá, de forma asíncrona, con MessageStatus=failed/
// undelivered y el ErrorCode/ErrorMessage correspondiente.
webhookRouter.post("/webhook/status", validateTwilioSignature, (req: Request, res: Response) => {
  res.sendStatus(200);
  const body = req.body as Record<string, string>;
  const status = body.MessageStatus;
  if (status === "failed" || status === "undelivered") {
    logger.warn("whatsapp.delivery_status", {
      to: body.To,
      status,
      errorCode: body.ErrorCode,
      errorMessage: body.ErrorMessage,
    });
  } else {
    logger.info("whatsapp.delivery_status", { to: body.To, status });
  }
});

// De dónde vino la consulta, a partir del primer mensaje entrante. Meta manda
// datos de "referral" cuando el mensaje arranca desde un botón de anuncio de
// Instagram/Facebook ("click to WhatsApp") y Twilio los reenvía tal cual en
// el webhook (ReferralSourceType/ReferralHeadline/etc). Zonaprop no manda
// nada especial — se infiere por el texto precargado del primer mensaje, así
// que este patrón puede necesitar ajustes una vez que se vean casos reales.
function detectChannel(body: Record<string, string>, text: string): string {
  if (body.ReferralSourceType || body.ReferralHeadline || body.ReferralCtwaClid) {
    return "Instagram/Facebook (ads)";
  }
  if (/zonaprop/i.test(text)) {
    return "Zonaprop";
  }
  return "WhatsApp directo";
}

function guessFilename(contentType: string | undefined): string {
  const subtype = contentType?.split("/")[1]?.split(";")[0];
  const ext = subtype === "jpeg" ? "jpg" : (subtype ?? "bin");
  return `archivo.${ext}`;
}

// WhatsApp a veces precompleta el campo de texto con el nombre del archivo
// al adjuntarlo, y si no se borra antes de mandar, no aporta nada como
// mensaje — un nombre de archivo real casi nunca tiene espacios y siempre
// termina en una extensión, a diferencia de un mensaje escrito a mano.
function looksLikeFilename(text: string): boolean {
  const trimmed = text.trim();
  return !trimmed.includes(" ") && /\.[a-zA-Z0-9]{2,5}$/.test(trimmed);
}

async function handleHumanReply(
  from: string,
  text: string,
  repliedToSid: string | undefined,
  mediaUrl: string | undefined,
  mediaContentType: string | undefined,
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

  if (mediaUrl) {
    // Reenvía el archivo real como adjunto (no como texto). Si no escribió
    // nada, igual mandamos un texto por defecto — nunca un archivo pelado
    // sin ningún contexto.
    const caption = text && !looksLikeFilename(text) ? text : "Acá tenés lo que me pediste.";
    const filename = guessFilename(mediaContentType);
    if (isEmailChannelId(pending.customerPhone)) {
      // El MediaUrl que manda Twilio para un mensaje entrante requiere las
      // credenciales de la cuenta para descargarse (ver withTwilioMediaAuth)
      // — para adjuntarlo a un mail hace falta bajarlo primero nosotros,
      // WhatsApp sí lo puede resolver directo desde su propia URL.
      const res = await fetch(withTwilioMediaAuth(mediaUrl));
      const content = Buffer.from(await res.arrayBuffer());
      await sendFileToCustomer(pending.customerPhone, caption, {
        filename,
        url: "",
        mimeType: mediaContentType || "application/octet-stream",
        content,
      });
    } else {
      await sendDocumentByLink(pending.customerPhone, withTwilioMediaAuth(mediaUrl), filename, caption);
    }
    appendAssistantMessage(pending.customerPhone, caption);
    appendConversationLog({
      ts: Date.now(),
      phone: pending.customerPhone,
      name: getLastKnownName(pending.customerPhone),
      role: "assistant",
      text: `${caption} [archivo adjunto]`,
    });
    logger.info("agent.human_reply_relayed_media", { from, customerPhone: pending.customerPhone });
    return;
  }

  // No se manda tal cual: se redacta con el estilo del agente y en
  // contexto de la charla, para que se sienta como una respuesta más del
  // mismo chat en vez de un texto pegado sin aclarar que respondió un humano.
  await relayHumanReply(pending.customerPhone, text);
  logger.info("agent.human_reply_relayed", { from, customerPhone: pending.customerPhone });
}
