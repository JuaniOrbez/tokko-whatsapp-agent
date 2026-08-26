import { google } from "googleapis";
import { config } from "../config.js";
import { getSettings } from "../settings.js";
import type { SalesRep } from "../settings.js";

/**
 * Coordinación de visitas/reuniones contra Google Calendar, con la misma
 * cuenta de servicio que ya usa Drive (ver docs/SETUP.md) — cada comercial
 * comparte su propio calendario con esa cuenta ("Hacer cambios en los
 * eventos") y se carga en /admin. El agente cruza la disponibilidad de
 * todos y agenda en el calendario de uno que esté libre.
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

interface BusyRange {
  start: Date;
  end: Date;
}

async function getBusyRanges(calendarId: string, from: Date, to: Date): Promise<BusyRange[]> {
  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      timeZone: TIME_ZONE,
      items: [{ id: calendarId }],
    },
  });
  return (fb.data.calendars?.[calendarId]?.busy ?? [])
    .filter((b) => b.start && b.end)
    .map((b) => ({ start: new Date(b.start!), end: new Date(b.end!) }));
}

/**
 * Franjas libres para `dateStr` (YYYY-MM-DD, hora Argentina), recortadas al
 * horario laboral configurado en /admin y de a `durationMinutes`. Un
 * horario cuenta como libre si AL MENOS UN comercial no tiene nada ese
 * rato — la asignación a un comercial puntual se resuelve recién al
 * agendar (ver bookVisit). Devuelve [] si no hay comerciales cargados, o
 * si la fecha no tiene horario laboral válido (fin <= inicio).
 */
export async function getAvailableSlots(dateStr: string): Promise<string[]> {
  const settings = getSettings().visits;
  if (settings.reps.length === 0) return [];

  const dayStart = argentinaLocalToUtc(dateStr, settings.businessHourStart, 0);
  const dayEnd = argentinaLocalToUtc(dateStr, settings.businessHourEnd, 0);
  if (dayEnd <= dayStart) return [];

  const busyByRep = await Promise.all(settings.reps.map((rep) => getBusyRanges(rep.calendarId, dayStart, dayEnd)));

  const durationMs = settings.durationMinutes * 60 * 1000;
  const slots: string[] = [];
  for (let t = dayStart.getTime(); t + durationMs <= dayEnd.getTime(); t += durationMs) {
    const slotStart = new Date(t);
    const slotEnd = new Date(t + durationMs);
    // No ofrece horarios ya pasados si dateStr es hoy.
    if (slotEnd.getTime() <= Date.now()) continue;
    const anyRepFree = busyByRep.some((busy) => !busy.some((b) => slotStart < b.end && slotEnd > b.start));
    if (anyRepFree) slots.push(formatArgentinaTime(slotStart));
  }
  return slots;
}

/** Primer comercial (en el orden cargado en /admin) libre en ese horario puntual, o null si ninguno lo está. */
async function findFreeRep(start: Date, end: Date): Promise<SalesRep | null> {
  const settings = getSettings().visits;
  for (const rep of settings.reps) {
    const busy = await getBusyRanges(rep.calendarId, start, end);
    const overlaps = busy.some((b) => start < b.end && end > b.start);
    if (!overlaps) return rep;
  }
  return null;
}

export interface BookVisitInput {
  dateStr: string; // YYYY-MM-DD, hora Argentina
  time: string; // HH:mm, hora Argentina
  summary: string;
  description: string;
  // Si se carga, se invita a esta dirección al evento (Calendar le manda
  // la invitación directo) — opcional, el cliente puede no querer darlo.
  clientEmail?: string;
}

export interface BookVisitResult {
  eventId: string;
  htmlLink?: string;
  repName: string;
}

/**
 * Agenda el evento en el calendario de un comercial libre en ese horario.
 * Tira si no hay comerciales configurados, si ninguno está libre, o si
 * Calendar devuelve un error (fecha/hora inválida, etc.) — el llamador
 * decide qué responderle al cliente.
 */
export async function bookVisit(input: BookVisitInput): Promise<BookVisitResult> {
  const settings = getSettings().visits;
  if (settings.reps.length === 0) {
    throw new Error("No hay ningún comercial con calendario configurado (ver /admin).");
  }
  const [hourStr, minuteStr] = input.time.split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr ?? "0");
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    throw new Error(`Hora inválida: "${input.time}"`);
  }
  const start = argentinaLocalToUtc(input.dateStr, hour, minute);
  const end = new Date(start.getTime() + settings.durationMinutes * 60 * 1000);

  const rep = await findFreeRep(start, end);
  if (!rep) {
    throw new Error("Ya no queda ningún comercial libre en ese horario.");
  }

  const res = await calendar.events.insert({
    calendarId: rep.calendarId,
    sendUpdates: input.clientEmail ? "all" : undefined,
    requestBody: {
      summary: input.summary,
      description: input.description,
      start: { dateTime: start.toISOString(), timeZone: TIME_ZONE },
      end: { dateTime: end.toISOString(), timeZone: TIME_ZONE },
      attendees: input.clientEmail ? [{ email: input.clientEmail }] : undefined,
    },
  });

  return { eventId: res.data.id ?? "", htmlLink: res.data.htmlLink ?? undefined, repName: rep.name };
}
