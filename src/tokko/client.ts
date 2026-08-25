import { config, OPPORTUNITY_STAGES, type OpportunityStageKey } from "../config.js";
import { logger } from "../logger.js";
import type {
  TokkoContact,
  TokkoDevelopment,
  TokkoListResponse,
  TokkoProperty,
  TokkoSearchFilters,
} from "./types.js";

/**
 * Cliente de la API de Tokko Broker.
 *
 * Confirmado en vivo contra una cuenta real (ismo Propiedades):
 *
 * - `/property/` y `/contact/` (listados, GET) funcionan igual: paginación
 *   por query params planos (`limit`/`offset`). No existe un recurso
 *   "Oportunidad" separado — el estado del embudo vive en el campo
 *   `opportunity_status` (`{id, name, color, is_closed_status}`) de cada
 *   contacto. `/property/search/` exige un `data` cuyo formato no logramos
 *   determinar, por eso `searchProperties` filtra en el servidor Node sobre
 *   el listado de `/property/`.
 * - **Escribir directo sobre `/contact/{id}/` está bloqueado**: PATCH y
 *   POST devuelven el texto plano "GET" (parece un firewall/CDN delante de
 *   www.tokkobroker.com que solo deja pasar GET en esa ruta). Por eso
 *   `updateContactStage` va a seguir fallando hasta que Tokko habilite
 *   escritura ahí — lo dejamos igual por si lo habilitan más adelante, pero
 *   no confíes en que funcione hoy.
 * - **`POST /webcontact/` sí funciona** (devuelve 201) — es el endpoint que
 *   usan los portales externos (Zonaprop, etc.) para cargar leads. OJO: no
 *   crea un Contacto directamente, crea una "Consulta" en la bandeja
 *   Consultas → Pendientes de Tokko, que un humano tiene que convertir a
 *   mano en Contacto (con el botón "Crear un nuevo contacto") — no hay
 *   forma de saltear ese paso por API. Cada llamada crea una consulta
 *   nueva, no actualiza una existente.
 */
const ENDPOINTS = {
  propertyList: "/property/",
  propertyDetail: (id: number | string) => `/property/${id}/`,
  contactList: "/contact/",
  contactDetail: (id: number | string) => `/contact/${id}/`,
  webContact: "/webcontact/",
  developmentList: "/development/",
  developmentDetail: (id: number | string) => `/development/${id}/`,
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
    // Incluye también los datos del emprendimiento (development.*): el
    // nombre comercial de un proyecto (ej. "LA VECINDAD") suele figurar
    // solo ahí, no en location/address de cada unidad individual — sin
    // esto, buscar por el nombre del emprendimiento no encontraba ninguna
    // de sus unidades.
    const haystack = [
      property.location?.name,
      property.location?.full_location,
      property.address,
      property.development?.name,
      property.development?.address,
      property.development?.location?.name,
      property.development?.location?.full_location,
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

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Tokko API error ${response.status} (${method} ${path}): ${text}`);
    }
    // Algunos endpoints (ej. POST /webcontact/) responden 201 con body vacío.
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * Recorre el listado de propiedades (paginado) y filtra en el servidor
   * Node por operación, precio, ambientes y ubicación. Corta apenas junta
   * suficientes resultados o al llegar a MAX_PAGES_SCANNED — por eso
   * `matchedAtLeast` puede ser menor al total real si `exhausted` da false
   * (todavía puede haber más sin escanear). Nunca inventar un total exacto
   * a partir de esto cuando `exhausted` es false.
   */
  async searchProperties(
    filters: TokkoSearchFilters,
  ): Promise<{ items: TokkoProperty[]; matchedAtLeast: number; exhausted: boolean }> {
    const wanted = filters.limit ?? 5;
    const matches: TokkoProperty[] = [];
    let exhausted = false;

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
      if (scanned >= totalCount || objects.length === 0) {
        exhausted = true;
        break;
      }
      if (matches.length >= wanted) break;
    }

    return { items: matches.slice(0, wanted), matchedAtLeast: matches.length, exhausted };
  }

  /** Sigue la misma convención que `/property/` (confirmada) pero el detalle en sí no se probó en vivo. */
  async getProperty(id: number | string): Promise<TokkoProperty> {
    return this.request<TokkoProperty>("GET", ENDPOINTS.propertyDetail(id));
  }

  /**
   * Busca emprendimientos por nombre comercial o dirección. Sigue la misma
   * convención de listado paginado que `/property/`, pero `/development/`
   * en sí no está confirmado en vivo todavía — probar y ajustar
   * TokkoDevelopment en types.ts si los campos reales difieren.
   */
  async searchDevelopments(query: string, limit = 5): Promise<TokkoDevelopment[]> {
    const needle = query.trim().toLowerCase();
    const matches: TokkoDevelopment[] = [];

    for (let page = 0; page < MAX_PAGES_SCANNED; page++) {
      const result = await this.request<TokkoListResponse<TokkoDevelopment>>(
        "GET",
        ENDPOINTS.developmentList,
        { params: { limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) } },
      );
      const objects = result.objects ?? [];

      for (const development of objects) {
        const haystack = [development.name, development.address, development.location?.name]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (haystack.includes(needle)) matches.push(development);
      }

      const totalCount = result.meta?.total_count ?? objects.length;
      const scanned = (page + 1) * PAGE_SIZE;
      if (matches.length >= limit || scanned >= totalCount || objects.length === 0) break;
    }

    return matches.slice(0, limit);
  }

  /**
   * Confirmado en vivo: `/contact/` NO permite filtrar por `phone` — devuelve
   * 400 "The 'phone' field does not allow filtering." Con miles de contactos
   * en la cuenta, escanear todo el listado para buscar por teléfono no es
   * viable. Por ahora siempre devuelve null (orchestrator.ts ya lo trata
   * como "contacto no encontrado" y sigue con normalidad — ver
   * submitInquiry). Si Tokko habilita un filtro real, reemplazar esto.
   */
  async findContactByPhone(_phone: string): Promise<TokkoContact | null> {
    return null;
  }

  /**
   * Confirmado en vivo (POST → 201): manda una "Consulta" nueva a la
   * bandeja Consultas → Pendientes de Tokko para que la aprueben a mano —
   * no crea un Contacto directamente ni devuelve un ID usable. `tags` es
   * como Tokko identifica el origen (ver "Origen de contacto" en la ficha
   * de un contacto ya convertido).
   */
  async submitInquiry(input: {
    name: string;
    phone: string;
    text: string;
    tags?: string[];
  }): Promise<void> {
    await this.request("POST", ENDPOINTS.webContact, {
      body: {
        name: input.name,
        phone: input.phone,
        text: input.text,
        tags: input.tags ?? ["WhatsApp"],
      },
    });
  }

  /**
   * Mueve al contacto a la etapa indicada del workflow de Oportunidades,
   * actualizando su campo `opportunity_status`. Requiere haber completado
   * el ID real de esa etapa en .env (TOKKO_STAGE_*) — confirmados en tu
   * cuenta: tomar_accion=344783 (estado por defecto de todo contacto
   * nuevo), cerrado=344780. El resto hay que buscarlos (ver docs/SETUP.md).
   * NO FUNCIONA hoy (ver comentario arriba del archivo) — queda por si
   * Tokko habilita escritura sobre /contact/{id}/ más adelante.
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
