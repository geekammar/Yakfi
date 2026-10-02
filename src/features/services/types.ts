/** Serializable service view used by the services management UI. */
export type ServiceListItem = {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  isActive: boolean;
  /** Structured, OPTIONAL price columns (PROMPT-AI-ARCH-13 — Slice 6). */
  priceType: string | null;
  priceAmount: number | null;
  priceMaxAmount: number | null;
  priceCurrency: string | null;
  priceNote: string | null;
};

export type ServiceActionResult =
  | { success: true; service: ServiceListItem }
  | { success: false; message: string };
