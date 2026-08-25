export interface TokkoPhoto {
  image: string;
  is_front_cover?: boolean;
}

export interface TokkoOperation {
  operation_id: number; // confirmado en tu cuenta: 1 = Venta
  operation_type: string;
  prices: Array<{ price: number; currency: string }>;
}

export interface TokkoLocation {
  name: string;
  full_location?: string;
}

export interface TokkoProperty {
  id: number;
  publication_title?: string;
  address?: string;
  location?: TokkoLocation;
  room_amount?: number;
  suite_amount?: number;
  // La API los devuelve como string (ej. "101.75"), no number.
  surface?: string;
  roofed_surface?: string;
  semiroofed_surface?: string;
  surface_measurement?: string;
  operations?: TokkoOperation[];
  photos?: TokkoPhoto[];
  description?: string;
  public_url?: string;
  // Confirmado en vivo: cuando la unidad pertenece a un emprendimiento, viene
  // este objeto anidado con su propia `location`. En al menos un caso real
  // (LA VECINDAD) la ubicación del emprendimiento era correcta (Coghlan)
  // mientras que la de cada unidad individual estaba mal cargada (Belgrano)
  // — por eso se prefiere `development.location` sobre `location` cuando
  // ambos existen (ver src/agent/tools.ts).
  development?: {
    id?: number;
    name?: string;
    address?: string;
    location?: TokkoLocation;
  };
}

export interface TokkoListResponse<T = TokkoProperty> {
  meta?: { limit?: number; offset?: number; total_count?: number };
  objects: T[];
}

/**
 * Sin confirmar en vivo todavía (a diferencia de TokkoProperty/TokkoContact) —
 * la forma exacta puede variar. Campos optativos a propósito; ajustar según
 * lo que devuelva /development/ real.
 */
export interface TokkoDevelopment {
  id: number;
  name?: string; // nombre comercial del emprendimiento
  address?: string;
  location?: TokkoLocation;
  description?: string;
  public_url?: string;
  photos?: TokkoPhoto[];
}

export interface TokkoSearchFilters {
  operationTypes?: number[]; // IDs reales en .env (TOKKO_OPERATION_ID_SALE / _RENT)
  priceFrom?: number;
  priceTo?: number;
  currency?: string;
  location?: string; // texto libre, matchea contra location.name / full_location
  roomAmountFrom?: number;
  limit?: number;
}

export interface TokkoOpportunityStatus {
  id: number;
  name: string;
  color?: string;
  is_closed_status?: boolean;
}

export interface TokkoContact {
  id: number;
  name?: string;
  phone?: string;
  email?: string;
  lead_status?: string;
  opportunity_status?: TokkoOpportunityStatus;
}
