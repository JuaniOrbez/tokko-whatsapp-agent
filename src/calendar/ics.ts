/**
 * Genera un archivo .ics (RFC 5545) para un evento puntual — se manda como
 * adjunto de WhatsApp al cliente para que se cargue solo en el calendario
 * que use (Google, iPhone, Outlook, el que sea), sin depender de que
 * Google mande una invitación por mail (no funciona de forma confiable
 * desde una cuenta de servicio sobre un Gmail personal, sin Google
 * Workspace).
 */
function icsEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\n/g, "\\n");
}

function formatIcsDate(d: Date): string {
  return `${d.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}

// RFC 5545 exige "plegar" líneas de más de 75 octetos: cortarlas con
// CRLF + un espacio al principio de la continuación. Algunos parsers
// (sobre todo en el celular) son estrictos con esto — una DESCRIPTION
// larga sin plegar puede hacer que el archivo entero se descarte.
function foldLine(line: string): string {
  const MAX = 75;
  if (line.length <= MAX) return line;
  const chunks: string[] = [];
  let rest = line;
  while (rest.length > MAX) {
    chunks.push(rest.slice(0, MAX));
    rest = rest.slice(MAX);
  }
  chunks.push(rest);
  return chunks.join("\r\n ");
}

export function buildIcsEvent(input: {
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  description: string;
  organizerEmail?: string;
}): string {
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
    "STATUS:CONFIRMED",
    "SEQUENCE:0",
    "TRANSP:OPAQUE",
    ...(input.organizerEmail ? [`ORGANIZER:mailto:${input.organizerEmail}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
