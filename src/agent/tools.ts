import type Anthropic from "@anthropic-ai/sdk";
import { tokkoClient } from "../tokko/client.js";
import { findFilesByName } from "../drive/client.js";
import { sendDocumentByLink } from "../whatsapp/client.js";
import { logger } from "../logger.js";
import { config, type OpportunityStageKey } from "../config.js";

export interface AgentContext {
  customerPhone: string;
  contactId: number;
  opportunityId: number;
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
      "Actualiza la etapa de la oportunidad del cliente en el workflow de Tokko. Usala cuando " +
      "la conversación deje claro un cambio real de etapa (por ejemplo: se lo contactó, calificó " +
      "sus necesidades, agendó una visita, está negociando, o cerró/perdió el negocio).",
    input_schema: {
      type: "object",
      properties: {
        stage: {
          type: "string",
          enum: [
            "new",
            "contacted",
            "qualified",
            "visit_scheduled",
            "negotiation",
            "won",
            "lost",
          ],
        },
        reason: { type: "string", description: "Motivo breve del cambio de etapa." },
      },
      required: ["stage"],
    },
  },
  {
    name: "save_lead_notes",
    description:
      "Guarda una nota breve en la ficha del contacto en Tokko con información relevante " +
      "detectada en la charla (presupuesto, preferencias, disponibilidad, etc.).",
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

      const properties = await tokkoClient.searchProperties({
        operationTypes: operationId ? [operationId] : undefined,
        priceFrom: input.price_min as number | undefined,
        priceTo: input.price_max as number | undefined,
        currency: (input.currency as string | undefined) ?? "USD",
        roomAmountFrom: input.rooms_min as number | undefined,
        location: input.location as string | undefined,
        limit: 8,
      });

      const summaries = properties.map((p) => ({
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
      return JSON.stringify({ count: summaries.length, properties: summaries });
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
      const stage = input.stage as OpportunityStageKey;
      await tokkoClient.updateOpportunityStage(ctx.opportunityId, stage);
      logger.info("agent.stage_updated", {
        contactId: ctx.contactId,
        opportunityId: ctx.opportunityId,
        stage,
        reason: input.reason,
      });
      return JSON.stringify({ updated: true, stage });
    }

    case "save_lead_notes": {
      await tokkoClient.addNote(ctx.contactId, input.note as string);
      return JSON.stringify({ saved: true });
    }

    default:
      return JSON.stringify({ error: `Herramienta desconocida: ${name}` });
  }
}
