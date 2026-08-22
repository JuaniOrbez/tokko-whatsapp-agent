import { config, OPPORTUNITY_STAGES, type OpportunityStageKey } from "../config.js";
import { logger } from "../logger.js";
import type {
  TokkoContact,
  TokkoOpportunity,
  TokkoProperty,
  TokkoSearchFilters,
  TokkoSearchResponse,
} from "./types.js";

/**
 * Cliente de la API de Tokko Broker.
 *
 * Los endpoints de búsqueda/detalle de propiedades (`/property/...`) son los
 * documentados públicamente y estables. Los de contacto/nota/oportunidad
 * (marcados como "VERIFICAR") siguen la convención REST general de Tokko
 * pero hay que confirmarlos con la documentación real de tu cuenta
 * (https://www.tokkobroker.com/api/v1/docs/ con tu API key) antes de usarlos
 * en producción — no tuve acceso a internet para verificarlos al escribir
 * este scaffold. Ver docs/SETUP.md.
 */
const ENDPOINTS = {
  propertySearch: "/property/search/",
  propertyDetail: (id: number | string) => `/property/${id}/`,
  // VERIFICAR contra la documentación de tu cuenta:
  contactList: "/contact/",
  contactDetail: (id: number | string) => `/contact/${id}/`,
  contactNote: (id: number | string) => `/contact/${id}/note/`,
  opportunityList: "/opportunity/",
  opportunityDetail: (id: number | string) => `/opportunity/${id}/`,
};

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

  async searchProperties(filters: TokkoSearchFilters): Promise<TokkoProperty[]> {
    const data: Record<string, unknown> = {
      limit: filters.limit ?? 5,
    };
    if (filters.operationTypes) data.operation_types = filters.operationTypes;
    if (filters.propertyTypes) data.property_types = filters.propertyTypes;
    if (filters.priceFrom !== undefined) data.price_from = filters.priceFrom;
    if (filters.priceTo !== undefined) data.price_to = filters.priceTo;
    if (filters.currency) data.currency = filters.currency;
    if (filters.locationId) data.location_id = filters.locationId;
    if (filters.roomAmountFrom) data.room_amount_from = filters.roomAmountFrom;

    const result = await this.request<TokkoSearchResponse>("GET", ENDPOINTS.propertySearch, {
      params: { data: JSON.stringify(data) },
    });
    return result.objects ?? [];
  }

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
