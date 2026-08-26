/**
 * Genera un archivo .ics (RFC 5545) mínimo para un evento puntual — se
 * manda como adjunto de WhatsApp al cliente para que se cargue solo en el
 * calendario que use (Google, iPhone, Outlook, el que sea), sin depender
 * de que Google mande una invitación por mail (no funciona de forma
 * confiable desde una cuenta de servicio sobre un Gmail personal, sin
 * Google Workspace).
 */
function icsEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\n/g, "\\n");
}

function formatIcsDate(d: Date): string {
  return `${d.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}

export function buildIcsEvent(input: { uid: string; start: Date; end: Date; summary: string; description: string }): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ismo Propiedades//Visita//ES",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${input.uid}`,
    `DTSTAMP:${formatIcsDate(new Date())}`,
    `DTSTART:${formatIcsDate(input.start)}`,
    `DTEND:${formatIcsDate(input.end)}`,
    `SUMMARY:${icsEscape(input.summary)}`,
    `DESCRIPTION:${icsEscape(input.description)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.join("\r\n")}\r\n`;
}
