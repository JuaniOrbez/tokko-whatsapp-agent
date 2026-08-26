import crypto from "node:crypto";
import { google } from "googleapis";
import { config } from "../config.js";
import { getSettings } from "../settings.js";
import type { TeamMember } from "../settings.js";
import { buildIcsEvent } from "./ics.js";

/**
 * Coordinación de visitas/reuniones contra Google Calendar, con la misma
 * cuenta de servicio que ya usa Drive (ver docs/SETUP.md) — cada miembro
 * del equipo que participa de visitas comparte su propio calendario con
 * esa cuenta ("Hacer cambios en los eventos") y se carga en /admin. El
 * agente cruza la disponibilidad de todos (o de uno puntual, si el
 * cliente lo pidió por nombre) y agenda en el calendario de uno que esté
 * libre.
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

// Día de la semana de una fecha calendario (0 = domingo .. 6 = sábado) —
// no depende de huso horario, es una propiedad de la fecha en sí.
function weekdayOf(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Miembros del equipo que tienen calendario cargado — los únicos que participan de la coordinación de visitas. */
function visitReps(): TeamMember[] {
  return getSettings().team.filter((m) => m.calendarId);
}

function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/** Todos los del equipo (con calendario) que matchean `name` (sin importar acentos/mayúsculas, alcanza con que uno contenga al otro) — puede haber más de uno si hay nombres repetidos, ver docs/SETUP.md. */
export function findMatchingReps(name: string): TeamMember[] {
  const target = normalizeName(name);
  return visitReps().filter((r) => {
    const repName = normalizeName(r.name);
    return repName.includes(target) || target.includes(repName);
  });
}

/** Único match para `name` — undefined si no hay ninguno, o si hay más de uno (ambiguo). */
export function findRepByName(name: string): TeamMember | undefined {
  const matches = findMatchingReps(name);
  return matches.length === 1 ? matches[0] : undefined;
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
 * horario y los días laborales configurados en /admin, y de a
 * `durationMinutes`. Sin `repName`, un horario cuenta como libre si AL
 * MENOS UNA persona no tiene nada ese rato (la asignación puntual se
 * resuelve recién al agendar, ver bookVisit); con `repName`, solo mira su
 * calendario. Devuelve [] si no hay nadie con calendario cargado (o no se
 * encuentra el nombre pedido), si ese día de la semana no es laboral, o si
 * el horario configurado no es válido (fin <= inicio).
 */
export async function getAvailableSlots(dateStr: string, repName?: string): Promise<string[]> {
  const settings = getSettings().visits;
  if (!settings.businessDays.includes(weekdayOf(dateStr))) return [];

  const reps = repName ? [findRepByName(repName)].filter((r): r is TeamMember => Boolean(r)) : visitReps();
  if (reps.length === 0) return [];

  const dayStart = argentinaLocalToUtc(dateStr, settings.businessHourStart, 0);
  const dayEnd = argentinaLocalToUtc(dateStr, settings.businessHourEnd, 0);
  if (dayEnd <= dayStart) return [];

  const busyByRep = await Promise.all(reps.map((rep) => getBusyRanges(rep.calendarId, dayStart, dayEnd)));

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

/** Primer miembro de `reps` (en ese orden) libre en ese horario puntual, o null si ninguno lo está. */
async function findFreeRepAmong(reps: TeamMember[], start: Date, end: Date): Promise<TeamMember | null> {
  for (const rep of reps) {
    const busy = await getBusyRanges(rep.calendarId, start, end);
    const overlaps = busy.some((b) => start < b.end && end > b.start);
    if (!overlaps) return rep;
  }
  return null;
}

export interface BookVisitInput {
  customerPhone: string;
  dateStr: string; // YYYY-MM-DD, hora Argentina
  time: string; // HH:mm, hora Argentina
  summary: string;
  description: string;
  // Si el cliente pidió a alguien puntual por nombre — si no está libre
  // (o no se encuentra), bookVisit tira en vez de asignarle a otro sin
  // avisar.
  repName?: string;
}

interface LastBooking {
  eventId: string;
  calendarId: string;
  repName: string;
  repPhone: string;
  dateStr: string;
  time: string;
  summary: string;
  description: string;
}

// Última visita agendada por cliente (en memoria, se pierde si el proceso
// reinicia) — permite que rescheduleVisit mueva ESE evento en vez de crear
// uno nuevo. Si un cliente llegó a tener más de una visita agendada en la
// conversación, solo se puede reprogramar la más reciente.
const lastBookings = new Map<string, LastBooking>();

export interface BookVisitResult {
  eventId: string;
  htmlLink?: string;
  repName: string;
  // Vacío si esa persona no cargó teléfono — el llamador decide si avisa
  // por WhatsApp o no.
  repPhone: string;
  // .ics del evento (RFC 5545) — el llamador decide cómo mandárselo al
  // cliente (ver tools.ts, que lo sube y lo manda como adjunto de
  // WhatsApp). No se usa la invitación por mail de Calendar: con una
  // cuenta de servicio sobre un Gmail personal (sin Google Workspace),
  // Calendar acepta el attendee pero no manda el mail de invitación.
  icsContent: string;
}

/**
 * Agenda el evento en el calendario de alguien del equipo libre en ese
 * horario. Tira si no hay nadie con calendario configurado, si ese día de
 * la semana no es laboral, si `repName` no matchea a nadie (o matchea a
 * más de uno), si nadie (o la persona pedida puntualmente) está libre, o
 * si Calendar devuelve un error (fecha/hora inválida, etc.) — el llamador
 * decide qué responderle al cliente.
 */
export async function bookVisit(input: BookVisitInput): Promise<BookVisitResult> {
  const settings = getSettings().visits;
  const allReps = visitReps();
  if (allReps.length === 0) {
    throw new Error("No hay nadie del equipo con calendario configurado (ver /admin).");
  }
  if (!settings.businessDays.includes(weekdayOf(input.dateStr))) {
    throw new Error(`${input.dateStr} no es un día laboral configurado para coordinar visitas.`);
  }
  const [hourStr, minuteStr] = input.time.split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr ?? "0");
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    throw new Error(`Hora inválida: "${input.time}"`);
  }
  const start = argentinaLocalToUtc(input.dateStr, hour, minute);
  const end = new Date(start.getTime() + settings.durationMinutes * 60 * 1000);

  let candidateReps = allReps;
  if (input.repName) {
    const matches = findMatchingReps(input.repName);
    if (matches.length === 0) {
      throw new Error(`No encontré a "${input.repName}" entre el equipo cargado.`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Hay más de una persona que coincide con "${input.repName}" (${matches.map((r) => r.name).join(", ")}) — pedile al cliente que aclare cuál, con el apellido si hace falta.`,
      );
    }
    candidateReps = matches;
  }

  const rep = await findFreeRepAmong(candidateReps, start, end);
  if (!rep) {
    throw new Error(
      input.repName ? `${input.repName} ya no está libre en ese horario.` : "Ya no queda nadie libre en ese horario.",
    );
  }

  const res = await calendar.events.insert({
    calendarId: rep.calendarId,
    requestBody: {
      summary: input.summary,
      description: input.description,
      start: { dateTime: start.toISOString(), timeZone: TIME_ZONE },
      end: { dateTime: end.toISOString(), timeZone: TIME_ZONE },
    },
  });

  const eventId = res.data.id ?? "";
  const icsContent = buildIcsEvent({
    uid: `${eventId || crypto.randomUUID()}@ismo-propiedades`,
    start,
    end,
    summary: input.summary,
    description: input.description,
    organizerEmail: rep.email || undefined,
  });

  lastBookings.set(input.customerPhone, {
    eventId,
    calendarId: rep.calendarId,
    repName: rep.name,
    repPhone: rep.phone,
    dateStr: input.dateStr,
    time: input.time,
    summary: input.summary,
    description: input.description,
  });

  return {
    eventId,
    htmlLink: res.data.htmlLink ?? undefined,
    repName: rep.name,
    repPhone: rep.phone,
    icsContent,
  };
}

export interface RescheduleVisitInput {
  customerPhone: string;
  dateStr: string; // YYYY-MM-DD, hora Argentina
  time: string; // HH:mm, hora Argentina
}

export interface RescheduleVisitResult {
  eventId: string;
  repName: string;
  repPhone: string;
  icsContent: string;
  previousDateStr: string;
  previousTime: string;
}

/**
 * Mueve la última visita agendada con este cliente (ver lastBookings) a una
 * fecha/hora nueva, en vez de crear un evento aparte — mismo comercial,
 * mismo eventId de Calendar. Tira si no hay ninguna visita previa
 * registrada para este cliente, si la fecha/hora nueva no es válida, o si
 * el comercial ya no está libre a esa hora.
 */
export async function rescheduleVisit(input: RescheduleVisitInput): Promise<RescheduleVisitResult> {
  const previous = lastBookings.get(input.customerPhone);
  if (!previous) {
    throw new Error("No encontré ninguna visita agendada con este cliente para reprogramar.");
  }
  const settings = getSettings().visits;
  if (!settings.businessDays.includes(weekdayOf(input.dateStr))) {
    throw new Error(`${input.dateStr} no es un día laboral configurado para coordinar visitas.`);
  }
  const [hourStr, minuteStr] = input.time.split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr ?? "0");
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    throw new Error(`Hora inválida: "${input.time}"`);
  }
  const start = argentinaLocalToUtc(input.dateStr, hour, minute);
  const end = new Date(start.getTime() + settings.durationMinutes * 60 * 1000);

  // No excluye el propio evento del chequeo (freebusy no da IDs, solo
  // franjas) — en la práctica no es problema porque la fecha/hora nueva
  // casi siempre difiere de la vieja; si coincidieran, el propio evento se
  // vería como "ocupado" y bloquearía el reschedule sin necesidad.
  const busy = await getBusyRanges(previous.calendarId, start, end);
  const overlapsBusy = busy.some((b) => start < b.end && end > b.start);
  if (overlapsBusy) {
    throw new Error(`${previous.repName} ya no está libre en ese horario.`);
  }

  await calendar.events.patch({
    calendarId: previous.calendarId,
    eventId: previous.eventId,
    requestBody: {
      start: { dateTime: start.toISOString(), timeZone: TIME_ZONE },
      end: { dateTime: end.toISOString(), timeZone: TIME_ZONE },
    },
  });

  const rep = getSettings().team.find((m) => m.name === previous.repName);
  const icsContent = buildIcsEvent({
    uid: `${previous.eventId}@ismo-propiedades`,
    start,
    end,
    summary: previous.summary,
    description: previous.description,
    organizerEmail: rep?.email || undefined,
  });

  lastBookings.set(input.customerPhone, { ...previous, dateStr: input.dateStr, time: input.time });

  return {
    eventId: previous.eventId,
    repName: previous.repName,
    repPhone: previous.repPhone,
    icsContent,
    previousDateStr: previous.dateStr,
    previousTime: previous.time,
  };
}
