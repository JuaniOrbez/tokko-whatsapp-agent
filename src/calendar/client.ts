import { google } from "googleapis";
import { config } from "../config.js";
import { getSettings } from "../settings.js";

/**
 * Coordinación de visitas/reuniones contra Google Calendar, con la misma
 * cuenta de servicio que ya usa Drive (ver docs/SETUP.md) — hay que
 * compartir un calendario con esa cuenta ("Hacer cambios en los eventos")
 * y cargar su ID en /admin.
 */
const auth = new google.auth.GoogleAuth({
  keyFile: config.GOOGLE_SERVICE_ACCOUNT_FILE,
  scopes: ["https://www.googleapis.com/auth/calendar"],
});

const calendar = google.calendar({ version: "v3", auth });

const ARGENTINA_UTC_OFFSET_HOURS = 3;
const TIME_ZONE = "America/Argentina/Buenos_Aires";

/** `dateStr` (YYYY-MM-DD) + hora/minuto en hora Argentina -> Date UTC real. */
function argentinaLocalToUtc(dateStr: string, hour: number, minute: number): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour + ARGENTINA_UTC_OFFSET_HOURS, minute, 0));
}

function formatArgentinaTime(d: Date): string {
  const local = new Date(d.getTime() - ARGENTINA_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  return `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * Franjas libres para `dateStr` (YYYY-MM-DD, hora Argentina), recortadas al
 * horario laboral configurado en /admin y de a `durationMinutes`. Devuelve
 * [] si no hay calendario configurado, o si la fecha no tiene horario
 * laboral válido (fin <= inicio).
 */
export async function getAvailableSlots(dateStr: string): Promise<string[]> {
  const settings = getSettings().visits;
  if (!settings.calendarId) return [];

  const dayStart = argentinaLocalToUtc(dateStr, settings.businessHourStart, 0);
  const dayEnd = argentinaLocalToUtc(dateStr, settings.businessHourEnd, 0);
  if (dayEnd <= dayStart) return [];

  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      timeZone: TIME_ZONE,
      items: [{ id: settings.calendarId }],
    },
  });
  const busy = (fb.data.calendars?.[settings.calendarId]?.busy ?? [])
    .filter((b) => b.start && b.end)
    .map((b) => ({ start: new Date(b.start!), end: new Date(b.end!) }));

  const durationMs = settings.durationMinutes * 60 * 1000;
  const slots: string[] = [];
  for (let t = dayStart.getTime(); t + durationMs <= dayEnd.getTime(); t += durationMs) {
    const slotStart = new Date(t);
    const slotEnd = new Date(t + durationMs);
    // No ofrece horarios ya pasados si dateStr es hoy.
    if (slotEnd.getTime() <= Date.now()) continue;
    const overlaps = busy.some((b) => slotStart < b.end && slotEnd > b.start);
    if (!overlaps) slots.push(formatArgentinaTime(slotStart));
  }
  return slots;
}

export interface BookVisitInput {
  dateStr: string; // YYYY-MM-DD, hora Argentina
  time: string; // HH:mm, hora Argentina
  summary: string;
  description: string;
}

export interface BookVisitResult {
  eventId: string;
  htmlLink?: string;
}

/**
 * Agenda el evento en el calendario configurado. Tira si no hay calendario
 * configurado o si Calendar devuelve un error (fecha/hora inválida, etc.) —
 * el llamador decide qué responderle al cliente.
 */
export async function bookVisit(input: BookVisitInput): Promise<BookVisitResult> {
  const settings = getSettings().visits;
  if (!settings.calendarId) {
    throw new Error("No hay calendario de visitas configurado (ver /admin).");
  }
  const [hourStr, minuteStr] = input.time.split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr ?? "0");
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    throw new Error(`Hora inválida: "${input.time}"`);
  }
  const start = argentinaLocalToUtc(input.dateStr, hour, minute);
  const end = new Date(start.getTime() + settings.durationMinutes * 60 * 1000);

  const res = await calendar.events.insert({
    calendarId: settings.calendarId,
    requestBody: {
      summary: input.summary,
      description: input.description,
      start: { dateTime: start.toISOString(), timeZone: TIME_ZONE },
      end: { dateTime: end.toISOString(), timeZone: TIME_ZONE },
    },
  });

  return { eventId: res.data.id ?? "", htmlLink: res.data.htmlLink ?? undefined };
}
