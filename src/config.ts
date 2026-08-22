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

  // IDs reales de "opportunity_status" en tu cuenta (Oportunidades > Configuración
  // de oportunidades). Son específicos de cada cuenta de Tokko — hay que
  // completarlos en .env, no acá (ver docs/SETUP.md).
  TOKKO_STAGE_AUN_NO_CONTACTADOS: z.coerce.number().optional(),
  TOKKO_STAGE_SIN_SEGUIMIENTO: z.coerce.number().optional(),
  TOKKO_STAGE_CONTACTAR: z.coerce.number().optional(),
  TOKKO_STAGE_PRIMER_CONTACTO: z.coerce.number().optional(),
  TOKKO_STAGE_VOLVER_A_CONTACTAR: z.coerce.number().optional(),
  TOKKO_STAGE_EVOLUCIONANDO: z.coerce.number().optional(),
  TOKKO_STAGE_TOMAR_ACCION: z.coerce.number().optional(),
  TOKKO_STAGE_CONGELADO: z.coerce.number().optional(),
  TOKKO_STAGE_CERRADO: z.coerce.number().optional(),

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

// Mapea claves semánticas de etapa a los IDs reales de "opportunity_status"
// configurados en Tokko. Son específicos de cada cuenta: hay que
// completarlos en .env (ver docs/SETUP.md).
export const OPPORTUNITY_STAGES = {
  aun_no_contactados: config.TOKKO_STAGE_AUN_NO_CONTACTADOS,
  sin_seguimiento: config.TOKKO_STAGE_SIN_SEGUIMIENTO,
  contactar: config.TOKKO_STAGE_CONTACTAR,
  primer_contacto: config.TOKKO_STAGE_PRIMER_CONTACTO,
  volver_a_contactar: config.TOKKO_STAGE_VOLVER_A_CONTACTAR,
  evolucionando: config.TOKKO_STAGE_EVOLUCIONANDO,
  tomar_accion: config.TOKKO_STAGE_TOMAR_ACCION,
  congelado: config.TOKKO_STAGE_CONGELADO,
  cerrado: config.TOKKO_STAGE_CERRADO,
} as const;

export type OpportunityStageKey = keyof typeof OPPORTUNITY_STAGES;
