import type Anthropic from "@anthropic-ai/sdk";
import { tokkoClient } from "../tokko/client.js";
import { findFilesByName } from "../drive/client.js";
import { sendDocumentByLink } from "../whatsapp/client.js";
import { logger } from "../logger.js";
import { config, type OpportunityStageKey } from "../config.js";

export interface AgentContext {
  customerPhone: string;
  customerName: string;
  // id real solo si el contacto YA existía en Tokko (encontrado por
  // teléfono). Un contacto nuevo no tiene id todavía: queda como "Consulta"
  // pendiente de aprobación manual en Tokko (ver orchestrator.ts) — en ese
  // caso update_opportunity_stage no tiene nada sobre lo cual actuar.
  contactId: number | null;
}

export const agentTools: Anthropic.Tool[] = [
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
    name: "update_opportunity_stage",
    description:
      "Actualiza la etapa del contacto en el workflow de Oportunidades de Tokko. Usala cuando " +
      "la conversación deje claro un cambio real de etapa — no la uses en cada mensaje.",
    input_schema: {
      type: "object",
      properties: {
        stage: {
          type: "string",
          enum: [
            "aun_no_contactados",
            "sin_seguimiento",
            "contactar",
            "primer_contacto",
            "volver_a_contactar",
            "evolucionando",
            "tomar_accion",
            "congelado",
            "cerrado",
          ],
          description:
            "aun_no_contactados: todavía nadie lo contactó. sin_seguimiento: sin actividad " +
            "reciente. contactar: hay que contactarlo (pendiente). primer_contacto: ya se hizo " +
            "el primer contacto. volver_a_contactar: hay que retomar el contacto. evolucionando: " +
            "la negociación está avanzando. tomar_accion: requiere una acción del agente humano " +
            "(estado por defecto de contactos nuevos). congelado: en pausa por ahora. cerrado: " +
            "el negocio se cerró o se descartó definitivamente.",
        },
        reason: { type: "string", description: "Motivo breve del cambio de etapa." },
      },
      required: ["stage"],
    },
  },
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

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<string> {
  switch (name) {
    case "search_properties": {
      const operation = input.operation as "venta" | "alquiler" | undefined;
      const operationId =
        operation === "venta"
          ? config.TOKKO_OPERATION_ID_SALE
          : operation === "alquiler"
            ? config.TOKKO_OPERATION_ID_RENT
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
        address: p.address ?? p.location?.name,
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
        url: d.public_url,
      }));
      return JSON.stringify({ count: summaries.length, developments: summaries });
    }

    case "get_property_details": {
      const property = await tokkoClient.getProperty(input.property_id as number);
      return JSON.stringify({
        id: property.id,
        title: property.publication_title,
        description: property.description,
        address: property.address ?? property.location?.name,
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
      const files = await findFilesByName(input.query as string);
      if (files.length === 0) {
        return JSON.stringify({ sent: false, reason: "No se encontró ningún archivo con ese nombre." });
      }
      const file = files[0];
      await sendDocumentByLink(ctx.customerPhone, file.downloadUrl, file.name);
      return JSON.stringify({ sent: true, file: file.name });
    }

    case "update_opportunity_stage": {
      if (ctx.contactId === null) {
        return JSON.stringify({
          updated: false,
          reason: "Todavía no hay un contacto confirmado en Tokko (la consulta está pendiente de aprobación).",
        });
      }
      const stage = input.stage as OpportunityStageKey;
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

    default:
      return JSON.stringify({ error: `Herramienta desconocida: ${name}` });
  }
}
