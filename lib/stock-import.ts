import type { StockImportItem } from "@/lib/db/protocol";

export const STOCK_IMPORT_DRAFT_KEY = "pos-stock-import-draft";

export interface StockImportDraft {
  documentRef: string;
  items: StockImportItem[];
}

type SpreadsheetModule = typeof import("xlsx");

function normalizedKey(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

function cellText(XLSX: SpreadsheetModule, sheet: import("xlsx").WorkSheet, address: string): string {
  const cell = sheet[address];
  return cell ? XLSX.utils.format_cell(cell).trim() : "";
}

function cellNumber(sheet: import("xlsx").WorkSheet, address: string): number | null {
  const cell = sheet[address];
  if (!cell || cell.v === null || cell.v === undefined || cell.v === "") return null;
  if (typeof cell.v === "number") return Number.isFinite(cell.v) ? cell.v : null;

  const text = String(cell.v).replace(/\s/g, "");
  const comma = text.lastIndexOf(",");
  const dot = text.lastIndexOf(".");
  const normalized = comma >= 0 && dot >= 0
    ? (comma > dot ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, ""))
    : text.replace(",", ".");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

export async function parseStockImportWorkbook(file: File): Promise<StockImportDraft> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", raw: true });
  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : null;
  if (!sheet || !sheet["!ref"]) throw new Error("O ficheiro não contém uma folha com dados.");

  const range = XLSX.utils.decode_range(sheet["!ref"]);
  const grouped = new Map<string, StockImportItem>();
  const errors: string[] = [];

  for (let rowIndex = 5; rowIndex <= range.e.r; rowIndex += 1) {
    const rowNumber = rowIndex + 1;
    const values = ["B", "C", "E", "J", "K", "L"].map((column) => sheet[`${column}${rowNumber}`]?.v);
    if (values.every((value) => value === undefined || value === null || value === "")) continue;

    const sku = cellText(XLSX, sheet, `B${rowNumber}`);
    const name = cellText(XLSX, sheet, `C${rowNumber}`);
    const color = cellText(XLSX, sheet, `E${rowNumber}`);
    const quantity = cellNumber(sheet, `J${rowNumber}`);
    const unitCost = cellNumber(sheet, `K${rowNumber}`);
    const invoiceValue = cellNumber(sheet, `L${rowNumber}`);
    const rawInvoiceValue = sheet[`L${rowNumber}`]?.v;

    const missing = [
      !sku ? "SKU" : "",
      !name ? "nome" : "",
      !color ? "cor" : "",
      quantity === null ? "quantidade" : "",
      unitCost === null ? "preço de custo" : "",
      rawInvoiceValue !== undefined && rawInvoiceValue !== null && rawInvoiceValue !== "" && invoiceValue === null ? "valor total" : "",
    ].filter(Boolean);
    if (missing.length > 0) {
      errors.push(`linha ${rowNumber}: falta ${missing.join(", ")}`);
      continue;
    }
    if (quantity === null || unitCost === null || !Number.isInteger(quantity) || quantity <= 0 || unitCost < 0) {
      errors.push(`linha ${rowNumber}: quantidade ou preço inválido`);
      continue;
    }

    const calculatedValue = quantity * unitCost;
    const value = invoiceValue ?? calculatedValue;
    if (value < 0 || !Number.isFinite(value)) {
      errors.push(`linha ${rowNumber}: valor total inválido`);
      continue;
    }

    const qtyMilli = quantity * 1000;
    const purchaseCostMinor = Math.round(calculatedValue * 100);
    const valueMinor = Math.round(value * 100);
    if (![qtyMilli, purchaseCostMinor, valueMinor].every(Number.isSafeInteger)) {
      errors.push(`linha ${rowNumber}: quantidade ou valor excede o limite suportado`);
      continue;
    }

    const key = [sku, name, color].map(normalizedKey).join("\u0000");
    const current = grouped.get(key);
    if (current) {
      current.qtyMilli += qtyMilli;
      current.purchaseCostMinor += purchaseCostMinor;
      current.valueMinor += valueMinor;
      current.lineCount += 1;
      if (![current.qtyMilli, current.purchaseCostMinor, current.valueMinor].every(Number.isSafeInteger)) {
        errors.push(`linha ${rowNumber}: o total agrupado excede o limite suportado`);
      }
    } else {
      grouped.set(key, {
        sku,
        name,
        color,
        qtyMilli,
        purchaseCostMinor,
        valueMinor,
        lineCount: 1,
        salePriceCents: null,
      });
    }
  }

  if (errors.length > 0) throw new Error(`Corrija os dados do ficheiro antes de continuar: ${errors.slice(0, 5).join("; ")}.`);
  const items = [...grouped.values()];
  if (items.length === 0) throw new Error("Não foram encontrados produtos a partir da linha 6.");
  if (items.length > 500) throw new Error("O ficheiro tem mais de 500 produtos distintos.");

  return {
    documentRef: cellText(XLSX, sheet, "B2"),
    items,
  };
}
