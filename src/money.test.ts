import { describe, expect, it } from "vitest";
import {
  calendarDaysBetween,
  Decimal,
  excelSerialToIso,
  formatKwh,
  formatMoney,
  formatRate,
  parseDecimal,
  roundCents,
  roundKwh,
} from "./money";

describe("parseDecimal", () => {
  it("parses currency, commas, whitespace, and decimals", () => {
    expect(parseDecimal("$1,234.50").equals(new Decimal("1234.5"))).toBe(true);
    expect(parseDecimal("  $ 0.2739 ").equals(new Decimal("0.2739"))).toBe(true);
    expect(parseDecimal("-12.34").equals(new Decimal("-12.34"))).toBe(true);
    expect(parseDecimal("0").equals(new Decimal(0))).toBe(true);
  });

  it("rejects blank, sign-only, non-finite, and non-numeric strings", () => {
    for (const bad of ["", "   ", "$", "-", "+", "NaN", "Infinity", "-Infinity", "abc", "12.3.4"]) {
      expect(() => parseDecimal(bad), `expected "${bad}" to throw`).toThrow();
    }
  });
});

describe("rounding and formatting", () => {
  it("rounds half-up to cents", () => {
    expect(roundCents(new Decimal("1.005")).equals(new Decimal("1.01"))).toBe(true);
    expect(roundCents(new Decimal("1.004999")).equals(new Decimal("1.00"))).toBe(true);
    expect(roundCents(new Decimal("37.4973088")).equals(new Decimal("37.50"))).toBe(true);
    expect(formatMoney(new Decimal("1.005"))).toBe("$1.01");
    expect(formatMoney(new Decimal("0"))).toBe("$0.00");
  });

  it("rounds half-up to 6 decimal places for kWh", () => {
    expect(roundKwh(new Decimal("1.1234565")).equals(new Decimal("1.123457"))).toBe(true);
    expect(roundKwh(new Decimal("1.1234564")).equals(new Decimal("1.123456"))).toBe(true);
  });

  it("formats kWh to 3 decimal places half-up", () => {
    expect(formatKwh(new Decimal("12.3455"))).toBe("12.346");
    expect(formatKwh(new Decimal("5"))).toBe("5.000");
  });

  it("formats rates with between 2 and 6 decimal places", () => {
    expect(formatRate(new Decimal("0"))).toBe("$0.00");
    expect(formatRate(new Decimal("0.1"))).toBe("$0.10");
    expect(formatRate(new Decimal("0.055"))).toBe("$0.055");
    expect(formatRate(new Decimal("0.2739"))).toBe("$0.2739");
    expect(formatRate(new Decimal("0.123456"))).toBe("$0.123456");
    expect(formatRate(new Decimal("0.1234567"))).toBe("$0.123457");
  });
});

describe("excelSerialToIso", () => {
  it("converts known Excel 1900 serial numbers to ISO dates", () => {
    // 2026-06-14 is 46187 days after 1899-12-30
    expect(excelSerialToIso(46187)).toBe("2026-06-14");
    expect(excelSerialToIso(46207)).toBe("2026-07-04");
    // Fractional time portion is ignored
    expect(excelSerialToIso(46187.75)).toBe("2026-06-14");
    // Leap day
    expect(excelSerialToIso(45351)).toBe("2024-02-29");
  });
});

describe("calendarDaysBetween", () => {
  it("computes calendar difference across month, year, and leap-year boundaries", () => {
    expect(calendarDaysBetween("2026-06-14", "2026-07-04")).toBe(20);
    expect(calendarDaysBetween("2026-06-14", "2026-06-14")).toBe(0);
    expect(calendarDaysBetween("2025-12-31", "2026-01-01")).toBe(1);
    expect(calendarDaysBetween("2024-02-28", "2024-03-01")).toBe(2);
    expect(calendarDaysBetween("2025-02-28", "2025-03-01")).toBe(1);
    expect(calendarDaysBetween("2024-01-01", "2025-01-01")).toBe(366);
    expect(calendarDaysBetween("2025-01-01", "2026-01-01")).toBe(365);
  });
});
