import fs from "node:fs";
import { google, type gmail_v1 } from "googleapis";
import { config } from "../config.js";
import { getSettings } from "../settings.js";
import { logger } from "../logger.js";

/**
 * Canal de mail — usa la misma cuenta de servicio que ya tiene Drive y
 * Calendar, pero acá hace falta "domain-wide delegation" habilitada en el
 * admin de Google Workspace (admin.google.com → Seguridad → Controles de
 * API → Delegación a nivel de dominio) para que la cuenta de servicio
 * pueda actuar como la casilla real (MAIL_ADDRESS) — sin eso, Gmail
 * rechaza los pedidos aunque la cuenta de servicio sea válida. Ver
 * docs/SETUP.md para el paso a paso.
 */

export function isMailEnabled(): boolean {
  return Boolean(config.MAIL_ADDRESS);
}

// El identificador de cliente que usa el resto del sistema (historial,
// etapa, tier, etc. — ver sessionStore/stageLog/tierLog) es un string
// libre, no necesariamente un teléfono: para un cliente de WhatsApp sigue
// siendo el número E.164 de siempre (sin cambios, compatible con todo lo
// ya guardado); para uno de mail, es "email:" + la dirección. Con esto
// alcanza para que cualquier lugar del código sepa por qué canal contestar
// sin tener que pasar un campo de canal aparte por todos lados.
const EMAIL_ID_PREFIX = "email:";

export function toEmailChannelId(address: string): string {
  return `${EMAIL_ID_PREFIX}${address.trim().toLowerCase()}`;
}

export function isEmailChannelId(id: string): boolean {
  return id.startsWith(EMAIL_ID_PREFIX);
}

export function emailAddressFromId(id: string): string {
  return id.slice(EMAIL_ID_PREFIX.length);
}

/** "email:juan@x.com" -> "juan@x.com, por mail"; un teléfono queda tal cual — para mostrar el contacto del cliente en textos internos (avisos al equipo, descripción de una visita, etc). */
export function displayContact(id: string): string {
  return isEmailChannelId(id) ? `${emailAddressFromId(id)}, por mail` : id;
}

let gmailClient: gmail_v1.Gmail | null = null;

function getGmail(): gmail_v1.Gmail {
  if (gmailClient) return gmailClient;
  if (!config.MAIL_ADDRESS) {
    throw new Error("MAIL_ADDRESS no está configurado — el canal de mail está deshabilitado.");
  }
  const keyData = JSON.parse(fs.readFileSync(config.GOOGLE_SERVICE_ACCOUNT_FILE, "utf-8")) as {
    client_email: string;
    private_key: string;
  };
  // JWT explícito (no GoogleAuth con keyFile, como en drive/calendar) porque
  // acá hace falta "subject" para impersonar la casilla real vía
  // domain-wide delegation — sin la cuenta de servicio no tiene ningún
  // buzón propio.
  const auth = new google.auth.JWT({
    email: keyData.client_email,
    key: keyData.private_key,
    scopes: ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send"],
    subject: config.MAIL_ADDRESS,
  });
  gmailClient = google.gmail({ version: "v1", auth });
  return gmailClient;
}

function base64url(input: string): string {
  return Buffer.from(input, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

// RFC 2047: un Subject/nombre con tildes o ñ no puede ir suelto en un
// header — hay que codificarlo como "encoded word" si no es ASCII puro.
function encodeMimeHeader(text: string): string {
  if (/^[\x00-\x7F]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, "utf-8").toString("base64")}?=`;
}

function parseFromHeader(header: string): { address: string; name: string } {
  const match = header.match(/^(.*?)<(.+)>$/);
  if (match) {
    return { name: match[1].trim().replace(/^"|"$/g, ""), address: match[2].trim() };
  }
  return { name: "", address: header.trim() };
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Recorre las partes MIME buscando texto plano — si no hay, cae a HTML despojado de tags. */
function extractBodyText(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType?.startsWith("multipart/")) {
        const nested = extractBodyText(part);
        if (nested) return nested;
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        return decodeBase64Url(part.body.data)
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
    }
  }
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  return "";
}

export interface InboundMail {
  gmailMessageId: string;
  threadId: string;
  from: string; // dirección limpia, sin el "Nombre <...>"
  fromName: string;
  subject: string;
  bodyText: string;
  // Header "Message-ID" real del mail (para el In-Reply-To/References de la respuesta) — no confundir con gmailMessageId (el id interno de la API).
  rfc822MessageId?: string;
}

/**
 * Mails nuevos en la bandeja de entrada, sin leer y que no mandó la propia
 * casilla — descarta también los que vengan de un mail del equipo (ver
 * settings.ts#TeamMember.email), para no procesar como "cliente" un mail
 * interno. No marca como leído acá (ver markProcessed) — eso lo hace el
 * llamador después de procesar cada uno, así un fallo a mitad de camino no
 * pierde el mail silenciosamente.
 */
export async function listNewInboundMessages(): Promise<InboundMail[]> {
  const gmail = getGmail();
  const teamEmails = new Set(
    getSettings()
      .team.map((m) => m.email.trim().toLowerCase())
      .filter(Boolean),
  );

  const listRes = await gmail.users.messages.list({
    userId: "me",
    q: "in:inbox is:unread -from:me",
    maxResults: 20,
  });
  const refs = listRes.data.messages ?? [];

  const results: InboundMail[] = [];
  for (const ref of refs) {
    if (!ref.id) continue;
    const full = await gmail.users.messages.get({ userId: "me", id: ref.id, format: "full" });
    const headers = full.data.payload?.headers;
    const { address, name } = parseFromHeader(getHeader(headers, "From"));
    if (!address || teamEmails.has(address.toLowerCase())) continue;

    results.push({
      gmailMessageId: ref.id,
      threadId: full.data.threadId ?? ref.id,
      from: address,
      fromName: name || address,
      subject: getHeader(headers, "Subject"),
      bodyText: extractBodyText(full.data.payload).trim(),
      rfc822MessageId: getHeader(headers, "Message-ID") || undefined,
    });
  }
  return results;
}

/** Saca la etiqueta UNREAD — se llama después de procesar cada mail (ver listNewInboundMessages). */
export async function markProcessed(gmailMessageId: string): Promise<void> {
  try {
    await getGmail().users.messages.modify({
      userId: "me",
      id: gmailMessageId,
      requestBody: { removeLabelIds: ["UNREAD"] },
    });
  } catch (error) {
    logger.warn("mail.mark_processed_failed", { gmailMessageId, error: String(error) });
  }
}

export interface MailAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface SendMailInput {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  // Message-ID (header real) del mail que se está respondiendo, y la
  // cadena completa de References acumulada — para que la respuesta quede
  // bien hilada también en clientes de mail que no son Gmail.
  inReplyTo?: string;
  references?: string;
  attachments?: MailAttachment[];
}

export interface SentMail {
  gmailMessageId: string;
  threadId: string;
  rfc822MessageId?: string;
}

function buildRawMessage(input: SendMailInput): string {
  const headerLines = [
    `To: ${input.to}`,
    `From: ${config.MAIL_ADDRESS}`,
    `Subject: ${encodeMimeHeader(input.subject)}`,
    `MIME-Version: 1.0`,
  ];
  if (input.inReplyTo) headerLines.push(`In-Reply-To: ${input.inReplyTo}`);
  if (input.references) headerLines.push(`References: ${input.references}`);

  if (!input.attachments || input.attachments.length === 0) {
    return [
      ...headerLines,
      `Content-Type: text/plain; charset="UTF-8"`,
      `Content-Transfer-Encoding: base64`,
      "",
      Buffer.from(input.body, "utf-8").toString("base64"),
    ].join("\r\n");
  }

  // Con adjuntos hace falta multipart/mixed: una parte de texto y una por
  // cada adjunto, cada una en base64 y separadas por el boundary.
  const boundary = `----ismo-${Date.now().toString(36)}`;
  const parts = [
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    "",
    Buffer.from(input.body, "utf-8").toString("base64"),
  ];
  for (const att of input.attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${att.mimeType}; name="${att.filename}"`,
      `Content-Disposition: attachment; filename="${att.filename}"`,
      `Content-Transfer-Encoding: base64`,
      "",
      att.content.toString("base64"),
    );
  }
  parts.push(`--${boundary}--`);

  return [...headerLines, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", ...parts].join("\r\n");
}

export async function sendMail(input: SendMailInput): Promise<SentMail> {
  const gmail = getGmail();
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: base64url(buildRawMessage(input)), threadId: input.threadId },
  });
  logger.info("mail.sent", {
    to: input.to,
    subject: input.subject,
    threadId: res.data.threadId,
    attachmentCount: input.attachments?.length ?? 0,
  });

  // El Message-ID real (header RFC822) lo pone Gmail solo al mandar — no
  // viene en la respuesta de send(), hay que pedirlo aparte para poder
  // usarlo como In-Reply-To/References de la próxima respuesta.
  let rfc822MessageId: string | undefined;
  if (res.data.id) {
    try {
      const meta = await gmail.users.messages.get({
        userId: "me",
        id: res.data.id,
        format: "metadata",
        metadataHeaders: ["Message-ID"],
      });
      rfc822MessageId = getHeader(meta.data.payload?.headers, "Message-ID") || undefined;
    } catch (error) {
      logger.warn("mail.fetch_sent_message_id_failed", { error: String(error) });
    }
  }

  return { gmailMessageId: res.data.id ?? "", threadId: res.data.threadId ?? input.threadId ?? "", rfc822MessageId };
}
