"use client";

import { useState } from "react";
import { CalendarDays, ChevronDown } from "lucide-react";
import { ptBR } from "date-fns/locale";
import type { DateRange as DayPickerRange } from "react-day-picker";
import { cn } from "cn";
import { formatDate, maputoDayFromInput, todayInput } from "@/lib/format";
import {
  DATE_RANGE_PRESETS,
  dateRangeLabel,
  formatInputDate,
  parseInputDate,
  resolveDateRangePreset,
  type DateRange,
} from "@/lib/date-range";
import { buttonVariants } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type DateRangeFilterProps = {
  value: DateRange;
  onChange: (range: DateRange) => void;
  className?: string;
  align?: "start" | "end" | "center";
};

export function DateRangeFilter({ value, onChange, className, align = "start" }: DateRangeFilterProps) {
  const [open, setOpen] = useState(false);
  const activePreset = resolveDateRangePreset(value);
  const selected: DayPickerRange = {
    from: parseInputDate(value.from),
    to: parseInputDate(value.to),
  };

  function applyPreset(id: (typeof DATE_RANGE_PRESETS)[number]["id"]) {
    const preset = DATE_RANGE_PRESETS.find((item) => item.id === id);
    if (!preset) return;
    onChange(preset.range());
    setOpen(false);
  }

  function handleSelect(range: DayPickerRange | undefined) {
    if (!range?.from) return;
    const from = formatInputDate(range.from);
    const to = formatInputDate(range.to ?? range.from);
    onChange({ from, to });
    if (range.to) setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        aria-label={`Período: ${dateRangeLabel(value)}`}
        className={cn(
          buttonVariants({ variant: "outline" }),
          "w-full justify-start gap-2 font-normal",
          className,
        )}
      >
        <CalendarDays className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{dateRangeLabel(value)}</span>
        <ChevronDown className="ml-auto size-4 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverContent align={align} className="w-auto p-0">
        <div className="flex flex-col sm:flex-row">
          <div className="flex gap-1 overflow-x-auto border-b p-2 sm:w-40 sm:shrink-0 sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r">
            {DATE_RANGE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyPreset(preset.id)}
                className={cn(
                  "shrink-0 rounded-md px-2 py-1.5 text-left text-xs whitespace-nowrap transition-colors hover:bg-accent hover:text-accent-foreground",
                  activePreset === preset.id
                    ? "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground"
                    : "text-muted-foreground",
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="min-w-0 p-2">
            <Calendar
              mode="range"
              locale={ptBR}
              defaultMonth={selected.from}
              selected={selected}
              onSelect={handleSelect}
              disabled={{ after: parseInputDate(todayInput()) }}
            />
          </div>
        </div>
        <div className="border-t px-3 py-2 text-[11px] text-muted-foreground">
          Período em hora de Maputo · {formatDate(maputoDayFromInput(value.from))} a {formatDate(maputoDayFromInput(value.to))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
