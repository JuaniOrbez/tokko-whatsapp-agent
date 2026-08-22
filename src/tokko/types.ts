export interface TokkoPhoto {
  image: string;
  is_front_cover?: boolean;
}

export interface TokkoOperation {
  operation_type: string;
  prices: Array<{ price: number; currency: string }>;
}

export interface TokkoProperty {
  id: number;
  publication_title?: string;
  type?: { name: string };
  address?: string;
  location?: { name: string };
  room_amount?: number;
  suite_amount?: number;
  total_surface?: number;
  covered_surface?: number;
  operations?: TokkoOperation[];
  photos?: TokkoPhoto[];
  description?: string;
  public_url?: string;
}

export interface TokkoSearchResponse {
  meta?: { total_count?: number };
  objects: TokkoProperty[];
}

export interface TokkoSearchFilters {
  operationTypes?: number[]; // 1=Alquiler, 2=Venta, 3=Alquiler temporal (confirmar en tu cuenta)
  propertyTypes?: number[];
  priceFrom?: number;
  priceTo?: number;
  currency?: string;
  locationId?: number;
  roomAmountFrom?: number;
  limit?: number;
}

export interface TokkoContact {
  id: number;
  name?: string;
  phone?: string;
  email?: string;
}

export interface TokkoOpportunity {
  id: number;
  contact?: number;
  status?: string | number;
}
