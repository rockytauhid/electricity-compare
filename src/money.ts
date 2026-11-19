import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

export function parseDecimal(raw: string): Decimal {
  const cleaned = raw.trim().replace(/[$,\s]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === "+") {
    throw new Error("blank number");
  }
  const value = new Decimal(cleaned);
  if (!value.isFinite()) {
    throw new Error("not a finite number");
  }
  return value;
}

export function roundKwh(value: Decimal): Decimal {
  return value.toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
}

export function roundCents(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function formatMoney(value: Decimal): string {
  return `$${roundCents(value).toFixed(2)}`;
}

export function formatKwh(value: Decimal): string {
  return value.toDecimalPlaces(3, Decimal.ROUND_HALF_UP).toFixed(3);
}

export function formatRate(value: Decimal): string {
  const places = Math.min(6, Math.max(2, value.decimalPlaces()));
  return `$${value.toFixed(places)}`;
}

export function calendarDaysBetween(firstIso: string, lastIso: string): number {
  const first = Date.parse(`${firstIso}T00:00:00Z`);
  const last = Date.parse(`${lastIso}T00:00:00Z`);
  return Math.round((last - first) / 86_400_000);
}

/** Excel 1900 date system, including the fictional 29 February 1900. */
export function excelSerialToIso(serial: number): string {
  const wholeDays = Math.floor(serial);
  const utc = new Date(Date.UTC(1899, 11, 30) + wholeDays * 86_400_000);
  const year = utc.getUTCFullYear();
  const month = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const day = String(utc.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
