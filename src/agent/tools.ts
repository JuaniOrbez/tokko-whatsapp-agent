import type Anthropic from "@anthropic-ai/sdk";
import { tokkoClient } from "../tokko/client.js";
import { findFilesByName, findZonapropLink, getZonapropLinks } from "../drive/client.js";
import { sendDocumentByLink, sendText } from "../whatsapp/client.js";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { getSettings } from "../settings.js";
import { escalateToHumans } from "./escalation.js";
import { appendToolUsage } from "./toolUsageLog.js";
import { getAvailableSlots, bookVisit, rescheduleVisit, findMatchingReps } from "../calendar/client.js";
import { storeIcs } from "../calendar/icsStore.js";
import { appendStageLog } from "./stageLog.js";
import { appendTierLog } from "./tierLog.js";

/**
 * Prioriza el link de Zonaprop (planilla en Drive) sobre el link propio de
 * Tokko — pedido explícito: los links que comparte el agente tienen que
 * ser de Zonaprop, el de Tokko queda solo como respaldo si esa unidad
 * puntual todavía no está cargada en la planilla. `queries` son los textos
 * por los que probar en la planilla, en orden (ej. título de la
 * publicación y después la dirección) — gana el primero que matchee algo
 * (ver findZonapropLink, matchea en cualquier sentido: sirve tanto si la
 * planilla tiene el número de unidad como si tiene el nombre completo).
 * Un candidato vacío se salta (una búsqueda vacía matchearía cualquier
 * línea).
 */
async function resolveListingUrl(
  queries: (string | undefined)[],
  tokkoFallback: string | undefined,
): Promise<string | undefined> {
  const tried = queries.filter((q): q is string => Boolean(q?.trim()));
  for (const query of tried) {
    const zonapropLink = await findZonapropLink(query);
    if (zonapropLink) return zonapropLink;
  }
  // Si había candidatos para probar pero ninguno matcheó nada en la
  // planilla, lo logueamos — si esto pasa seguido puede ser que el
  // identificador de la unidad en Drive no aparezca tal cual en el
  // título/dirección de Tokko (formato distinto, ausente, etc.).
  if (tried.length > 0) {
    const zonapropEntries = await getZonapropLinks();
    if (zonapropEntries.length > 0) {
      logger.info("drive.zonaprop_no_match", {
        tried,
        zonapropEntryNames: zonapropEntries.map((e) => e.name),
      });
    }
  }
  return tokkoFallback || undefined;
}

export interface AgentContext {
  customerPhone: string;
  customerName: string;
  // id real solo si el contacto YA existía en Tokko (encontrado por
  // teléfono). Un contacto nuevo no tiene id todavía: queda como "Consulta"
  // pendiente de aprobación manual en Tokko (ver orchestrator.ts).
  contactId: number | null;
}

/**
 * Arma la herramienta update_opportunity_stage a partir de las etapas
 * configuradas en /admin — la lista es libre (se pueden agregar/sacar
 * etapas ahí), así que el enum/descripción no puede ser estático.
 */
function buildUpdateStageTool(): Anthropic.Tool {
  const stages = getSettings().tokko.stages.filter((s) => s.key && s.tokkoId !== undefined);
  const enumValues = stages.map((s) => s.key);
  const description = stages.length > 0 ? stages.map((s) => `${s.key}: ${s.label}`).join(". ") : undefined;

  return {
    name: "update_opportunity_stage",
    description:
      "Anota qué etapa del workflow de Oportunidades le corresponde al contacto actual, según cómo " +
      "va la conversación — Tokko no permite escribir esto por API (no es un tema de permisos, " +
      "confirmado con ellos: su API no es bidireccional), así que queda registrado para que alguien " +
      "del equipo lo revise en /admin/contacts y lo aplique a mano en Tokko. Usala cuando la " +
      "conversación deje claro un cambio real de etapa — no la uses en cada mensaje.",
    input_schema: {
      type: "object",
      properties: {
        stage: {
          type: "string",
          ...(enumValues.length > 0 ? { enum: enumValues } : {}),
          description: description ?? "No hay ninguna etapa configurada todavía (ver /admin).",
        },
        reason: { type: "string", description: "Motivo breve del cambio de etapa." },
      },
      required: ["stage"],
    },
  };
}

const STATIC_TOOLS_BEFORE_STAGE: Anthropic.Tool[] = [
  {
    name: "search_properties",
    description:
      "Busca propiedades publicadas en Tokko según operación, ubicación, precio y ambientes. " +
      "Usala antes de afirmar cualquier dato de una propiedad: nunca inventes precios, " +
      "direcciones ni características.",
    input_schema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["venta", "alquiler"],
          description: "Tipo de operación que busca el cliente.",
        },
        location: { type: "string", description: "Zona, barrio o ciudad (texto libre)." },
        price_min: { type: "number" },
        price_max: { type: "number" },
        currency: { type: "string", enum: ["USD", "ARS"], default: "USD" },
        rooms_min: { type: "number", description: "Cantidad mínima de ambientes." },
      },
      required: [],
    },
  },
  {
    name: "search_developments",
    description:
      "Busca emprendimientos (proyectos/edificios en desarrollo) por nombre comercial o " +
      "dirección. Usala cuando el cliente pregunte por el nombre de un proyecto (ej. \"La " +
      "Vecindad\", \"Torres del Parque\") en vez de una zona genérica — así confirmás el nombre " +
      "comercial real antes de decir que no figura en el sistema.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Nombre del emprendimiento o parte de la dirección." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_development_details",
    description:
      "Trae el detalle completo de un emprendimiento por ID: descripción, dirección/ubicación, " +
      "link de la publicación y cantidad de fotos. Usala cuando el cliente pida más información, " +
      "la descripción, o el link de un emprendimiento que ya identificaste con search_developments.",
    input_schema: {
      type: "object",
      properties: {
        development_id: { type: "number" },
      },
      required: ["development_id"],
    },
  },
  {
    name: "get_zonaprop_link",
    description:
      "Busca el link de Zonaprop de una propiedad o emprendimiento por nombre — normalmente no hace " +
      "falta llamarla aparte, porque search_properties/search_developments/get_development_details ya " +
      "devuelven el link de Zonaprop en 'url' cuando está cargado en Drive. Usala solo si necesitás " +
      "buscar el link de algo puntual por nombre, fuera de esos resultados (ej. el cliente menciona " +
      "una unidad específica que no salió en la búsqueda).",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nombre de la propiedad o emprendimiento." },
      },
      required: ["name"],
    },
  },
  {
    name: "get_property_details",
    description: "Trae el detalle completo (descripción, fotos, superficie) de una propiedad por ID.",
    input_schema: {
      type: "object",
      properties: {
        property_id: { type: "number" },
      },
      required: ["property_id"],
    },
  },
  {
    name: "share_file",
    description:
      "Busca un archivo en Google Drive (folletos, planos, fichas, listados) por palabras clave " +
      "y lo envía directamente como adjunto por WhatsApp al cliente actual.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Palabras clave del archivo a buscar y enviar." },
      },
      required: ["query"],
    },
  },
];

/**
 * Arma check_visit_availability/book_visit con un enum de "rep_name" a
 * partir de los comerciales cargados en /admin — mismo patrón que
 * buildUpdateStageTool, así el agente elige entre nombres reales en vez de
 * inventar uno.
 */
function buildVisitTools(): Anthropic.Tool[] {
  const repNames = getSettings()
    .team.filter((m) => m.calendarId)
    .map((r) => r.name);
  const repNameProperty = {
    type: "string" as const,
    ...(repNames.length > 0 ? { enum: repNames } : {}),
    description:
      repNames.length > 0
        ? "Si el cliente pidió específicamente a uno de estos comerciales, cuál — si no pidió a nadie en " +
          "particular, no mandes este campo."
        : "No hay comerciales cargados todavía (ver /admin).",
  };

  return [
    {
      name: "check_visit_availability",
      description:
        "Consulta los horarios libres para coordinar una visita o reunión en una fecha puntual, " +
        "según los calendarios y el horario laboral configurados en /admin. Usala siempre antes de " +
        "proponerle un horario al cliente — nunca inventes disponibilidad.",
      input_schema: {
        type: "object",
        properties: {
          date: { type: "string", description: 'Fecha en formato YYYY-MM-DD (hora Argentina), ej. "2026-08-27".' },
          rep_name: repNameProperty,
        },
        required: ["date"],
      },
    },
    {
      name: "book_visit",
      description:
        "Agenda una visita o reunión con el cliente actual en el calendario de un comercial libre en " +
        "ese horario, en un horario que ya confirmaste como libre con check_visit_availability. No la " +
        "uses sin haber confirmado antes la disponibilidad, ni sin que el cliente haya confirmado el " +
        "horario. Al agendar, el cliente recibe automáticamente un archivo de calendario por WhatsApp " +
        "para agregar el evento a su calendario — no hace falta pedirle ningún dato para eso.",
      input_schema: {
        type: "object",
        properties: {
          date: { type: "string", description: 'Fecha en formato YYYY-MM-DD (hora Argentina).' },
          time: { type: "string", description: 'Hora en formato HH:mm (hora Argentina), ej. "15:30".' },
          notes: {
            type: "string",
            description:
              "Sobre qué es la visita/reunión: propiedad o emprendimiento puntual (con dirección si la " +
              "tenés) o el tema a tratar. Preguntaselo al cliente antes de agendar si todavía no surgió " +
              "en la charla — el comercial lo necesita para llegar preparado.",
          },
          rep_name: repNameProperty,
        },
        required: ["date", "time", "notes"],
      },
    },
    {
      name: "reschedule_visit",
      description:
        "Cambia la fecha/hora de la visita o reunión que ya quedó agendada con este cliente en esta " +
        "conversación (la última que se agendó, si hubo más de una). Usala en vez de book_visit cuando " +
        "el cliente pida reprogramar algo que ya estaba confirmado — mueve el mismo evento en el " +
        "calendario del comercial en vez de crear uno nuevo, y le manda al cliente un archivo de " +
        "calendario actualizado. Confirmá primero la nueva disponibilidad con check_visit_availability, " +
        "igual que al agendar por primera vez (pasando el mismo rep_name, si el comercial ya asignado " +
        "aparece ahí).",
      input_schema: {
        type: "object",
        properties: {
          date: { type: "string", description: 'Nueva fecha en formato YYYY-MM-DD (hora Argentina).' },
          time: { type: "string", description: 'Nueva hora en formato HH:mm (hora Argentina), ej. "15:30".' },
        },
        required: ["date", "time"],
      },
    },
  ];
}

/**
 * Arma la herramienta classify_contact_tier a partir de los 4 tiers
 * configurados en /admin/config — igual que buildUpdateStageTool, el
 * criterio de cada uno es texto libre así que el enum/descripción no puede
 * ser estático. Solo ofrece los tiers que tengan criterio cargado (un tier
 * sin criteria todavía no está definido, no tiene sentido que el agente
 * elija a ciegas).
 */
function buildClassifyTierTool(): Anthropic.Tool {
  const tiers = getSettings().tiers.filter((t) => t.criteria.trim());
  const enumValues = tiers.map((t) => t.key);
  const description =
    tiers.length > 0
      ? tiers.map((t) => `${t.label}: ${t.criteria}`).join("\n")
      : "Todavía no hay ningún tier configurado con criterios (ver /admin/config).";

  return {
    name: "classify_contact_tier",
    description:
      "Clasificá al cliente actual en uno de estos tiers según lo que mostró en la charla hasta ahora " +
      "(presupuesto, urgencia, nivel de definición, etc.):\n" +
      description +
      "\nUsala cuando ya tengas señales suficientes para elegir con criterio, no en el primer mensaje. " +
      "Si cambian las señales más adelante en la misma conversación, podés volver a clasificarlo — " +
      "gana la última.",
    input_schema: {
      type: "object",
      properties: {
        tier: {
          type: "string",
          ...(enumValues.length > 0 ? { enum: enumValues } : {}),
          description: "A qué tier corresponde.",
        },
        reasoning: { type: "string", description: "Motivo breve, en base a qué de la charla lo clasificaste así." },
      },
      required: ["tier", "reasoning"],
    },
  };
}

const STATIC_TOOLS_AFTER_STAGE: Anthropic.Tool[] = [
  {
    name: "save_lead_notes",
    description:
      "Deja registrado en Tokko (como una nueva Consulta pendiente de revisión) un dato " +
      "relevante detectado en la charla (presupuesto, preferencias, disponibilidad, etc.). " +
      "No la uses para cada mensaje — solo cuando el cliente comparta algo con valor comercial " +
      "real que valga la pena que el agente humano vea al revisar la consulta.",
    input_schema: {
      type: "object",
      properties: {
        note: { type: "string" },
      },
      required: ["note"],
    },
  },
];

/**
 * Arma la herramienta escalate_to_human a partir de los motivos cargados en
 * los contactos de escalamiento (/admin) — igual que buildUpdateStageTool,
 * el enum de "category" no puede ser estático porque esos motivos son
 * texto libre configurable.
 */
function buildEscalateToHumanTool(): Anthropic.Tool {
  const categories = [...new Set(getSettings().team.map((c) => c.reason).filter(Boolean))];
  return {
    name: "escalate_to_human",
    description:
      "Avisa por WhatsApp a un agente humano del equipo que este cliente necesita ayuda con algo " +
      "que vos no podés resolver con los datos disponibles (Tokko/Drive no tienen la info, pedido " +
      "fuera de lo habitual, cliente insistente, etc.). Usala solo cuando de verdad no sepas la " +
      "respuesta — no reemplaza a save_lead_notes ni se usa para cada consulta.",
    input_schema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "La pregunta o pedido concreto del cliente que necesita revisión humana.",
        },
        category: {
          type: "string",
          ...(categories.length > 0 ? { enum: categories } : {}),
          description:
            categories.length > 0
              ? "A qué tipo de consulta corresponde, para avisarle al contacto correcto: " + categories.join(", ")
              : "No hay motivos configurados todavía (ver /admin) — se avisa a todos los contactos.",
        },
      },
      required: ["question"],
    },
  };
}

export function getAgentTools(): Anthropic.Tool[] {
  return [
    ...STATIC_TOOLS_BEFORE_STAGE,
    ...buildVisitTools(),
    buildUpdateStageTool(),
    buildClassifyTierTool(),
    ...STATIC_TOOLS_AFTER_STAGE,
    buildEscalateToHumanTool(),
  ];
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<string> {
  switch (name) {
    case "search_properties": {
      const operation = input.operation as "venta" | "alquiler" | undefined;
      const roomsMin = input.rooms_min as number | undefined;
      if (roomsMin !== undefined) {
        appendToolUsage({
          ts: Date.now(),
          phone: ctx.customerPhone,
          kind: "typology",
          value: `${roomsMin}+ ambientes`,
        });
      }
      const location = (input.location as string | undefined)?.trim();
      if (location) {
        appendToolUsage({ ts: Date.now(), phone: ctx.customerPhone, kind: "location", value: location });
      }
      const tokkoSettings = getSettings().tokko;
      const operationId =
        operation === "venta"
          ? tokkoSettings.operationIdSale
          : operation === "alquiler"
            ? tokkoSettings.operationIdRent
            : undefined;

      const { items, matchedAtLeast, exhausted } = await tokkoClient.searchProperties({
        operationTypes: operationId ? [operationId] : undefined,
        priceFrom: input.price_min as number | undefined,
        priceTo: input.price_max as number | undefined,
        currency: (input.currency as string | undefined) ?? "USD",
        roomAmountFrom: input.rooms_min as number | undefined,
        location,
        limit: 8,
      });

      const summaries = await Promise.all(
        items.map(async (p) => ({
          id: p.id,
          title: p.publication_title,
          // Preferimos la ubicación del emprendimiento (development.location)
          // sobre la de la unidad: en casos reales la de la unidad individual
          // estaba mal cargada en Tokko (ver comentario en types.ts).
          address: p.development?.location?.name ?? p.address ?? p.location?.name,
          development_name: p.development?.name,
          rooms: p.room_amount,
          surface_m2: p.surface,
          operations: p.operations?.map((o) => ({
            type: o.operation_type,
            prices: o.prices,
          })),
          url: await resolveListingUrl([p.publication_title, p.address], p.public_url),
        })),
      );
      return JSON.stringify({
        properties: summaries,
        // exhausted=true: shown_count es el total real. exhausted=false:
        // hay AL MENOS matched_at_least, puede haber más — no lo trates
        // como un total exacto ni lo repitas como si lo fuera.
        shown_count: summaries.length,
        matched_at_least: matchedAtLeast,
        total_is_exact: exhausted,
      });
    }

    case "search_developments": {
      const developments = await tokkoClient.searchDevelopments(input.query as string);
      const summaries = await Promise.all(
        developments.map(async (d) => ({
          id: d.id,
          name: d.name,
          address: d.address ?? d.location?.name,
          url: await resolveListingUrl([d.name, d.address], d.web_url),
        })),
      );
      if (summaries.length > 0 && summaries[0].name) {
        appendToolUsage({ ts: Date.now(), phone: ctx.customerPhone, kind: "development", value: summaries[0].name });
      }
      return JSON.stringify({ count: summaries.length, developments: summaries });
    }

    case "get_development_details": {
      const development = await tokkoClient.getDevelopment(input.development_id as number);
      if (development.name) {
        appendToolUsage({ ts: Date.now(), phone: ctx.customerPhone, kind: "development", value: development.name });
      }
      return JSON.stringify({
        id: development.id,
        name: development.name,
        description: development.description || undefined,
        address: development.address ?? development.location?.name,
        url: await resolveListingUrl([development.name, development.address], development.web_url),
        photo_count: development.photos?.length ?? 0,
      });
    }

    case "get_zonaprop_link": {
      const link = await findZonapropLink(input.name as string);
      return JSON.stringify({
        found: link !== null,
        link: link ?? undefined,
      });
    }

    case "get_property_details": {
      const property = await tokkoClient.getProperty(input.property_id as number);
      return JSON.stringify({
        id: property.id,
        title: property.publication_title,
        description: property.description,
        address: property.development?.location?.name ?? property.address ?? property.location?.name,
        development_name: property.development?.name,
        rooms: property.room_amount,
        suites: property.suite_amount,
        surface_m2: property.surface,
        roofed_surface_m2: property.roofed_surface,
        operations: property.operations,
        photo_count: property.photos?.length ?? 0,
        url: property.public_url,
      });
    }

    case "share_file": {
      const query = input.query as string;

      // Escala siempre que share_file no pueda entregar el archivo — sea
      // porque no está en Drive, o porque Drive falló técnicamente (ej. mal
      // configurado). No depende de que el modelo "decida" escalar: eso
      // resultó no ser confiable (a veces el modelo no llamaba a
      // escalate_to_human después de un error), así que queda garantizado acá.
      const escalate = async (reason: string) => {
        return escalateToHumans({
          customerPhone: ctx.customerPhone,
          customerName: ctx.customerName,
          question: `Pide el archivo "${query}" por WhatsApp — ¿se lo podés mandar vos directamente?`,
          reason,
        }).catch((error) => {
          logger.warn("agent.escalation_failed", { error: String(error) });
          return false;
        });
      };

      let files;
      try {
        files = await findFilesByName(query);
      } catch (error) {
        logger.error("drive.search_failed", { query, error: String(error) });
        const escalated = await escalate("Falla técnica buscando en Drive.");
        return JSON.stringify({
          sent: false,
          reason: "Hubo un problema técnico buscando el archivo.",
          escalated,
        });
      }

      if (files.length === 0) {
        const escalated = await escalate("No está en Drive.");
        return JSON.stringify({
          sent: false,
          reason: "No se encontró ningún archivo con ese nombre.",
          escalated,
        });
      }

      const file = files[0];
      await sendDocumentByLink(ctx.customerPhone, file.downloadUrl, file.name);
      return JSON.stringify({ sent: true, file: file.name });
    }

    case "check_visit_availability": {
      const date = input.date as string;
      const repName = (input.rep_name as string | undefined)?.trim() || undefined;
      const visitReps = getSettings().team.filter((m) => m.calendarId);
      if (visitReps.length === 0) {
        return JSON.stringify({
          date,
          hasCalendar: false,
          reason: "No hay nadie del equipo con calendario configurado todavía (ver /admin).",
        });
      }
      if (repName) {
        const matches = findMatchingReps(repName);
        if (matches.length === 0) {
          return JSON.stringify({
            date,
            hasCalendar: true,
            repNotFound: true,
            knownReps: visitReps.map((r) => r.name),
          });
        }
        if (matches.length > 1) {
          return JSON.stringify({
            date,
            hasCalendar: true,
            repAmbiguous: true,
            matches: matches.map((r) => r.name),
          });
        }
      }
      try {
        const availableTimes = await getAvailableSlots(date, repName);
        return JSON.stringify({ date, repName, hasCalendar: true, availableTimes });
      } catch (error) {
        logger.error("calendar.availability_failed", { date, repName, error: String(error) });
        return JSON.stringify({ date, hasCalendar: true, error: "No se pudo consultar el calendario." });
      }
    }

    case "book_visit": {
      const date = input.date as string;
      const time = input.time as string;
      const notes = (input.notes as string | undefined)?.trim();
      const repName = (input.rep_name as string | undefined)?.trim() || undefined;
      try {
        const result = await bookVisit({
          customerPhone: ctx.customerPhone,
          dateStr: date,
          time,
          summary: `Visita: ${ctx.customerName}`,
          description: `Cliente: ${ctx.customerName} (${ctx.customerPhone})${notes ? `\n${notes}` : ""}`,
          repName,
        });
        logger.info("agent.visit_booked", {
          customerPhone: ctx.customerPhone,
          date,
          time,
          eventId: result.eventId,
          rep: result.repName,
        });

        // Ambos avisos son best-effort: si fallan, la visita ya quedó
        // agendada en el calendario igual — no hace falta que le pese al
        // cliente ni al comercial.
        let icsSent = false;
        if (config.PUBLIC_WEBHOOK_URL) {
          try {
            const icsId = storeIcs(result.icsContent);
            const icsUrl = `${new URL(config.PUBLIC_WEBHOOK_URL).origin}/ics/${icsId}`;
            logger.info("agent.visit_ics_url", { icsUrl });
            await sendDocumentByLink(ctx.customerPhone, icsUrl, "visita.ics", "📅 Acá tenés el evento para agregarlo a tu calendario.");
            icsSent = true;
          } catch (error) {
            logger.warn("agent.visit_ics_send_failed", { customerPhone: ctx.customerPhone, error: String(error) });
          }
        }

        if (result.repPhone) {
          const notifyText =
            `📅 Nueva visita agendada\n` +
            `Cliente: ${ctx.customerName} (${ctx.customerPhone})\n` +
            `Cuándo: ${date} ${time}` +
            (notes ? `\nDetalle: ${notes}` : "");
          sendText(result.repPhone, notifyText).catch((error) => {
            logger.warn("agent.visit_notify_failed", { rep: result.repName, error: String(error) });
          });
        }

        return JSON.stringify({ booked: true, date, time, assigned_to: result.repName, ics_sent: icsSent });
      } catch (error) {
        logger.error("calendar.book_visit_failed", { customerPhone: ctx.customerPhone, date, time, repName, error: String(error) });
        return JSON.stringify({
          booked: false,
          reason: error instanceof Error ? error.message : "No se pudo agendar la visita.",
        });
      }
    }

    case "reschedule_visit": {
      const date = input.date as string;
      const time = input.time as string;
      try {
        const result = await rescheduleVisit({ customerPhone: ctx.customerPhone, dateStr: date, time });
        logger.info("agent.visit_rescheduled", {
          customerPhone: ctx.customerPhone,
          date,
          time,
          eventId: result.eventId,
          rep: result.repName,
        });

        let icsSent = false;
        if (config.PUBLIC_WEBHOOK_URL) {
          try {
            const icsId = storeIcs(result.icsContent);
            const icsUrl = `${new URL(config.PUBLIC_WEBHOOK_URL).origin}/ics/${icsId}`;
            logger.info("agent.visit_ics_url", { icsUrl });
            await sendDocumentByLink(
              ctx.customerPhone,
              icsUrl,
              "visita.ics",
              "📅 Che, actualizamos el evento con el nuevo horario.",
            );
            icsSent = true;
          } catch (error) {
            logger.warn("agent.visit_ics_send_failed", { customerPhone: ctx.customerPhone, error: String(error) });
          }
        }

        if (result.repPhone) {
          const notifyText =
            `🔄 Visita reprogramada\n` +
            `Cliente: ${ctx.customerName} (${ctx.customerPhone})\n` +
            `Antes: ${result.previousDateStr} ${result.previousTime}\n` +
            `Ahora: ${date} ${time}`;
          sendText(result.repPhone, notifyText).catch((error) => {
            logger.warn("agent.visit_notify_failed", { rep: result.repName, error: String(error) });
          });
        }

        return JSON.stringify({ rescheduled: true, date, time, assigned_to: result.repName, ics_sent: icsSent });
      } catch (error) {
        logger.error("calendar.reschedule_visit_failed", { customerPhone: ctx.customerPhone, date, time, error: String(error) });
        return JSON.stringify({
          rescheduled: false,
          reason: error instanceof Error ? error.message : "No se pudo reprogramar la visita.",
        });
      }
    }

    case "update_opportunity_stage": {
      const stage = input.stage as string;
      const reason = (input.reason as string | undefined)?.trim();
      const stageLabel = getSettings().tokko.stages.find((s) => s.key === stage)?.label ?? stage;
      appendStageLog({
        ts: Date.now(),
        phone: ctx.customerPhone,
        name: ctx.customerName,
        stageKey: stage,
        stageLabel,
        reason,
      });
      logger.info("agent.stage_logged", { customerPhone: ctx.customerPhone, stage, reason });
      return JSON.stringify({ logged: true, stage });
    }

    case "classify_contact_tier": {
      const tier = input.tier as string;
      const reasoning = (input.reasoning as string).trim();
      const tierLabel = getSettings().tiers.find((t) => t.key === tier)?.label ?? tier;
      appendTierLog({
        ts: Date.now(),
        phone: ctx.customerPhone,
        name: ctx.customerName,
        tierKey: tier,
        tierLabel,
        reasoning,
      });
      logger.info("agent.tier_classified", { customerPhone: ctx.customerPhone, tier, reasoning });
      return JSON.stringify({ classified: true, tier });
    }

    case "save_lead_notes": {
      await tokkoClient.submitInquiry({
        name: ctx.customerName,
        phone: ctx.customerPhone,
        text: input.note as string,
        tags: ["WhatsApp", "Seguimiento"],
      });
      return JSON.stringify({ saved: true, note: "Quedó como una nueva consulta pendiente en Tokko." });
    }

    case "escalate_to_human": {
      const question = input.question as string;
      const category = input.category as string | undefined;
      const escalated = await escalateToHumans({
        customerPhone: ctx.customerPhone,
        customerName: ctx.customerName,
        question,
        category,
      });
      if (!escalated) {
        logger.warn("agent.escalation_not_configured", { customerPhone: ctx.customerPhone });
        return JSON.stringify({
          escalated: false,
          reason: "No hay ningún contacto de escalamiento configurado (ver /admin).",
        });
      }
      logger.info("agent.escalated_to_human", { customerPhone: ctx.customerPhone, question, category });
      return JSON.stringify({ escalated: true });
    }

    default:
      return JSON.stringify({ error: `Herramienta desconocida: ${name}` });
  }
}
