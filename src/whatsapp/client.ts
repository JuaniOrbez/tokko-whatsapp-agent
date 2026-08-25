import twilio from "twilio";
import { config } from "../config.js";
import { logger } from "../logger.js";

const client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);

function toWhatsAppAddress(phone: string): string {
  return phone.startsWith("whatsapp:") ? phone : `whatsapp:${phone}`;
}

/** Devuelve el SID del mensaje enviado (sirve para engancharlo con una respuesta citada más adelante). */
export async function sendText(to: string, body: string): Promise<string> {
  logger.info("whatsapp.send_text", { to, length: body.length });
  const base = { from: config.TWILIO_WHATSAPP_FROM, to: toWhatsAppAddress(to) };

  // Confirmado en vivo: WhatsApp/Twilio en este sandbox rechaza el envío de
  // texto libre ("ContentSid Required") — hay que mandarlo a través de un
  // Content Template con un único body "{{1}}".
  if (config.TWILIO_CONTENT_SID) {
    const message = await client.messages.create({
      ...base,
      contentSid: config.TWILIO_CONTENT_SID,
      contentVariables: JSON.stringify({ 1: body }),
    });
    return message.sid;
  }
  const message = await client.messages.create({ ...base, body });
  return message.sid;
}

export async function sendDocumentByLink(
  to: string,
  link: string,
  filename: string,
  caption?: string,
): Promise<void> {
  logger.info("whatsapp.send_document", { to, filename });
  await client.messages.create({
    from: config.TWILIO_WHATSAPP_FROM,
    to: toWhatsAppAddress(to),
    body: caption,
    mediaUrl: [link],
  });
}

// Twilio no expone una acción para marcar un mensaje como "leído" — el
// estado de lectura de WhatsApp lo maneja la plataforma automáticamente.
// Se deja como no-op para no romper el resto del código que la invoca.
export async function markAsRead(_messageId: string): Promise<void> {}
