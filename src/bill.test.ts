import { describe, expect, it } from "vitest";
import {
  compareBills,
  dailySolarCredit,
  prepareUsage,
  type RetailerRates,
  type UsageDay,
} from "./bill";
import { Decimal, formatMoney, roundCents } from "./money";
import expectedRaw from "./sample/expected.json";
import retailersRaw from "./sample/retailers.json";
import usageRaw from "./sample/usage.json";

type ExpectedRow = {
  supply: string;
  usage: string;
  solar: string;
  bill: string;
  billCents: string;
};

const expected = expectedRaw as Record<string, ExpectedRow>;

function loadSampleRetailers(): RetailerRates[] {
  return retailersRaw.map((row) => ({
    name: row.name,
    membershipFee: new Decimal(row.membershipFee),
    supplyCharge: new Decimal(row.supplyCharge),
    usageRate: new Decimal(row.usageRate),
    feedInRate: new Decimal(row.feedInRate),
    afterLimitFit: new Decimal(row.afterLimitFit),
    feedInLimit: new Decimal(row.feedInLimit),
  }));
}

function loadSampleUsage(): UsageDay[] {
  return usageRaw.map((row) => ({
    date: row.date,
    importKwh: new Decimal(row.importKwh),
    exportKwh: new Decimal(row.exportKwh),
  }));
}

function makeRetailer(overrides: Partial<RetailerRates> = {}): RetailerRates {
  return {
    name: "Test Retailer",
    membershipFee: new Decimal(0),
    supplyCharge: new Decimal("1.00"),
    usageRate: new Decimal("0.30"),
    feedInRate: new Decimal("0.10"),
    afterLimitFit: new Decimal("0.02"),
    feedInLimit: new Decimal("8"),
    ...overrides,
  };
}

describe("sample golden regression", () => {
  const usage = prepareUsage(loadSampleUsage());
  const retailers = loadSampleRetailers();
  const results = compareBills(retailers, usage);

  it("prepares the 21-day sample with 20 supply days and no warnings", () => {
    expect(usage.days).toHaveLength(21);
    expect(usage.firstDate).toBe("2026-06-14");
    expect(usage.lastDate).toBe("2026-07-04");
    expect(usage.supplyDays).toBe(20);
    expect(usage.warnings).toEqual([]);
  });

  it("matches expected.json for every retailer using Decimal.equals and billCents", () => {
    expect(results).toHaveLength(Object.keys(expected).length);

    for (const result of results) {
      const target = expected[result.retailer];
      expect(target, `missing golden entry for ${result.retailer}`).toBeDefined();
      expect(result.supply.equals(new Decimal(target.supply)), `${result.retailer} supply`).toBe(true);
      expect(result.usage.equals(new Decimal(target.usage)), `${result.retailer} usage`).toBe(true);
      expect(result.solar.equals(new Decimal(target.solar)), `${result.retailer} solar`).toBe(true);
      expect(result.bill.equals(new Decimal(target.bill)), `${result.retailer} bill`).toBe(true);
      expect(roundCents(result.bill).toFixed(2), `${result.retailer} roundCents`).toBe(target.billCents);
      expect(formatMoney(result.bill), `${result.retailer} formatMoney`).toBe(`$${target.billCents}`);
    }
  });

  it("sorts results ascending by exact bill, then retailer name", () => {
    for (let i = 1; i < results.length; i += 1) {
      const prev = results[i - 1];
      const curr = results[i];
      const cmp = prev.bill.comparedTo(curr.bill);
      expect(cmp).toBeLessThanOrEqual(0);
      if (cmp === 0) {
        expect(prev.retailer.localeCompare(curr.retailer)).toBeLessThanOrEqual(0);
      }
    }
    expect(results[0]?.retailer).toBe("Sumo - Local Single Rate");
    expect(results[results.length - 1]?.retailer).toBe("1st Energy - Quartz Single");
  });
});

describe("prepareUsage edge cases", () => {
  it("sums duplicate dates before the daily feed-in cap and warns", () => {
    const usage = prepareUsage([
      { date: "2026-06-14", importKwh: new Decimal("2.5"), exportKwh: new Decimal("5") },
      { date: "2026-06-14", importKwh: new Decimal("1.5"), exportKwh: new Decimal("5") },
      { date: "2026-06-15", importKwh: new Decimal("1"), exportKwh: new Decimal("0") },
    ]);

    expect(usage.days).toHaveLength(2);
    expect(usage.days[0]?.importKwh.equals(new Decimal("4"))).toBe(true);
    expect(usage.days[0]?.exportKwh.equals(new Decimal("10"))).toBe(true);
    expect(usage.supplyDays).toBe(1);
    expect(usage.warnings).toHaveLength(1);
    expect(usage.warnings[0]).toContain("2026-06-14");

    // Combined 10 kWh export on 2026-06-14 should hit the 8 kWh daily cap: 8*0.10 + 2*0.02 = 0.84
    const [result] = compareBills([makeRetailer()], usage);
    expect(result.solar.equals(new Decimal("0.84"))).toBe(true);
  });

  it("charges supply across missing dates and warns", () => {
    const usage = prepareUsage([
      { date: "2026-06-14", importKwh: new Decimal("2"), exportKwh: new Decimal("0") },
      { date: "2026-06-18", importKwh: new Decimal("3"), exportKwh: new Decimal("0") },
    ]);

    expect(usage.supplyDays).toBe(4);
    expect(usage.totalImport.equals(new Decimal("5"))).toBe(true);
    expect(usage.warnings).toHaveLength(1);
    expect(usage.warnings[0]).toContain("Missing dates between 2026-06-14 and 2026-06-18");

    const [result] = compareBills([makeRetailer({ supplyCharge: new Decimal("1.50") })], usage);
    expect(result.supply.equals(new Decimal("6.00"))).toBe(true);
  });

  it("handles a single day with 0 supply days and warns", () => {
    const usage = prepareUsage([
      { date: "2026-06-14", importKwh: new Decimal("4"), exportKwh: new Decimal("2") },
    ]);

    expect(usage.supplyDays).toBe(0);
    expect(usage.warnings).toHaveLength(1);
    expect(usage.warnings[0]).toContain("0 days");

    const [result] = compareBills([makeRetailer()], usage);
    expect(result.supply.equals(new Decimal(0))).toBe(true);
    expect(result.usage.equals(new Decimal("1.20"))).toBe(true);
    expect(result.solar.equals(new Decimal("0.20"))).toBe(true);
    expect(result.bill.equals(new Decimal("1.00"))).toBe(true);
  });

  it("handles an empty usage list cleanly", () => {
    const usage = prepareUsage([]);
    expect(usage.days).toEqual([]);
    expect(usage.firstDate).toBe("");
    expect(usage.lastDate).toBe("");
    expect(usage.supplyDays).toBe(0);
    expect(usage.totalImport.equals(new Decimal(0))).toBe(true);
    expect(usage.totalExport.equals(new Decimal(0))).toBe(true);
    expect(usage.warnings).toEqual([]);

    const [result] = compareBills([makeRetailer({ membershipFee: new Decimal("15") })], usage);
    expect(result.bill.equals(new Decimal("15"))).toBe(true);
  });

  it("sorts unsorted input dates before computing span", () => {
    const usage = prepareUsage([
      { date: "2026-06-16", importKwh: new Decimal("1"), exportKwh: new Decimal("0") },
      { date: "2026-06-14", importKwh: new Decimal("1"), exportKwh: new Decimal("0") },
      { date: "2026-06-15", importKwh: new Decimal("1"), exportKwh: new Decimal("0") },
    ]);

    expect(usage.firstDate).toBe("2026-06-14");
    expect(usage.lastDate).toBe("2026-06-16");
    expect(usage.supplyDays).toBe(2);
    expect(usage.warnings).toEqual([]);
  });
});

describe("dailySolarCredit and compareBills edge cases", () => {
  it("handles export exactly at the daily limit", () => {
    const retailer = makeRetailer({
      feedInRate: new Decimal("0.08"),
      afterLimitFit: new Decimal("0.02"),
      feedInLimit: new Decimal("8"),
    });
    expect(dailySolarCredit(new Decimal("8"), retailer).equals(new Decimal("0.64"))).toBe(true);
    expect(dailySolarCredit(new Decimal("8.5"), retailer).equals(new Decimal("0.65"))).toBe(true);
  });

  it("treats limit 999 as effectively uncapped for household exports", () => {
    const retailer = makeRetailer({
      feedInRate: new Decimal("0.05"),
      afterLimitFit: new Decimal("0"),
      feedInLimit: new Decimal("999"),
    });
    expect(dailySolarCredit(new Decimal("50"), retailer).equals(new Decimal("2.5"))).toBe(true);
  });

  it("returns zero credit for zero FiT or negative export", () => {
    const zeroFit = makeRetailer({
      feedInRate: new Decimal("0"),
      afterLimitFit: new Decimal("0"),
      feedInLimit: new Decimal("999"),
    });
    expect(dailySolarCredit(new Decimal("20"), zeroFit).equals(new Decimal(0))).toBe(true);
    expect(dailySolarCredit(new Decimal("-5"), makeRetailer()).equals(new Decimal(0))).toBe(true);
  });

  it("adds membership fee and breaks ties alphabetically by retailer name", () => {
    const usage = prepareUsage([
      { date: "2026-06-14", importKwh: new Decimal("10"), exportKwh: new Decimal("0") },
      { date: "2026-06-15", importKwh: new Decimal("0"), exportKwh: new Decimal("0") },
    ]);
    const retailers = [
      makeRetailer({ name: "Zeta Energy", membershipFee: new Decimal("5") }),
      makeRetailer({ name: "Alpha Energy", membershipFee: new Decimal("5") }),
    ];
    const results = compareBills(retailers, usage);
    expect(results.map((r) => r.retailer)).toEqual(["Alpha Energy", "Zeta Energy"]);
    // supply 1*1 + usage 10*0.30 - solar 0 + membership 5 = 9.00
    expect(results[0]?.bill.equals(new Decimal("9"))).toBe(true);
  });

  it("returns an empty array when given no retailers", () => {
    const usage = prepareUsage([
      { date: "2026-06-14", importKwh: new Decimal("1"), exportKwh: new Decimal("0") },
    ]);
    expect(compareBills([], usage)).toEqual([]);
  });
});
