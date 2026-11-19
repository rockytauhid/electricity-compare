import type { RetailerRates, UsageDay } from "./bill";
import { prepareUsage, type PreparedUsage } from "./bill";
import { Decimal, excelSerialToIso, parseDecimal, roundKwh } from "./money";
import * as XLSX from "xlsx";

export type CellGrid = string[][];

export type RetailerParse = {
  retailers: RetailerRates[];
  errors: string[];
  warnings: string[];
};

export type UsageParse = {
  usage: PreparedUsage | null;
  errors: string[];
};

const RETAILER_COLUMNS = {
  name: ["retailer", "name", "plan", "planname"],
  membershipFee: ["membershipfee", "membership"],
  supplyCharge: ["supplycharge", "dailysupplycharge", "dailysupply", "supply"],
  usageRate: ["usagerate", "singlerate", "flatrate"],
  feedInRate: ["feedinrate", "fit", "solarrate", "solarfit"],
  afterLimitFit: ["afterlimitfit", "afterlimitrate", "excessfit"],
  feedInLimit: ["feedinlimit", "fitlimit", "exportlimit", "dailycap"],
} as const;

const USAGE_COLUMNS = {
  date: ["date", "readdate", "day"],
  importKwh: ["consumptionkwh", "consumption", "importkwh", "import", "importedkwh", "usagekwh"],
  exportKwh: ["soldtogridkwh", "soldtogrid", "exportkwh", "export", "exportedkwh", "feedinkwh"],
} as const;

function norm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isRowEmpty(row: string[]): boolean {
  return row.every((cell) => cell.trim() === "");
}

const OPTIONAL_RETAILER_FIELDS = new Set<keyof typeof RETAILER_COLUMNS>([
  "membershipFee",
  "afterLimitFit",
  "feedInLimit",
]);

type ColumnMap<T extends Record<string, readonly string[]>> = Partial<Record<keyof T, number>>;

function matchColumns<T extends Record<string, readonly string[]>>(
  header: string[],
  aliases: T,
  optionalFields?: ReadonlySet<keyof T>,
): { columns: ColumnMap<T> | null; missing: string[] } {
  const indexes = new Map<string, number>();
  header.forEach((cell, index) => {
    const key = norm(cell);
    if (key && !indexes.has(key)) indexes.set(key, index);
  });

  const columns: ColumnMap<T> = {};
  const missing: string[] = [];
  for (const [field, names] of Object.entries(aliases) as [keyof T, readonly string[]][]) {
    const found = names.map((name) => indexes.get(name)).find((index) => index !== undefined);
    if (found === undefined) {
      if (!optionalFields?.has(field)) missing.push(String(field));
    } else {
      columns[field] = found;
    }
  }
  return { columns: missing.length === 0 ? columns : null, missing };
}

function headerFlags(header: string[]): { timeOfUse: boolean; controlledLoad: boolean; ev: boolean } {
  const keys = header.map(norm);
  return {
    timeOfUse: keys.includes("peakrate"),
    controlledLoad: keys.some((key) => key.includes("controlledload")),
    ev: keys.includes("evrate") || keys.includes("dailyevkwh"),
  };
}

function blockedReason(header: string[]): string | null {
  const flags = headerFlags(header);
  if (flags.timeOfUse) {
    return "This table has time-of-use rates. This page calculates single-rate plans only.";
  }
  if (flags.controlledLoad) {
    return "This table includes controlled load. This page does not price controlled load yet.";
  }
  if (flags.ev) {
    return "This table includes EV charging. This page does not price EV charging yet.";
  }
  return null;
}

function findHeader<T extends Record<string, readonly string[]>>(
  grid: CellGrid,
  aliases: T,
  optionalFields?: ReadonlySet<keyof T>,
): { headerIndex: number; columns: ColumnMap<T> } | { error: string } | null {
  const limit = Math.min(grid.length, 15);
  for (let index = 0; index < limit; index += 1) {
    const header = grid[index] ?? [];
    if (isRowEmpty(header)) continue;
    const blocked = blockedReason(header);
    if (blocked) return { error: blocked };
    const matched = matchColumns(header, aliases, optionalFields);
    if (matched.columns) return { headerIndex: index, columns: matched.columns };
  }
  return null;
}

export function parseDateCell(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null;
  const datePart = value.split(/[ T]/)[0] ?? value;

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  if (iso) return calendarDate(iso[1], iso[2], iso[3]);

  const dayFirst = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(datePart);
  if (dayFirst) return calendarDate(dayFirst[3], dayFirst[2], dayFirst[1]);

  if (/^\d+(\.\d+)?$/.test(datePart)) {
    const serial = Number(datePart);
    if (serial >= 20_000 && serial <= 80_000) return excelSerialToIso(serial);
  }
  return null;
}

function calendarDate(yearText: string, monthText: string, dayText: string): string | null {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const DEFAULT_FEED_IN_LIMIT = new Decimal(999);
const MAX_PLAUSIBLE_SUPPLY_DOLLARS = new Decimal(20);
const MAX_PLAUSIBLE_RATE_DOLLARS = new Decimal(5);

function cellAt(row: string[], index: number | undefined): string {
  return index === undefined ? "" : (row[index] ?? "");
}

export function parseRetailerGrid(grid: CellGrid, label = "Retailer rates"): RetailerParse {
  const found = findHeader(grid, RETAILER_COLUMNS, OPTIONAL_RETAILER_FIELDS);
  if (!found) {
    return {
      retailers: [],
      errors: [`${label}: no single-rate retailer header row was found.`],
      warnings: [],
    };
  }
  if ("error" in found) {
    return { retailers: [], errors: [`${label}: ${found.error}`], warnings: [] };
  }

  const retailers: RetailerRates[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  for (let index = found.headerIndex + 1; index < grid.length; index += 1) {
    const row = grid[index] ?? [];
    if (isRowEmpty(row)) continue;
    const rowNumber = index + 1;
    const name = cellAt(row, found.columns.name).trim();
    if (name === "") {
      errors.push(`${label} row ${rowNumber}: missing retailer name.`);
      continue;
    }
    try {
      const membershipRaw = cellAt(row, found.columns.membershipFee).trim();
      const afterLimitRaw = cellAt(row, found.columns.afterLimitFit).trim();
      const feedInLimitRaw = cellAt(row, found.columns.feedInLimit).trim();

      const supplyCharge = parseDecimal(cellAt(row, found.columns.supplyCharge));
      const usageRate = parseDecimal(cellAt(row, found.columns.usageRate));
      const feedInRate = parseDecimal(cellAt(row, found.columns.feedInRate));
      const afterLimitFit = afterLimitRaw === "" ? new Decimal(0) : parseDecimal(afterLimitRaw);
      const feedInLimit = feedInLimitRaw === "" ? DEFAULT_FEED_IN_LIMIT : parseDecimal(feedInLimitRaw);

      if (
        supplyCharge.greaterThan(MAX_PLAUSIBLE_SUPPLY_DOLLARS) ||
        usageRate.greaterThan(MAX_PLAUSIBLE_RATE_DOLLARS) ||
        feedInRate.greaterThan(MAX_PLAUSIBLE_RATE_DOLLARS) ||
        afterLimitFit.greaterThan(MAX_PLAUSIBLE_RATE_DOLLARS)
      ) {
        warnings.push(
          `${label} row ${rowNumber} (${name}): rates look unusually high for dollars. Enter rates in dollars, not cents.`,
        );
      }

      retailers.push({
        name,
        membershipFee: membershipRaw === "" ? new Decimal(0) : parseDecimal(membershipRaw),
        supplyCharge,
        usageRate,
        feedInRate,
        afterLimitFit,
        feedInLimit,
      });
    } catch {
      errors.push(`${label} row ${rowNumber}: a rate cell is blank or not a number.`);
    }
  }

  if (retailers.length === 0 && errors.length === 0) {
    errors.push(`${label}: the header was found, and there were no retailer rows.`);
  }
  if (errors.length > 0) return { retailers: [], errors, warnings: [] };
  return { retailers, errors: [], warnings };
}

export function parseUsageGrid(grid: CellGrid, label = "Usage"): UsageParse {
  const found = findHeader(grid, USAGE_COLUMNS);
  if (!found) {
    return { usage: null, errors: [`${label}: no daily usage header row was found.`] };
  }
  if ("error" in found) return { usage: null, errors: [`${label}: ${found.error}`] };

  const days: UsageDay[] = [];
  const errors: string[] = [];
  for (let index = found.headerIndex + 1; index < grid.length; index += 1) {
    const row = grid[index] ?? [];
    if (isRowEmpty(row)) continue;
    const rowNumber = index + 1;
    const rawDate = cellAt(row, found.columns.date);
    const date = parseDateCell(rawDate);
    if (!date) {
      errors.push(`${label} row ${rowNumber}: "${rawDate}" is not a date. Use YYYY-MM-DD or DD/MM/YYYY.`);
      continue;
    }
    try {
      const importKwh = roundKwh(parseDecimal(cellAt(row, found.columns.importKwh)));
      const exportKwh = roundKwh(parseDecimal(cellAt(row, found.columns.exportKwh)));
      if (importKwh.isNegative() || exportKwh.isNegative()) {
        errors.push(`${label} row ${rowNumber}: import and export must be zero or positive.`);
        continue;
      }
      days.push({ date, importKwh, exportKwh });
    } catch {
      errors.push(`${label} row ${rowNumber}: import or export is blank or not a number.`);
    }
  }

  if (errors.length > 0) return { usage: null, errors };
  if (days.length === 0) {
    return { usage: null, errors: [`${label}: the header was found, and there were no usage rows.`] };
  }
  return { usage: prepareUsage(days), errors: [] };
}

export function splitTable(text: string): CellGrid {
  const cleaned = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = cleaned.split("\n").filter((line) => line.trim() !== "");
  if (lines.some((line) => line.includes("\t"))) {
    return lines.map((line) => line.split("\t").map((cell) => cell.trim()));
  }
  return lines.map(parseCsvLine);
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inQuotes) {
      if (char === "\"") {
        if (line[index + 1] === "\"") {
          current += "\"";
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"") {
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function isDateFormat(format: unknown): boolean {
  if (typeof format !== "string") return false;
  const checker = (XLSX.SSF as { is_date?: (fmt: string) => boolean }).is_date;
  if (typeof checker === "function") return checker(format);
  return /d/i.test(format) && /y/i.test(format);
}

export function sheetToGrid(sheet: XLSX.WorkSheet): CellGrid {
  const ref = sheet["!ref"];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const grid: CellGrid = [];
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    const cells: string[] = [];
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })] as XLSX.CellObject | undefined;
      cells.push(cellText(cell));
    }
    grid.push(cells);
  }
  return grid;
}

function cellText(cell: XLSX.CellObject | undefined): string {
  if (!cell || cell.v == null) return "";
  if (typeof cell.v === "number" && isDateFormat(cell.z)) return excelSerialToIso(cell.v);
  if (typeof cell.v === "number") {
    const formatted = typeof cell.w === "string" ? cell.w.trim() : "";
    if (formatted !== "") {
      try {
        parseDecimal(formatted);
        return formatted;
      } catch {
        // Fall back to raw numeric value if formatted text is non-numeric (e.g. accounting "-")
      }
    }
    return String(cell.v);
  }
  if (cell.v instanceof Date) {
    const year = String(cell.v.getUTCFullYear()).padStart(4, "0");
    const month = String(cell.v.getUTCMonth() + 1).padStart(2, "0");
    const day = String(cell.v.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return String(cell.v).trim();
}

export type LoadedTables = {
  retailers: RetailerRates[] | null;
  usage: PreparedUsage | null;
  errors: string[];
  warnings: string[];
};

export function interpretGrids(sheets: { label: string; grid: CellGrid }[]): LoadedTables {
  const errors: string[] = [];
  const warnings: string[] = [];
  let retailers: RetailerRates[] | null = null;
  let retailerSheetLabel: string | null = null;
  let usage: PreparedUsage | null = null;
  let usageSheetLabel: string | null = null;
  let sawKnownSheet = false;

  for (const sheet of sheets) {
    const retailerHeader = findHeader(sheet.grid, RETAILER_COLUMNS, OPTIONAL_RETAILER_FIELDS);
    const usageHeader = findHeader(sheet.grid, USAGE_COLUMNS);
    if (retailerHeader && "error" in retailerHeader) {
      sawKnownSheet = true;
      errors.push(`${sheet.label}: ${retailerHeader.error}`);
      continue;
    }
    if (usageHeader && "error" in usageHeader) {
      sawKnownSheet = true;
      errors.push(`${sheet.label}: ${usageHeader.error}`);
      continue;
    }
    if (retailerHeader && !("error" in retailerHeader)) {
      sawKnownSheet = true;
      const parsed = parseRetailerGrid(sheet.grid, sheet.label);
      errors.push(...parsed.errors);
      if (parsed.errors.length === 0) {
        if (retailerSheetLabel !== null) {
          warnings.push(
            `Multiple retailer rate sheets found ("${retailerSheetLabel}" and "${sheet.label}"). Using "${sheet.label}".`,
          );
        }
        retailers = parsed.retailers;
        retailerSheetLabel = sheet.label;
        warnings.push(...parsed.warnings);
      }
      continue;
    }
    if (usageHeader && !("error" in usageHeader)) {
      sawKnownSheet = true;
      const parsed = parseUsageGrid(sheet.grid, sheet.label);
      errors.push(...parsed.errors);
      if (parsed.usage) {
        if (usageSheetLabel !== null) {
          warnings.push(
            `Multiple daily usage sheets found ("${usageSheetLabel}" and "${sheet.label}"). Using "${sheet.label}".`,
          );
        }
        usage = parsed.usage;
        usageSheetLabel = sheet.label;
        warnings.push(...parsed.usage.warnings);
      }
    }
  }

  if (!sawKnownSheet) {
    errors.push("No single-rate retailer table or daily usage table was found.");
  }
  return { retailers, usage, errors, warnings };
}

export async function loadSpreadsheetFile(file: File): Promise<LoadedTables> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
    return interpretGrids([{ label: file.name, grid: splitTable(await file.text()) }]);
  }
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false, cellNF: true });
  const sheets = workbook.SheetNames.map((label) => ({
    label,
    grid: sheetToGrid(workbook.Sheets[label]),
  }));
  return interpretGrids(sheets);
}

export function loadPastedTable(text: string): LoadedTables {
  return interpretGrids([{ label: "Pasted table", grid: splitTable(text) }]);
}
