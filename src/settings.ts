import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { logger } from "./logger.js";

export interface TokkoStage {
  // Identificador interno (lo que usa el agente al llamar a la
  // herramienta) — texto libre, sin espacios, ej. "tomar_accion".
  key: string;
  // Texto que ve el agente para entender qué significa esta etapa.
  label: string;
  // ID real de "opportunity_status" en la cuenta de Tokko.
  tokkoId?: number;
}

export interface EscalationContact {
  phone: string;
  // Motivo/categoría de este contacto (ej. "Consultas técnicas"), texto
  // libre — el agente elige a cuál avisar según el motivo de la consulta
  // (ver tools.ts#buildEscalateToHumanTool, que arma el enum de la
  // herramienta a partir de los motivos cargados acá). Vacío = comodín:
  // ese número recibe lo que no matchee ningún motivo específico.
  reason: string;
}

export interface SalesRep {
  name: string;
  // Opcional — si se carga, se usa como referencia interna (no se le manda
  // nada automáticamente a este mail, solo al del cliente).
  email: string;
  // Calendario personal de este comercial, compartido con la cuenta de
  // servicio ("Hacer cambios en los eventos") — ver docs/SETUP.md. El
  // agente chequea disponibilidad y agenda ahí, no en un calendario único.
  calendarId: string;
}

export interface CommunicationStyleOverride {
  // Nombre (o parte del nombre) de una propiedad/emprendimiento — el
  // agente decide él mismo si la conversación actual coincide, no hay
  // matching automático por código (ver orchestrator.ts#buildSystemPrompt).
  match: string;
  // Instrucciones de tono/estilo a aplicar cuando coincide.
  style: string;
}

/**
 * Configuración de negocio editable en vivo desde /admin (a diferencia de
 * lo que vive en .env, que son credenciales/infra y requieren reiniciar el
 * servidor). Se guarda en un JSON en disco — no es una base de datos real,
 * pero alcanza para un solo proceso y evita reeditar código para cambiar
 * un número de teléfono o un ID de Tokko.
 */
export interface AppSettings {
  // Números de WhatsApp (E.164) que reciben los avisos de escalate_to_human
  // / share_file, cada uno con su motivo. Ver docs/SETUP.md — no puede ser
  // un grupo, la API de WhatsApp no lo permite.
  escalationContacts: EscalationContact[];
  // Nombre del archivo en Drive que mapea nombre de propiedad -> link de
  // Zonaprop (ver findZonapropLink en drive/client.ts).
  zonapropLinksFileName: string;
  // ID de la carpeta de Drive donde buscar archivos (de la URL,
  // drive.google.com/drive/folders/ESTE_ID). Opcional: si se deja vacío,
  // busca en todo lo que la cuenta de servicio tenga compartido.
  driveFolderId?: string;
  tokko: {
    operationIdSale?: number;
    operationIdRent?: number;
    // Lista libre — se pueden agregar, sacar o renombrar etapas desde
    // /admin, no es un enum fijo (ver src/agent/tools.ts#getAgentTools,
    // que arma el enum de la herramienta a partir de esta lista).
    stages: TokkoStage[];
  };
  communicationStyle: {
    general: string;
    overrides: CommunicationStyleOverride[];
  };
  // Content SID (HX...) del template de WhatsApp aprobado para iniciar
  // conversaciones (el cliente no escribió primero) — ver
  // orchestrator.ts#initiateConversation. Sin esto, esa función no funciona.
  initiateConversationTemplateSid?: string;
  // Texto del template tal como quedó aprobado en Meta, con {{1}} (nombre)
  // y {{2}} (motivo) en el mismo orden — Twilio no devuelve el texto ya
  // renderizado al mandar un template, así que lo necesitamos acá para
  // poder dejarlo en el historial de la conversación (si no, el agente no
  // "vería" lo que el cliente recibió). Si editás el template en Twilio,
  // actualizá este texto también para que no queden desincronizados.
  initiateConversationTemplateText?: string;
  // Hora local (Argentina, 0-23) en la que se manda el resumen diario por
  // WhatsApp — ver src/scheduler.ts y src/agent/dailySummary.ts.
  dailySummaryHour: number;
  // Coordinación de visitas/reuniones por Google Calendar (ver
  // src/calendar/client.ts). Sin comerciales cargados, esas herramientas
  // no funcionan — el agente lo maneja como "todavía no hay calendario".
  visits: {
    // Un comercial por fila, cada uno con su propio calendario — el
    // agente chequea disponibilidad cruzando todos y agenda en el
    // calendario de uno que esté libre en el horario elegido.
    reps: SalesRep[];
    durationMinutes: number;
    // Horario laboral local (Argentina, 0-23) dentro del cual se ofrecen
    // y agendan horarios — mismo rango todos los días de la semana.
    businessHourStart: number;
    businessHourEnd: number;
  };
}

const SETTINGS_PATH = path.resolve(process.cwd(), "data", "settings.json");

function defaultSettings(): AppSettings {
  // La primera vez que corre, arranca con lo que ya estaba en .env (si
  // había algo) para no perder una configuración que ya funcionaba.
  const defaultStages: TokkoStage[] = [
    { key: "aun_no_contactados", label: "Aún no fueron contactados", tokkoId: config.TOKKO_STAGE_AUN_NO_CONTACTADOS },
    { key: "sin_seguimiento", label: "Sin seguimiento", tokkoId: config.TOKKO_STAGE_SIN_SEGUIMIENTO },
    { key: "contactar", label: "Contactar", tokkoId: config.TOKKO_STAGE_CONTACTAR },
    { key: "primer_contacto", label: "Primer contacto hecho", tokkoId: config.TOKKO_STAGE_PRIMER_CONTACTO },
    { key: "volver_a_contactar", label: "Volver a contactar", tokkoId: config.TOKKO_STAGE_VOLVER_A_CONTACTAR },
    { key: "evolucionando", label: "Evolucionando", tokkoId: config.TOKKO_STAGE_EVOLUCIONANDO },
    {
      key: "tomar_accion",
      label: "Tomar acción (default de contactos nuevos)",
      tokkoId: config.TOKKO_STAGE_TOMAR_ACCION,
    },
    { key: "congelado", label: "Congelado", tokkoId: config.TOKKO_STAGE_CONGELADO },
    { key: "cerrado", label: "Cerrado", tokkoId: config.TOKKO_STAGE_CERRADO },
  ];

  return {
    escalationContacts: (config.HUMAN_ESCALATION_WHATSAPP_NUMBERS ?? []).map((phone) => ({ phone, reason: "" })),
    zonapropLinksFileName: "Links Zonaprop",
    driveFolderId: undefined,
    tokko: {
      operationIdSale: config.TOKKO_OPERATION_ID_SALE,
      operationIdRent: config.TOKKO_OPERATION_ID_RENT,
      stages: defaultStages,
    },
    communicationStyle: { general: "", overrides: [] },
    initiateConversationTemplateSid: undefined,
    initiateConversationTemplateText:
      "Hola {{1}}! Somos de ismo Propiedades. Nos comentaron que estás buscando {{2}}. ¿En qué te podemos ayudar?",
    dailySummaryHour: 20,
    visits: { reps: [], durationMinutes: 30, businessHourStart: 10, businessHourEnd: 18 },
  };
}

// Completa con valores por defecto cualquier campo que falte en lo cargado
// del disco — así una config guardada antes de agregar un campo nuevo (ej.
// communicationStyle) no rompe en vez de tirar undefined más adelante.
function normalize(loaded: Partial<AppSettings>): AppSettings {
  const defaults = defaultSettings();
  // Migración: settings.json de antes de agregar el motivo por contacto
  // tenía escalationNumbers como string[] plano.
  const legacyNumbers = (loaded as unknown as { escalationNumbers?: string[] }).escalationNumbers;
  const escalationContacts =
    loaded.escalationContacts ?? legacyNumbers?.map((phone) => ({ phone, reason: "" })) ?? defaults.escalationContacts;

  // Migración: settings.json de antes de soportar varios comerciales tenía
  // visits.calendarId como un único string en vez de una lista de reps.
  const legacyVisits = loaded.visits as unknown as { calendarId?: string } | undefined;
  const visitsLoaded: Partial<AppSettings["visits"]> = loaded.visits ?? {};
  const reps =
    visitsLoaded.reps ??
    (legacyVisits?.calendarId
      ? [{ name: "Equipo", email: "", calendarId: legacyVisits.calendarId }]
      : defaults.visits.reps);

  return {
    ...defaults,
    ...loaded,
    escalationContacts,
    tokko: { ...defaults.tokko, ...loaded.tokko },
    communicationStyle: { ...defaults.communicationStyle, ...loaded.communicationStyle },
    visits: { ...defaults.visits, ...visitsLoaded, reps },
  };
}

let cache: AppSettings | null = null;

export function getSettings(): AppSettings {
  if (cache) return cache;
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8")) as Partial<AppSettings>;
      cache = normalize(loaded);
      return cache;
    } catch (error) {
      logger.error("settings.load_failed", { error: String(error) });
    }
  }
  cache = defaultSettings();
  saveSettings(cache);
  return cache;
}

export function saveSettings(settings: AppSettings): void {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  cache = settings;
}
