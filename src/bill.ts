import {
  calendarDaysBetween,
  Decimal,
  roundKwh,
} from "./money";

export type RetailerRates = {
  name: string;
  membershipFee: Decimal;
  supplyCharge: Decimal;
  usageRate: Decimal;
  feedInRate: Decimal;
  afterLimitFit: Decimal;
  feedInLimit: Decimal;
};

export type UsageDay = {
  date: string;
  importKwh: Decimal;
  exportKwh: Decimal;
};

export type PreparedUsage = {
  days: UsageDay[];
  firstDate: string;
  lastDate: string;
  supplyDays: number;
  totalImport: Decimal;
  totalExport: Decimal;
  warnings: string[];
};

export type BillBreakdown = {
  retailer: string;
  supply: Decimal;
  usage: Decimal;
  solar: Decimal;
  membership: Decimal;
  bill: Decimal;
};

export function dailySolarCredit(exportKwh: Decimal, retailer: RetailerRates): Decimal {
  const exported = Decimal.max(roundKwh(exportKwh), 0);
  const within = Decimal.min(exported, retailer.feedInLimit);
  const above = Decimal.max(exported.minus(retailer.feedInLimit), 0);
  return within.times(retailer.feedInRate).plus(above.times(retailer.afterLimitFit));
}

export function prepareUsage(days: UsageDay[]): PreparedUsage {
  const warnings: string[] = [];
  const byDate = new Map<string, UsageDay>();
  const duplicateDates = new Set<string>();

  for (const day of days) {
    const importKwh = roundKwh(day.importKwh);
    const exportKwh = roundKwh(day.exportKwh);
    const existing = byDate.get(day.date);
    if (!existing) {
      byDate.set(day.date, { date: day.date, importKwh, exportKwh });
      continue;
    }
    existing.importKwh = roundKwh(existing.importKwh.plus(importKwh));
    existing.exportKwh = roundKwh(existing.exportKwh.plus(exportKwh));
    duplicateDates.add(day.date);
  }

  const sorted = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const firstDate = sorted[0]?.date ?? "";
  const lastDate = sorted[sorted.length - 1]?.date ?? "";
  const supplyDays = sorted.length === 0 ? 0 : calendarDaysBetween(firstDate, lastDate);
  const totalImport = sorted.reduce((sum, day) => sum.plus(day.importKwh), new Decimal(0));
  const totalExport = sorted.reduce((sum, day) => sum.plus(day.exportKwh), new Decimal(0));

  if (duplicateDates.size > 0) {
    const listed = [...duplicateDates].sort().join(", ");
    warnings.push(
      `Rows with the same date were added together before the daily feed-in cap: ${listed}.`,
    );
  }

  if (sorted.length === 1) {
    warnings.push("Only one usage date was provided, so the supply charge is multiplied by 0 days.");
  } else if (sorted.length > 0 && sorted.length < supplyDays + 1) {
    warnings.push(
      `Missing dates between ${firstDate} and ${lastDate}. Supply is charged for all ${supplyDays} days in that span. Missing dates add no import or export.`,
    );
  }

  return { days: sorted, firstDate, lastDate, supplyDays, totalImport, totalExport, warnings };
}

export function compareBills(retailers: RetailerRates[], usage: PreparedUsage): BillBreakdown[] {
  return retailers
    .map((retailer) => {
      const supply = retailer.supplyCharge.times(usage.supplyDays);
      const usageCost = usage.totalImport.times(retailer.usageRate);
      const solar = usage.days.reduce(
        (sum, day) => sum.plus(dailySolarCredit(day.exportKwh, retailer)),
        new Decimal(0),
      );
      const membership = retailer.membershipFee;
      const bill = supply.plus(usageCost).minus(solar).plus(membership);
      return {
        retailer: retailer.name,
        supply,
        usage: usageCost,
        solar,
        membership,
        bill,
      };
    })
    .sort((a, b) => {
      const difference = a.bill.comparedTo(b.bill);
      if (difference !== 0) return difference;
      return a.retailer.localeCompare(b.retailer);
    });
}
