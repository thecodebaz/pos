import { addDays, addMonths, daysBetween, formatInputDate, parseInputDate, startOfMonth } from "@/lib/date-range";

export type DailySalePoint = { date: string; totalCents: number; count: number };
export type SalesChartPoint = { label: string; totalCents: number; count: number };
export type SalesGranularity = "day" | "week" | "month";

const dayFormatter = new Intl.DateTimeFormat("pt-MZ", {
  day: "2-digit",
  month: "short",
  timeZone: "UTC",
});
const monthFormatter = new Intl.DateTimeFormat("pt-MZ", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC",
});

export const SALES_GRANULARITY_LABEL: Record<SalesGranularity, string> = {
  day: "Diário",
  week: "Semanal",
  month: "Mensal",
};

export function salesGranularity(from: string, to: string): SalesGranularity {
  const span = Math.max(0, daysBetween(from, to)) + 1;
  if (span <= 31) return "day";
  if (span <= 120) return "week";
  return "month";
}

function labelForDay(value: string): string {
  return dayFormatter.format(new Date(`${value}T12:00:00Z`));
}

function labelForMonth(value: string): string {
  return monthFormatter.format(new Date(`${value}-01T12:00:00Z`));
}

function bucketKeyFor(date: string, from: string, granularity: SalesGranularity): string {
  if (granularity === "day") return date;
  if (granularity === "week") return `w${Math.floor(daysBetween(from, date) / 7)}`;
  return date.slice(0, 7);
}

/**
 * Converte a série diária devolvida pelo worker em pontos agregados para o
 * gráfico. Os intervalos vazios são mantidos a zero para a linha não "saltar".
 */
export function bucketSales(daily: DailySalePoint[], from: string, to: string): SalesChartPoint[] {
  const granularity = salesGranularity(from, to);
  const buckets = new Map<string, SalesChartPoint>();

  if (daily.length === 0 || from > to) return [];

  if (granularity === "day") {
    for (let day = from; day <= to; day = addDays(day, 1)) {
      buckets.set(day, { label: labelForDay(day), totalCents: 0, count: 0 });
    }
  } else if (granularity === "week") {
    const span = daysBetween(from, to);
    for (let offset = 0; offset <= span; offset += 7) {
      const start = addDays(from, offset);
      buckets.set(`w${offset / 7}`, { label: labelForDay(start), totalCents: 0, count: 0 });
    }
  } else {
    let month = startOfMonth(from);
    const lastMonth = startOfMonth(to);
    while (month <= lastMonth) {
      buckets.set(month.slice(0, 7), { label: labelForMonth(month), totalCents: 0, count: 0 });
      month = addMonths(month, 1);
    }
  }

  for (const row of daily) {
    if (row.date < from || row.date > to) continue;
    const key = bucketKeyFor(row.date, from, granularity);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.totalCents += row.totalCents;
    bucket.count += row.count;
  }

  return [...buckets.values()];
}

export function monthInput(date: Date): string {
  return formatInputDate(date).slice(0, 7);
}

export function firstOfMonthInput(value: string): Date {
  return parseInputDate(`${value}-01`);
}
