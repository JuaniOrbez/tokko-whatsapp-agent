import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),

  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1, "falta WHATSAPP_PHONE_NUMBER_ID"),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1, "falta WHATSAPP_ACCESS_TOKEN"),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1, "falta WHATSAPP_VERIFY_TOKEN"),
  WHATSAPP_API_VERSION: z.string().default("v21.0"),
  WHATSAPP_APP_SECRET: z.string().optional(),

  TOKKO_API_KEY: z.string().min(1, "falta TOKKO_API_KEY"),
  TOKKO_API_BASE_URL: z.string().url().default("https://www.tokkobroker.com/api/v1"),
  TOKKO_LANG: z.string().default("es_ar"),

  TOKKO_STAGE_NEW: z.string().optional(),
  TOKKO_STAGE_CONTACTED: z.string().optional(),
  TOKKO_STAGE_QUALIFIED: z.string().optional(),
  TOKKO_STAGE_VISIT_SCHEDULED: z.string().optional(),
  TOKKO_STAGE_NEGOTIATION: z.string().optional(),
  TOKKO_STAGE_WON: z.string().optional(),
  TOKKO_STAGE_LOST: z.string().optional(),

  // IDs numéricos de "operation_type" en tu cuenta de Tokko (venta/alquiler).
  // Si se dejan vacíos, la búsqueda no filtra por operación.
  TOKKO_OPERATION_ID_SALE: z.coerce.number().optional(),
  TOKKO_OPERATION_ID_RENT: z.coerce.number().optional(),

  GOOGLE_SERVICE_ACCOUNT_FILE: z.string().min(1, "falta GOOGLE_SERVICE_ACCOUNT_FILE"),
  GOOGLE_DRIVE_FOLDER_ID: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
});

function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Configuración inválida. Revisá tu archivo .env (copiá .env.example):\n${issues}`,
    );
  }
  return parsed.data;
}

export const config = loadConfig();

// Mapea claves semánticas de etapa a los IDs reales configurados en Tokko.
// Los IDs del workflow de oportunidades son específicos de cada cuenta de
// Tokko: hay que completarlos en .env (ver docs/SETUP.md).
export const OPPORTUNITY_STAGES = {
  new: config.TOKKO_STAGE_NEW,
  contacted: config.TOKKO_STAGE_CONTACTED,
  qualified: config.TOKKO_STAGE_QUALIFIED,
  visit_scheduled: config.TOKKO_STAGE_VISIT_SCHEDULED,
  negotiation: config.TOKKO_STAGE_NEGOTIATION,
  won: config.TOKKO_STAGE_WON,
  lost: config.TOKKO_STAGE_LOST,
} as const;

export type OpportunityStageKey = keyof typeof OPPORTUNITY_STAGES;
