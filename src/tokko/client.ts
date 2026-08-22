import { config, OPPORTUNITY_STAGES, type OpportunityStageKey } from "../config.js";
import { logger } from "../logger.js";
import type { TokkoContact, TokkoListResponse, TokkoProperty, TokkoSearchFilters } from "./types.js";

/**
 * Cliente de la API de Tokko Broker.
 *
 * `/property/` (listado) y `/contact/` (listado) fueron verificados en vivo
 * contra una cuenta real: la paginación es por query params planos
 * (`limit`/`offset`), y los campos usados por este cliente están
 * confirmados — incluyendo que **no existe un recurso "Oportunidad"
 * separado**: el estado del embudo vive directo en el campo
 * `opportunity_status` (`{id, name, color, is_closed_status}`) de cada
 * contacto, asignado por Tastypie/Tokko. `/property/search/` en cambio
 * exige un parámetro `data` con una forma que no pudimos determinar sin
 * documentación — por eso `searchProperties` filtra en el servidor Node
 * sobre el listado, en vez de depender de `/search/`.
 *
 * IMPORTANTE — confirmado en vivo: la API key de esta cuenta es de **solo
 * lectura**. PATCH y POST contra `/contact/{id}/` devuelven ambos una
 * respuesta de error (el string "GET"), o sea que `createContact`,
 * `updateContactStage` y `addNote` van a fallar tal como está la key hoy.
 * Hay que pedirle a Tokko que habilite permisos de escritura en la API v1
 * para esta cuenta (ver docs/SETUP.md). El resto del agente (búsqueda de
 * propiedades y contactos) no se ve afectado — es todo lectura, y
 * orchestrator.ts ya trata cualquier falla de escritura como best-effort
 * (loguea y sigue respondiendo al cliente) para no depender de esto.
 *
 * Además, `addNote` sigue sin confirmar si `/contact/{id}/note/` existe
 * como sub-recurso — no hay evidencia de que Tokko exponga notas de
 * seguimiento por API v1, más allá del problema de permisos.
 */
const ENDPOINTS = {
  propertyList: "/property/",
  propertyDetail: (id: number | string) => `/property/${id}/`,
  contactList: "/contact/",
  contactDetail: (id: number | string) => `/contact/${id}/`,
  // VERIFICAR — no confirmado contra la cuenta real:
  contactNote: (id: number | string) => `/contact/${id}/note/`,
};

const PAGE_SIZE = 20;
const MAX_PAGES_SCANNED = 5; // cota superior: hasta 100 propiedades revisadas por búsqueda

function matchesFilters(property: TokkoProperty, filters: TokkoSearchFilters): boolean {
  if (filters.operationTypes && filters.operationTypes.length > 0) {
    const ids = property.operations?.map((o) => o.operation_id) ?? [];
    if (!ids.some((id) => filters.operationTypes!.includes(id))) return false;
  }

  if (filters.priceFrom !== undefined || filters.priceTo !== undefined || filters.currency) {
    const prices = (property.operations ?? []).flatMap((o) => o.prices ?? []);
    const relevant = filters.currency ? prices.filter((p) => p.currency === filters.currency) : prices;
    const matchesPrice = relevant.some((p) => {
      if (filters.priceFrom !== undefined && p.price < filters.priceFrom) return false;
      if (filters.priceTo !== undefined && p.price > filters.priceTo) return false;
      return true;
    });
    if (relevant.length > 0 && !matchesPrice) return false;
  }

  if (filters.roomAmountFrom !== undefined) {
    if ((property.room_amount ?? 0) < filters.roomAmountFrom) return false;
  }

  if (filters.location) {
    const needle = filters.location.trim().toLowerCase();
    const haystack = [
      property.location?.name,
      property.location?.full_location,
      property.address,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }

  return true;
}

class TokkoClient {
  private readonly baseUrl = config.TOKKO_API_BASE_URL;
  private readonly apiKey = config.TOKKO_API_KEY;
  private readonly lang = config.TOKKO_LANG;

  private buildUrl(path: string, extraParams: Record<string, string> = {}): string {
    const url = new URL(this.baseUrl + path);
    url.searchParams.set("key", this.apiKey);
    url.searchParams.set("lang", this.lang);
    url.searchParams.set("format", "json");
    for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);
    return url.toString();
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH",
    path: string,
    options: { params?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const url = this.buildUrl(path, options.params);
    const response = await fetch(url, {
      method,
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Tokko API error ${response.status} (${method} ${path}): ${text}`);
    }
    return (await response.json()) as T;
  }

  /**
   * Recorre el listado de propiedades (paginado) y filtra en el servidor
   * Node por operación, precio, ambientes y ubicación. Corta apenas junta
   * suficientes resultados o al llegar a MAX_PAGES_SCANNED.
   */
  async searchProperties(filters: TokkoSearchFilters): Promise<TokkoProperty[]> {
    const wanted = filters.limit ?? 5;
    const matches: TokkoProperty[] = [];

    for (let page = 0; page < MAX_PAGES_SCANNED; page++) {
      const result = await this.request<TokkoListResponse>("GET", ENDPOINTS.propertyList, {
        params: { limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) },
      });
      const objects = result.objects ?? [];

      for (const property of objects) {
        if (matchesFilters(property, filters)) matches.push(property);
      }

      const totalCount = result.meta?.total_count ?? objects.length;
      const scanned = (page + 1) * PAGE_SIZE;
      if (matches.length >= wanted || scanned >= totalCount || objects.length === 0) break;
    }

    return matches.slice(0, wanted);
  }

  /** Sigue la misma convención que `/property/` (confirmada) pero el detalle en sí no se probó en vivo. */
  async getProperty(id: number | string): Promise<TokkoProperty> {
    return this.request<TokkoProperty>("GET", ENDPOINTS.propertyDetail(id));
  }

  /** Confirmado: `/contact/` funciona igual que `/property/` (mismo listado paginado). */
  async findContactByPhone(phone: string): Promise<TokkoContact | null> {
    try {
      const result = await this.request<{ objects: TokkoContact[] }>(
        "GET",
        ENDPOINTS.contactList,
        { params: { phone } },
      );
      return result.objects?.[0] ?? null;
    } catch (error) {
      logger.warn("tokko.find_contact_failed", { phone, error: String(error) });
      return null;
    }
  }

  /**
   * VERIFICAR: no probado en vivo (crear un contacto es una acción con
   * efecto real). `name` y `phone` son campos confirmados del objeto
   * Contact, pero no confirmamos que basten como body de creación — probalo
   * primero con un contacto de prueba bien identificable.
   */
  async createContact(input: { name: string; phone: string }): Promise<TokkoContact> {
    return this.request<TokkoContact>("POST", ENDPOINTS.contactList, {
      body: { name: input.name, phone: input.phone },
    });
  }

  /** Busca el contacto por teléfono o lo crea si no existe. */
  async ensureContact(input: { name: string; phone: string }): Promise<TokkoContact> {
    const existing = await this.findContactByPhone(input.phone);
    if (existing) return existing;
    logger.info("tokko.creating_contact", { phone: input.phone });
    return this.createContact(input);
  }

  /**
   * VERIFICAR: en la cuenta real no encontramos evidencia de un sub-recurso
   * de notas — puede que Tokko no lo exponga por API v1. Falla en silencio
   * (el llamador ya lo trata como best-effort) hasta confirmar el endpoint
   * correcto.
   */
  async addNote(contactId: number, text: string): Promise<void> {
    await this.request("POST", ENDPOINTS.contactNote(contactId), {
      body: { text },
    });
  }

  /**
   * Mueve al contacto a la etapa indicada del workflow de Oportunidades,
   * actualizando su campo `opportunity_status`. Requiere haber completado
   * el ID real de esa etapa en .env (TOKKO_STAGE_*) — confirmados en tu
   * cuenta: tomar_accion=344783 (estado por defecto de todo contacto
   * nuevo), cerrado=344780. El resto hay que buscarlos (ver docs/SETUP.md).
   */
  async updateContactStage(contactId: number, stageKey: OpportunityStageKey): Promise<void> {
    const stageId = OPPORTUNITY_STAGES[stageKey];
    if (!stageId) {
      logger.warn("tokko.stage_not_configured", { stageKey });
      return;
    }
    await this.request("PATCH", ENDPOINTS.contactDetail(contactId), {
      body: { opportunity_status: stageId },
    });
  }
}

export const tokkoClient = new TokkoClient();
