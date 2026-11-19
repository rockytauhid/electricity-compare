import { describe, expect, it } from "vitest";
import { compareBills, prepareUsage, type RetailerRates } from "./bill";
import { Decimal } from "./money";
import { PROJECTION_DAYS, projectBills } from "./projection";

function makeRetailer(overrides: Partial<RetailerRates> = {}): RetailerRates {
  return {
    name: "Test Retailer",
    membershipFee: new Decimal(0),
    supplyCharge: new Decimal("1.50"),
    usageRate: new Decimal("0.30"),
    feedInRate: new Decimal("0.10"),
    afterLimitFit: new Decimal("0.02"),
    feedInLimit: new Decimal("8"),
    ...overrides,
  };
}

describe("projectBills", () => {
  it("scales supply, usage, and solar by targetDays / supplyDays and excludes membership fees", () => {
    const usage = prepareUsage([
      { date: "2026-06-14", importKwh: new Decimal("10"), exportKwh: new Decimal("5") },
      { date: "2026-06-24", importKwh: new Decimal("10"), exportKwh: new Decimal("5") },
    ]);
    // supplyDays = 10; supply = 15, usage = 6, solar = 1, membership = 50 (excluded from projection)
    const exact = compareBills([makeRetailer({ membershipFee: new Decimal("50") })], usage);
    const annual = projectBills(exact, usage.supplyDays, PROJECTION_DAYS.year);

    expect(annual).not.toBeNull();
    expect(annual).toHaveLength(1);
    const row = annual![0];
    // scale = 365 / 10 = 36.5
    expect(row.supply.equals(new Decimal("547.5"))).toBe(true);
    expect(row.usage.equals(new Decimal("219"))).toBe(true);
    expect(row.solar.equals(new Decimal("36.5"))).toBe(true);
    expect(row.bill.equals(new Decimal("730"))).toBe(true);
    expect(row.sourceDays).toBe(10);
    expect(row.targetDays.equals(new Decimal(365))).toBe(true);
  });

  it("projects quarterly bills using 91.25 days", () => {
    const usage = prepareUsage([
      { date: "2026-06-14", importKwh: new Decimal("0"), exportKwh: new Decimal("0") },
      { date: "2026-06-18", importKwh: new Decimal("0"), exportKwh: new Decimal("0") },
    ]);
    // supplyDays = 4, supply = 4 * 2.00 = 8.00 => 2.00/day * 91.25 = 182.50
    const exact = compareBills([makeRetailer({ supplyCharge: new Decimal("2.00") })], usage);
    const quarter = projectBills(exact, usage.supplyDays, PROJECTION_DAYS.quarter);

    expect(quarter).not.toBeNull();
    expect(quarter![0].bill.equals(new Decimal("182.5"))).toBe(true);
  });

  it("returns null when supplyDays is 0 or negative", () => {
    const usage = prepareUsage([
      { date: "2026-06-14", importKwh: new Decimal("5"), exportKwh: new Decimal("2") },
    ]);
    const exact = compareBills([makeRetailer()], usage);
    expect(projectBills(exact, usage.supplyDays, PROJECTION_DAYS.year)).toBeNull();
    expect(projectBills(exact, 0, PROJECTION_DAYS.quarter)).toBeNull();
    expect(projectBills(exact, 10, new Decimal(0))).toBeNull();
  });

  it("sorts projected bills ascending and breaks ties by retailer name", () => {
    const usage = prepareUsage([
      { date: "2026-06-14", importKwh: new Decimal("10"), exportKwh: new Decimal("0") },
      { date: "2026-06-16", importKwh: new Decimal("0"), exportKwh: new Decimal("0") },
    ]);
    const retailers = [
      makeRetailer({ name: "Zeta", membershipFee: new Decimal("100") }),
      makeRetailer({ name: "Alpha", membershipFee: new Decimal("0") }),
    ];
    const exact = compareBills(retailers, usage);
    const projected = projectBills(exact, usage.supplyDays, PROJECTION_DAYS.year);
    expect(projected?.map((r) => r.retailer)).toEqual(["Alpha", "Zeta"]);
  });
});
