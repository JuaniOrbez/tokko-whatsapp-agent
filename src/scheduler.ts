import { getSettings } from "./settings.js";
import { generateAndSendDailySummary } from "./agent/dailySummary.js";
import { logger } from "./logger.js";

// Sin dependencias nuevas (nada de node-cron): alcanza con calcular cuánto
// falta para la próxima hora configurada y usar un setTimeout que se
// vuelve a programar solo después de cada disparo.
const ARGENTINA_UTC_OFFSET_HOURS = 3;

function msUntilNextRun(hourArt: number): number {
  const now = new Date();
  const artNow = new Date(now.getTime() - ARGENTINA_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  const target = new Date(
    Date.UTC(
      artNow.getUTCFullYear(),
      artNow.getUTCMonth(),
      artNow.getUTCDate(),
      hourArt + ARGENTINA_UTC_OFFSET_HOURS,
      0,
      0,
      0,
    ),
  );
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.getTime() - now.getTime();
}

function scheduleNext(): void {
  // Lee la hora configurada recién al programar cada disparo — si se
  // cambia desde /admin, el próximo día ya toma el valor nuevo.
  const hour = getSettings().dailySummaryHour;
  const delay = msUntilNextRun(hour);
  logger.info("scheduler.daily_summary_scheduled", { hour, delayMs: delay });

  setTimeout(() => {
    generateAndSendDailySummary()
      .catch((error) => logger.error("scheduler.daily_summary_failed", { error: String(error) }))
      .finally(scheduleNext);
  }, delay);
}

export function startScheduler(): void {
  scheduleNext();
}
