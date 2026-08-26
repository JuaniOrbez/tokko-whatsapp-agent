import type Anthropic from "@anthropic-ai/sdk";
import { tokkoClient } from "../tokko/client.js";
import { findFilesByName, findZonapropLink } from "../drive/client.js";
import { sendDocumentByLink } from "../whatsapp/client.js";
import { logger } from "../logger.js";
import { getSettings } from "../settings.js";
import { escalateToHumans } from "./escalation.js";
import { appendToolUsage } from "./toolUsageLog.js";
import { getAvailableSlots, bookVisit } from "../calendar/client.js";

export interface AgentContext {
  customerPhone: string;
  customerName: string;
  // id real solo si el contacto YA existía en Tokko (encontrado por
  // teléfono). Un contacto nuevo no tiene id todavía: queda como "Consulta"
  // pendiente de aprobación manual en Tokko (ver orchestrator.ts) — en ese
  // caso update_opportunity_stage no tiene nada sobre lo cual actuar.
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
      "Actualiza la etapa del contacto en el workflow de Oportunidades de Tokko. Usala cuando " +
      "la conversación deje claro un cambio real de etapa — no la uses en cada mensaje.",
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
      "Busca el link de la publicación en Zonaprop de una propiedad o emprendimiento por nombre. " +
      "Tokko no expone ese link por API (es de Zonaprop), así que sale de una lista a mano en " +
      "Drive — puede no estar cargado. Usala solo si el cliente pide específicamente el link de " +
      "Zonaprop; para el link general de la publicación usá el que ya viene en search_properties/" +
      "get_development_details.",
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
  {
    name: "check_visit_availability",
    description:
      "Consulta los horarios libres para coordinar una visita o reunión en una fecha puntual, " +
      "según el calendario y el horario laboral configurados en /admin. Usala siempre antes de " +
      "proponerle un horario al cliente — nunca inventes disponibilidad.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: 'Fecha en formato YYYY-MM-DD (hora Argentina), ej. "2026-08-27".' },
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
      "horario. Antes de llamarla pedile el mail al cliente para poder invitarlo al evento — si no " +
      "te lo quiere dar, agendá igual sin ese dato, no es bloqueante.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: 'Fecha en formato YYYY-MM-DD (hora Argentina).' },
        time: { type: "string", description: 'Hora en formato HH:mm (hora Argentina), ej. "15:30".' },
        notes: {
          type: "string",
          description: "Detalle de la visita: propiedad/emprendimiento, dirección, motivo del encuentro.",
        },
        client_email: {
          type: "string",
          description: "Mail del cliente, para invitarlo al evento — opcional, si no lo dio no lo inventes.",
        },
      },
      required: ["date", "time"],
    },
  },
];

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
  const categories = [...new Set(getSettings().escalationContacts.map((c) => c.reason).filter(Boolean))];
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
    buildUpdateStageTool(),
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
        location: input.location as string | undefined,
        limit: 8,
      });

      const summaries = items.map((p) => ({
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
        url: p.public_url,
      }));
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
      const summaries = developments.map((d) => ({
        id: d.id,
        name: d.name,
        address: d.address ?? d.location?.name,
        url: d.web_url || undefined,
      }));
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
        url: development.web_url || undefined,
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
      if (getSettings().visits.reps.length === 0) {
        return JSON.stringify({
          date,
          hasCalendar: false,
          reason: "No hay ningún comercial con calendario configurado todavía (ver /admin).",
        });
      }
      try {
        const availableTimes = await getAvailableSlots(date);
        return JSON.stringify({ date, hasCalendar: true, availableTimes });
      } catch (error) {
        logger.error("calendar.availability_failed", { date, error: String(error) });
        return JSON.stringify({ date, hasCalendar: true, error: "No se pudo consultar el calendario." });
      }
    }

    case "book_visit": {
      const date = input.date as string;
      const time = input.time as string;
      const notes = (input.notes as string | undefined)?.trim();
      const clientEmail = (input.client_email as string | undefined)?.trim() || undefined;
      try {
        const result = await bookVisit({
          dateStr: date,
          time,
          summary: `Visita: ${ctx.customerName}`,
          description: `Cliente: ${ctx.customerName} (${ctx.customerPhone})${notes ? `\n${notes}` : ""}`,
          clientEmail,
        });
        logger.info("agent.visit_booked", {
          customerPhone: ctx.customerPhone,
          date,
          time,
          eventId: result.eventId,
          rep: result.repName,
          invited: Boolean(clientEmail),
        });
        return JSON.stringify({ booked: true, date, time, assigned_to: result.repName, invited: Boolean(clientEmail) });
      } catch (error) {
        logger.error("calendar.book_visit_failed", { customerPhone: ctx.customerPhone, date, time, error: String(error) });
        return JSON.stringify({
          booked: false,
          reason: "No se pudo agendar la visita — puede que el calendario no esté configurado o que el horario ya no esté libre.",
        });
      }
    }

    case "update_opportunity_stage": {
      if (ctx.contactId === null) {
        return JSON.stringify({
          updated: false,
          reason: "Todavía no hay un contacto confirmado en Tokko (la consulta está pendiente de aprobación).",
        });
      }
      const stage = input.stage as string;
      await tokkoClient.updateContactStage(ctx.contactId, stage);
      logger.info("agent.stage_updated", { contactId: ctx.contactId, stage, reason: input.reason });
      return JSON.stringify({ updated: true, stage });
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
