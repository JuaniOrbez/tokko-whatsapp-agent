/**
 * Estado de threading por dirección de mail — qué threadId de Gmail y qué
 * cadena de Message-ID (para In-Reply-To/References) le corresponde a la
 * conversación con cada cliente. En memoria, se pierde si el proceso
 * reinicia (en el peor caso, la próxima respuesta arranca un hilo nuevo en
 * vez de encadenar en el viejo — no rompe nada, solo es menos prolijo).
 */
export interface MailThreadState {
  threadId: string;
  subject: string;
  lastMessageId?: string;
  references: string[];
}

const threads = new Map<string, MailThreadState>();

function key(address: string): string {
  return address.trim().toLowerCase();
}

export function getMailThread(address: string): MailThreadState | undefined {
  return threads.get(key(address));
}

export function recordMailMessage(
  address: string,
  info: { threadId: string; subject: string; rfc822MessageId?: string },
): void {
  const existing = threads.get(key(address));
  const references = existing ? [...existing.references] : [];
  if (info.rfc822MessageId) references.push(info.rfc822MessageId);
  threads.set(key(address), {
    threadId: info.threadId,
    subject: info.subject || existing?.subject || "",
    lastMessageId: info.rfc822MessageId ?? existing?.lastMessageId,
    references,
  });
}
