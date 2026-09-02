import { config } from "../config.js";
import { logger } from "../logger.js";
import { isMailEnabled, listNewInboundMessages, markProcessed, toEmailChannelId } from "./client.js";
import { recordMailMessage } from "./threadStore.js";
import { handleIncomingMessage } from "../agent/orchestrator.js";

/**
 * Revisa la casilla configurada (MAIL_ADDRESS) cada MAIL_POLL_INTERVAL_SECONDS
 * en busca de mails nuevos, y cada uno entra al mismo agente que ya
 * atiende WhatsApp — ver orchestrator.ts#handleIncomingMessage, que
 * distingue el canal por el identificador ("email:..." vs un teléfono).
 * No usa notificaciones push de Gmail (más rápido pero necesita Pub/Sub e
 * infraestructura de Google Cloud aparte) — con esto alcanza para el
 * volumen de una sola inmobiliaria.
 */
async function pollOnce(): Promise<void> {
  const messages = await listNewInboundMessages();
  for (const mail of messages) {
    try {
      recordMailMessage(mail.from, {
        threadId: mail.threadId,
        subject: mail.subject,
        rfc822MessageId: mail.rfc822MessageId,
      });
      const text = mail.subject ? `${mail.subject}\n\n${mail.bodyText}` : mail.bodyText;
      await handleIncomingMessage({
        from: toEmailChannelId(mail.from),
        name: mail.fromName,
        text,
        channel: "Mail",
      });
    } catch (error) {
      logger.error("mail.process_failed", { from: mail.from, error: String(error) });
    } finally {
      // Se marca leído incluso si el procesamiento falló — evita un loop de
      // reintentos infinito sobre el mismo mail roto; el error ya quedó
      // logueado arriba para poder revisarlo a mano.
      await markProcessed(mail.gmailMessageId);
    }
  }
}

export function startMailPoller(): void {
  if (!isMailEnabled()) return;
  logger.info("mail.poller_started", { address: config.MAIL_ADDRESS, intervalSeconds: config.MAIL_POLL_INTERVAL_SECONDS });

  const tick = (): void => {
    pollOnce()
      .catch((error) => logger.error("mail.poll_failed", { error: String(error) }))
      .finally(() => setTimeout(tick, config.MAIL_POLL_INTERVAL_SECONDS * 1000));
  };
  tick();
}
