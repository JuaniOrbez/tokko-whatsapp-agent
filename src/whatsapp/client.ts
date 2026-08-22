import { config } from "../config.js";
import { logger } from "../logger.js";

const BASE_URL = `https://graph.facebook.com/${config.WHATSAPP_API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`;

async function callGraphApi(body: Record<string, unknown>): Promise<void> {
  const response = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WhatsApp API error ${response.status}: ${text}`);
  }
}

export async function sendText(to: string, body: string): Promise<void> {
  logger.info("whatsapp.send_text", { to, length: body.length });
  await callGraphApi({
    to,
    type: "text",
    text: { body, preview_url: false },
  });
}

export async function sendDocumentByLink(
  to: string,
  link: string,
  filename: string,
  caption?: string,
): Promise<void> {
  logger.info("whatsapp.send_document", { to, filename });
  await callGraphApi({
    to,
    type: "document",
    document: { link, filename, caption },
  });
}

export async function markAsRead(messageId: string): Promise<void> {
  try {
    await callGraphApi({ status: "read", message_id: messageId });
  } catch (error) {
    // No crítico: si falla el "visto" no debe interrumpir el flujo del mensaje.
    logger.warn("whatsapp.mark_read_failed", { messageId, error: String(error) });
  }
}
