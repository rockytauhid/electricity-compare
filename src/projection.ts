import type { BillBreakdown } from "./bill";
import { Decimal } from "./money";

export type ProjectionHorizon = "exact" | "quarter" | "year";

export const PROJECTION_DAYS: Record<Exclude<ProjectionHorizon, "exact">, Decimal> = {
  quarter: new Decimal("91.25"),
  year: new Decimal(365),
};

export type ProjectedBill = {
  retailer: string;
  supply: Decimal;
  usage: Decimal;
  solar: Decimal;
  bill: Decimal;
  targetDays: Decimal;
  sourceDays: number;
};

/**
 * Simple per-day average projection scaled to `targetDays`.
 *
 * Known limitations (documented for future improvement):
 * - Assumes uniform daily usage and solar export; does not adjust for seasonality
 *   (winter heating / summer cooling / solar yield) or climate location (north vs. south).
 * - Excludes membership fees because retailers apply differing one-time or recurring rules.
 */
export function projectBills(
  breakdowns: BillBreakdown[],
  supplyDays: number,
  targetDays: Decimal,
): ProjectedBill[] | null {
  if (supplyDays <= 0 || targetDays.lessThanOrEqualTo(0)) {
    return null;
  }

  const scale = targetDays.div(supplyDays);

  return breakdowns
    .map((row) => {
      const supply = row.supply.times(scale);
      const usage = row.usage.times(scale);
      const solar = row.solar.times(scale);
      const bill = supply.plus(usage).minus(solar);
      return {
        retailer: row.retailer,
        supply,
        usage,
        solar,
        bill,
        targetDays,
        sourceDays: supplyDays,
      };
    })
    .sort((a, b) => {
      const difference = a.bill.comparedTo(b.bill);
      if (difference !== 0) return difference;
      return a.retailer.localeCompare(b.retailer);
    });
}
