import { UNIT_LABELS, type SaleUnit, type Unit } from "@/lib/db/protocol";

const MAPUTO_OFFSET_MS = 2 * 60 * 60 * 1000;

const moneyFormatter = new Intl.NumberFormat("pt-MZ", {
  style: "currency",
  currency: "MZN",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const dateTimeFormatter = new Intl.DateTimeFormat("pt-MZ", {
  timeZone: "Africa/Maputo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const dateFormatter = new Intl.DateTimeFormat("pt-MZ", {
  timeZone: "Africa/Maputo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const timeFormatter = new Intl.DateTimeFormat("pt-MZ", {
  timeZone: "Africa/Maputo",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export function formatMzn(cents: number): string {
  return moneyFormatter.format((Number.isFinite(cents) ? cents : 0) / 100);
}

export function formatMznPlain(cents: number): string {
  return ((Number.isFinite(cents) ? cents : 0) / 100).toFixed(2).replace(".", ",");
}

export function parseMzn(value: string): number {
  const text = String(value ?? "")
    .replace(/mzn/gi, "")
    .replace(/\s/g, "")
    .trim();
  if (!text) return 0;
  let normalized = text;
  const hasComma = text.includes(",");
  const hasDot = text.includes(".");
  if (hasComma) {
    normalized = text.replace(/\./g, "").replace(",", ".");
  } else if (hasDot) {
    const parts = text.split(".");
    const looksLikeThousands = parts.length > 2 || (parts.length === 2 && parts[1].length === 3 && parts[0].length <= 3);
    if (looksLikeThousands) normalized = text.replace(/\./g, "");
  }
  const number = Number(normalized);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.round(number * 100);
}

export function formatQty(milli: number): string {
  const value = (Number.isFinite(milli) ? milli : 0) / 1000;
  return new Intl.NumberFormat("pt-MZ", { maximumFractionDigits: 3 }).format(value);
}

export function formatSaleUnit(saleUnit: SaleUnit, unit: Unit): string {
  if (saleUnit === "package") return "pacote";
  if (saleUnit === "half_package") return "meia embalagem";
  return UNIT_LABELS[unit].toLowerCase();
}

export function qtyToInput(milli: number): string {
  const value = (Number.isFinite(milli) ? milli : 0) / 1000;
  return String(value).replace(".", ",");
}

export function parseQty(value: string): number {
  const text = String(value ?? "").replace(/\s/g, "").trim();
  if (!text) return 0;
  const normalized = text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text;
  const number = Number(normalized);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.round(number * 1000);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return dateTimeFormatter.format(date);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return dateFormatter.format(date);
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return timeFormatter.format(date);
}

function maputoParts(date: Date) {
  const shifted = new Date(date.getTime() + MAPUTO_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
}

export function startOfMaputoDay(date = new Date()): string {
  const { year, month, day } = maputoParts(date);
  return new Date(Date.UTC(year, month, day) - MAPUTO_OFFSET_MS).toISOString();
}

export function endOfMaputoDay(date = new Date()): string {
  const { year, month, day } = maputoParts(date);
  return new Date(Date.UTC(year, month, day + 1) - MAPUTO_OFFSET_MS).toISOString();
}

export function maputoDayFromInput(value: string, end = false): string {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return end ? endOfMaputoDay() : startOfMaputoDay();
  return new Date(Date.UTC(year, month - 1, day + (end ? 1 : 0)) - MAPUTO_OFFSET_MS).toISOString();
}

export function todayInput(): string {
  const { year, month, day } = maputoParts(new Date());
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function formatPercentBp(bp: number): string {
  return `${(bp / 100).toFixed(0)}%`;
}

export function initials(name: string): string {
  return String(name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
