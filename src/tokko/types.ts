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
}

export interface TokkoListResponse {
  meta?: { limit?: number; offset?: number; total_count?: number };
  objects: TokkoProperty[];
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
