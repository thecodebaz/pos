import { todayInput } from "@/lib/format";

export type DateRange = { from: string; to: string };

export type DateRangePresetId =
  | "today"
  | "yesterday"
  | "last7"
  | "thisWeek"
  | "last30"
  | "thisMonth"
  | "lastMonth"
  | "all";

export type ResolvedDateRangePreset = DateRangePresetId | "custom";

export const ALL_TIME_FROM = "1970-01-01";

/**
 * As datas da app são dias de Maputo em `YYYY-MM-DD`. Os objetos Date criados
 * aqui são apenas representações do dia mostrado no calendário (meio-dia local
 * para evitar diffs de DST); a conversão para ISO de Maputo é feita pelos
 * callers com `maputoDayFromInput`.
 */
export function parseInputDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  }
  return new Date(year, month - 1, day, 12);
}

export function formatInputDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function addDays(value: string, days: number): string {
  const date = parseInputDate(value);
  date.setDate(date.getDate() + days);
  return formatInputDate(date);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseInputDate(to).getTime() - parseInputDate(from).getTime()) / 86_400_000);
}

export function startOfMonth(value: string): string {
  const date = parseInputDate(value);
  return formatInputDate(new Date(date.getFullYear(), date.getMonth(), 1, 12));
}

export function addMonths(value: string, months: number): string {
  const date = parseInputDate(value);
  return formatInputDate(new Date(date.getFullYear(), date.getMonth() + months, 1, 12));
}

export function lastDayOfMonth(value: string): string {
  const date = parseInputDate(value);
  return formatInputDate(new Date(date.getFullYear(), date.getMonth() + 1, 0, 12));
}

export const DATE_RANGE_PRESETS: { id: DateRangePresetId; label: string; range: () => DateRange }[] = [
  {
    id: "today",
    label: "Hoje",
    range: () => {
      const today = todayInput();
      return { from: today, to: today };
    },
  },
  {
    id: "yesterday",
    label: "Ontem",
    range: () => {
      const yesterday = addDays(todayInput(), -1);
      return { from: yesterday, to: yesterday };
    },
  },
  {
    id: "last7",
    label: "Últimos 7 dias",
    range: () => ({ from: addDays(todayInput(), -6), to: todayInput() }),
  },
  {
    id: "thisWeek",
    label: "Esta semana",
    range: () => {
      const today = todayInput();
      const date = parseInputDate(today);
      const mondayOffset = (date.getDay() + 6) % 7;
      return { from: addDays(today, -mondayOffset), to: today };
    },
  },
  {
    id: "last30",
    label: "Últimos 30 dias",
    range: () => ({ from: addDays(todayInput(), -29), to: todayInput() }),
  },
  {
    id: "thisMonth",
    label: "Este mês",
    range: () => ({ from: startOfMonth(todayInput()), to: todayInput() }),
  },
  {
    id: "lastMonth",
    label: "Mês anterior",
    range: () => {
      const previousMonth = addMonths(startOfMonth(todayInput()), -1);
      return { from: previousMonth, to: lastDayOfMonth(previousMonth) };
    },
  },
  {
    id: "all",
    label: "Todo o período",
    range: () => ({ from: ALL_TIME_FROM, to: todayInput() }),
  },
];

export function getDateRangePreset(id: DateRangePresetId): DateRange {
  return (DATE_RANGE_PRESETS.find((preset) => preset.id === id) ?? DATE_RANGE_PRESETS[0]).range();
}

export function resolveDateRangePreset(value: DateRange): ResolvedDateRangePreset {
  return DATE_RANGE_PRESETS.find((preset) => {
    const range = preset.range();
    return range.from === value.from && range.to === value.to;
  })?.id ?? "custom";
}

const shortDateFormatter = new Intl.DateTimeFormat("pt-MZ", {
  day: "2-digit",
  month: "short",
  timeZone: "UTC",
});
const longDateFormatter = new Intl.DateTimeFormat("pt-MZ", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function formatRangeDate(value: string, long: boolean): string {
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return (long ? longDateFormatter : shortDateFormatter).format(date);
}

export function dateRangeLabel(value: DateRange): string {
  const presetId = resolveDateRangePreset(value);
  if (presetId !== "custom") {
    return DATE_RANGE_PRESETS.find((preset) => preset.id === presetId)?.label ?? "Personalizado";
  }
  if (value.from === value.to) return formatRangeDate(value.from, true);
  return `${formatRangeDate(value.from, false)} – ${formatRangeDate(value.to, true)}`;
}
