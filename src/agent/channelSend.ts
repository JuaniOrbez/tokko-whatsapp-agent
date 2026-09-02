import { sendText, sendDocumentByLink } from "../whatsapp/client.js";
import { sendMail, isEmailChannelId, emailAddressFromId, type MailAttachment } from "../mail/client.js";
import { getMailThread, recordMailMessage } from "../mail/threadStore.js";

/**
 * Único lugar que decide por qué canal mandarle algo al cliente actual
 * (WhatsApp o mail, según el identificador — ver mail/client.ts) — lo usan
 * tanto orchestrator.ts (la respuesta de texto normal) como tools.ts
 * (archivos, el .ics de una visita). Vive aparte de esos dos para evitar
 * una dependencia circular (tools.ts ya lo importa orchestrator.ts).
 */

function mailSubjectFor(address: string): string {
  const thread = getMailThread(address);
  return thread?.subject ? `Re: ${thread.subject}` : "Tu consulta";
}

async function sendMailAndRecordThread(
  address: string,
  body: string,
  attachments?: MailAttachment[],
): Promise<void> {
  const thread = getMailThread(address);
  const sent = await sendMail({
    to: address,
    subject: mailSubjectFor(address),
    body,
    threadId: thread?.threadId,
    inReplyTo: thread?.lastMessageId,
    references: thread && thread.references.length > 0 ? thread.references.join(" ") : undefined,
    attachments,
  });
  recordMailMessage(address, {
    threadId: sent.threadId,
    subject: thread?.subject ?? "",
    rfc822MessageId: sent.rfc822MessageId,
  });
}

export async function sendReplyToCustomer(customerId: string, text: string): Promise<void> {
  if (!isEmailChannelId(customerId)) {
    await sendText(customerId, text);
    return;
  }
  await sendMailAndRecordThread(emailAddressFromId(customerId), text);
}

/**
 * Manda un archivo al cliente actual por el canal que corresponda. Por
 * WhatsApp alcanza con la URL pública (ver whatsapp/client.ts#sendDocumentByLink);
 * por mail hace falta el contenido en bytes para adjuntarlo de verdad — si
 * no hay (ej. un Doc/Sheet nativo de Google, que no se puede bajar tal
 * cual, ver drive/client.ts#downloadFileBytes), cae a mandar el link como
 * texto en el cuerpo del mail en vez de fallar.
 */
export async function sendFileToCustomer(
  customerId: string,
  caption: string,
  file: { filename: string; url: string; mimeType?: string; content?: Buffer },
): Promise<void> {
  if (!isEmailChannelId(customerId)) {
    await sendDocumentByLink(customerId, file.url, file.filename, caption);
    return;
  }
  const address = emailAddressFromId(customerId);
  if (file.content) {
    await sendMailAndRecordThread(address, caption, [
      { filename: file.filename, mimeType: file.mimeType ?? "application/octet-stream", content: file.content },
    ]);
  } else {
    await sendMailAndRecordThread(address, `${caption}\n\n${file.url}`);
  }
}
