import { config, OPPORTUNITY_STAGES, type OpportunityStageKey } from "../config.js";
import { logger } from "../logger.js";
import type {
  TokkoContact,
  TokkoListResponse,
  TokkoOpportunity,
  TokkoProperty,
  TokkoSearchFilters,
} from "./types.js";

/**
 * Cliente de la API de Tokko Broker.
 *
 * `/property/` (listado) fue verificado en vivo contra una cuenta real: la
 * paginación es por query params planos (`limit`/`offset`), y los campos de
 * cada propiedad (`operations`, `photos`, `location`, `room_amount`,
 * `public_url`, etc.) están confirmados. `/property/search/` en cambio
 * exige un parámetro `data` con una forma que no pudimos determinar sin la
 * documentación de la cuenta — por eso `searchProperties` filtra en el
 * servidor Node sobre el listado, en vez de depender de `/search/`.
 *
 * Los de contacto/nota/oportunidad (marcados "VERIFICAR") siguen la
 * convención REST general de Tokko pero no están confirmados contra la
 * cuenta real — revisalos contra la documentación de tu cuenta antes de
 * producción. Ver docs/SETUP.md.
 */
const ENDPOINTS = {
  propertyList: "/property/",
  propertyDetail: (id: number | string) => `/property/${id}/`,
  // VERIFICAR contra la documentación de tu cuenta:
  contactList: "/contact/",
  contactDetail: (id: number | string) => `/contact/${id}/`,
  contactNote: (id: number | string) => `/contact/${id}/note/`,
  opportunityList: "/opportunity/",
  opportunityDetail: (id: number | string) => `/opportunity/${id}/`,
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
    method: "GET" | "POST" | "PUT",
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

  /** VERIFICAR endpoint/campos contra tu documentación de Tokko. */
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

  /** VERIFICAR endpoint/campos contra tu documentación de Tokko. */
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

  /** VERIFICAR endpoint/campos contra tu documentación de Tokko. */
  async addNote(contactId: number, text: string): Promise<void> {
    await this.request("POST", ENDPOINTS.contactNote(contactId), {
      body: { text },
    });
  }

  /** VERIFICAR endpoint/campos contra tu documentación de Tokko. */
  async findOpenOpportunityForContact(contactId: number): Promise<TokkoOpportunity | null> {
    try {
      const result = await this.request<{ objects: TokkoOpportunity[] }>(
        "GET",
        ENDPOINTS.opportunityList,
        { params: { contact: String(contactId) } },
      );
      return result.objects?.[0] ?? null;
    } catch (error) {
      logger.warn("tokko.find_opportunity_failed", { contactId, error: String(error) });
      return null;
    }
  }

  /** VERIFICAR endpoint/campos contra tu documentación de Tokko. */
  async createOpportunity(contactId: number): Promise<TokkoOpportunity> {
    return this.request<TokkoOpportunity>("POST", ENDPOINTS.opportunityList, {
      body: { contact: contactId, status: OPPORTUNITY_STAGES.new },
    });
  }

  /** Busca una oportunidad abierta para el contacto o crea una nueva. */
  async ensureOpportunity(contactId: number): Promise<TokkoOpportunity> {
    const existing = await this.findOpenOpportunityForContact(contactId);
    if (existing) return existing;
    logger.info("tokko.creating_opportunity", { contactId });
    return this.createOpportunity(contactId);
  }

  /**
   * VERIFICAR: mueve la oportunidad del contacto a la etapa indicada del
   * workflow. Requiere haber completado los IDs reales de etapa en .env
   * (TOKKO_STAGE_*), tal como figuran en el panel de Oportunidades de Tokko.
   */
  async updateOpportunityStage(
    opportunityId: number,
    stageKey: OpportunityStageKey,
  ): Promise<void> {
    const stageId = OPPORTUNITY_STAGES[stageKey];
    if (!stageId) {
      logger.warn("tokko.stage_not_configured", { stageKey });
      return;
    }
    await this.request("PUT", ENDPOINTS.opportunityDetail(opportunityId), {
      body: { status: stageId },
    });
  }
}

export const tokkoClient = new TokkoClient();
