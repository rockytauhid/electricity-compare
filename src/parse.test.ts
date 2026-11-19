import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { Decimal } from "./money";
import {
  interpretGrids,
  loadPastedTable,
  loadSpreadsheetFile,
  parseDateCell,
  parseRetailerGrid,
  parseUsageGrid,
  sheetToGrid,
  splitTable,
} from "./parse";

describe("splitTable", () => {
  it("parses CSV with quoted fields, embedded commas, and escaped quotes", () => {
    const csv = [
      'Retailer,Membership Fee,Supply Charge,Usage Rate,Feed-in Rate,After Limit FiT,Feed-in Limit',
      '"Acme, ""Best"" Energy",0,1.25,0.28,0.05,0.01,8',
    ].join("\n");

    const grid = splitTable(csv);
    expect(grid).toHaveLength(2);
    expect(grid[1]?.[0]).toBe('Acme, "Best" Energy');
    expect(grid[1]?.[2]).toBe("1.25");
  });

  it("parses TSV and strips UTF-8 BOM and CRLF line endings", () => {
    const tsv = "\uFEFFDate\tImport kWh\tExport kWh\r\n2026-06-14\t1.5\t10.2\r\n2026-06-15\t2.0\t8.0\r\n";
    const grid = splitTable(tsv);
    expect(grid).toEqual([
      ["Date", "Import kWh", "Export kWh"],
      ["2026-06-14", "1.5", "10.2"],
      ["2026-06-15", "2.0", "8.0"],
    ]);
  });
});

describe("parseDateCell", () => {
  it("parses ISO, DD/MM/YYYY, and Excel serials", () => {
    expect(parseDateCell("2026-06-14")).toBe("2026-06-14");
    expect(parseDateCell("2026-06-14T08:30:00Z")).toBe("2026-06-14");
    expect(parseDateCell("14/06/2026")).toBe("2026-06-14");
    expect(parseDateCell("4/7/2026")).toBe("2026-07-04");
    expect(parseDateCell("14-06-2026")).toBe("2026-06-14");
    expect(parseDateCell("14.06.2026")).toBe("2026-06-14");
    expect(parseDateCell("46187")).toBe("2026-06-14");
    expect(parseDateCell("46187.5")).toBe("2026-06-14");
  });

  it("rejects invalid or out-of-range dates", () => {
    expect(parseDateCell("")).toBeNull();
    expect(parseDateCell("2026-02-30")).toBeNull();
    expect(parseDateCell("32/01/2026")).toBeNull();
    expect(parseDateCell("not-a-date")).toBeNull();
    expect(parseDateCell("100")).toBeNull();
  });
});

describe("blocked headers", () => {
  it("rejects time-of-use headers", () => {
    const grid = [
      ["Retailer", "Supply Charge", "Peak Rate", "Off Peak Rate"],
      ["Test", "1.20", "0.40", "0.20"],
    ];
    const result = parseRetailerGrid(grid, "Rates");
    expect(result.retailers).toEqual([]);
    expect(result.errors).toEqual([
      "Rates: This table has time-of-use rates. This page calculates single-rate plans only.",
    ]);
  });

  it("rejects controlled load headers", () => {
    const grid = [
      ["Retailer", "Supply Charge", "Usage Rate", "Controlled Load Rate"],
      ["Test", "1.20", "0.30", "0.22"],
    ];
    const result = parseRetailerGrid(grid, "Rates");
    expect(result.errors[0]).toContain("controlled load");
  });

  it("rejects EV headers", () => {
    const grid = [
      ["Retailer", "Supply Charge", "Usage Rate", "EV Rate"],
      ["Test", "1.20", "0.30", "0.08"],
    ];
    const result = parseRetailerGrid(grid, "Rates");
    expect(result.errors[0]).toContain("EV charging");
  });
});

describe("parseRetailerGrid", () => {
  it("finds headers beyond row 1 and defaults blank membershipFee to 0", () => {
    const grid = [
      ["Australian Retailer Rates", "", "", "", "", "", ""],
      ["", "", "", "", "", "", ""],
      ["Retailer", "Membership", "Daily Supply", "Flat Rate", "FiT", "Excess FiT", "Daily Cap"],
      ["Plan A", "", "$1.20", "$0.28", "$0.05", "$0.01", "8"],
      ["Plan B", "$12.50", "1.10", "0.30", "0.02", "0", "999"],
    ];

    const result = parseRetailerGrid(grid, "Sheet1");
    expect(result.errors).toEqual([]);
    expect(result.retailers).toHaveLength(2);
    expect(result.retailers[0]?.membershipFee.equals(new Decimal(0))).toBe(true);
    expect(result.retailers[1]?.membershipFee.equals(new Decimal("12.50"))).toBe(true);
  });

  it("reports missing columns when header is incomplete", () => {
    const grid = [
      ["Retailer", "Supply Charge", "Usage Rate"],
      ["Plan A", "1.20", "0.28"],
    ];
    const result = parseRetailerGrid(grid, "Rates");
    expect(result.retailers).toEqual([]);
    expect(result.errors).toEqual(["Rates: no single-rate retailer header row was found."]);
  });

  it("reports accurate 1-based row numbers for bad retailer rows", () => {
    const grid = [
      ["Notes row", "", "", "", "", "", ""],
      ["Retailer", "Membership", "Supply", "Usage Rate", "FiT", "After Limit FiT", "FiT Limit"],
      ["Good Plan", "0", "1.20", "0.28", "0.05", "0.01", "8"],
      ["", "0", "1.20", "0.28", "0.05", "0.01", "8"],
      ["Bad Rate Plan", "0", "abc", "0.28", "0.05", "0.01", "8"],
    ];
    const result = parseRetailerGrid(grid, "Rates");
    expect(result.retailers).toEqual([]);
    expect(result.errors).toEqual([
      "Rates row 4: missing retailer name.",
      "Rates row 5: a rate cell is blank or not a number.",
    ]);
  });
});

describe("parseUsageGrid", () => {
  it("parses usage rows with header beyond row 1 and DD/MM/YYYY dates", () => {
    const grid = [
      ["Smart meter export", "", ""],
      ["Date", "Consumption kWh", "Sold to Grid kWh"],
      ["14/06/2026", "1.25", "10.5"],
      ["15/06/2026", "2.00", "8.25"],
    ];
    const result = parseUsageGrid(grid, "Meter");
    expect(result.errors).toEqual([]);
    expect(result.usage?.supplyDays).toBe(1);
    expect(result.usage?.totalImport.equals(new Decimal("3.25"))).toBe(true);
    expect(result.usage?.totalExport.equals(new Decimal("18.75"))).toBe(true);
  });

  it("rejects negative import/export and bad dates with accurate row numbers", () => {
    const grid = [
      ["Date", "Import kWh", "Export kWh"],
      ["2026-06-14", "-1.0", "5.0"],
      ["bad-date", "1.0", "5.0"],
      ["2026-06-16", "1.0", "xyz"],
    ];
    const result = parseUsageGrid(grid, "Usage");
    expect(result.usage).toBeNull();
    expect(result.errors).toEqual([
      "Usage row 2: import and export must be zero or positive.",
      'Usage row 3: "bad-date" is not a date. Use YYYY-MM-DD or DD/MM/YYYY.',
      "Usage row 4: import or export is blank or not a number.",
    ]);
  });
});

describe("XLSX workbook loading and interpretGrids", () => {
  it("reads an in-memory XLSX with date-formatted cells and both sheets", async () => {
    const wb = XLSX.utils.book_new();

    const usageSheet = XLSX.utils.aoa_to_sheet([
      ["Date", "Import kWh", "Export kWh"],
      [46187, 1.5, 10.25],
      [46188, 2.25, 8.75],
    ]);
    usageSheet["A2"] = { t: "n", v: 46187, z: "dd/mm/yyyy" };
    usageSheet["A3"] = { t: "n", v: 46188, z: "yyyy-mm-dd" };
    XLSX.utils.book_append_sheet(wb, usageSheet, "Usage");

    const retailerSheet = XLSX.utils.aoa_to_sheet([
      ["Retailer", "Membership Fee", "Supply Charge", "Usage Rate", "Feed-in Rate", "After Limit FiT", "Feed-in Limit"],
      ["Demo Plan", 0, 1.5, 0.3, 0.08, 0.02, 8],
    ]);
    XLSX.utils.book_append_sheet(wb, retailerSheet, "Rates");

    const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const file = new File([bytes], "compare.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    const loaded = await loadSpreadsheetFile(file);
    expect(loaded.errors).toEqual([]);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.usage?.firstDate).toBe("2026-06-14");
    expect(loaded.usage?.lastDate).toBe("2026-06-15");
    expect(loaded.usage?.supplyDays).toBe(1);
    expect(loaded.retailers).toHaveLength(1);
    expect(loaded.retailers?.[0]?.name).toBe("Demo Plan");
  });

  it("extracts date-formatted cells via sheetToGrid", () => {
    const sheet: XLSX.WorkSheet = {
      "!ref": "A1:C2",
      A1: { t: "s", v: "Date" },
      B1: { t: "s", v: "Import" },
      C1: { t: "s", v: "Export" },
      A2: { t: "n", v: 46187, z: "dd/mm/yyyy" },
      B2: { t: "n", v: 1.25 },
      C2: { t: "n", v: 4.5 },
    };
    expect(sheetToGrid(sheet)).toEqual([
      ["Date", "Import", "Export"],
      ["2026-06-14", "1.25", "4.5"],
    ]);
  });

  it("errors when no known table is found in pasted text or grids", () => {
    const pasted = loadPastedTable("Foo,Bar\n1,2");
    expect(pasted.retailers).toBeNull();
    expect(pasted.usage).toBeNull();
    expect(pasted.errors).toEqual([
      "No single-rate retailer table or daily usage table was found.",
    ]);

    const empty = interpretGrids([{ label: "Empty", grid: [] }]);
    expect(empty.errors).toHaveLength(1);
  });
});

describe("Phase 3 parser hardening", () => {
  it("allows omitting optional membershipFee, afterLimitFit, and feedInLimit columns", () => {
    const grid = [
      ["Retailer", "Supply Charge", "Usage Rate", "Feed-in Rate"],
      ["Minimal Plan", "1.25", "0.28", "0.05"],
    ];
    const result = parseRetailerGrid(grid, "Rates");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.retailers).toHaveLength(1);
    expect(result.retailers[0]?.membershipFee.equals(new Decimal(0))).toBe(true);
    expect(result.retailers[0]?.afterLimitFit.equals(new Decimal(0))).toBe(true);
    expect(result.retailers[0]?.feedInLimit.equals(new Decimal(999))).toBe(true);
  });

  it("defaults blank feedInLimit to 999 and blank afterLimitFit to 0", () => {
    const grid = [
      ["Retailer", "Membership", "Supply", "Usage Rate", "FiT", "After Limit FiT", "FiT Limit"],
      ["Uncapped Plan", "", "1.20", "0.28", "0.05", "", ""],
    ];
    const result = parseRetailerGrid(grid, "Rates");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.retailers[0]?.afterLimitFit.equals(new Decimal(0))).toBe(true);
    expect(result.retailers[0]?.feedInLimit.equals(new Decimal(999))).toBe(true);
  });

  it("emits a plausibility warning when rates look like cents without auto-converting", () => {
    const grid = [
      ["Retailer", "Supply Charge", "Usage Rate", "Feed-in Rate"],
      ["Cents Plan", "188.1", "27.39", "5"],
      ["Dollar Plan", "1.881", "0.2739", "0.05"],
    ];
    const result = parseRetailerGrid(grid, "Rates");
    expect(result.errors).toEqual([]);
    expect(result.retailers).toHaveLength(2);
    // Values are kept as entered (not silently divided by 100)
    expect(result.retailers[0]?.usageRate.equals(new Decimal("27.39"))).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Rates row 2 (Cents Plan)");
    expect(result.warnings[0]).toContain("dollars, not cents");
  });

  it("warns when multiple retailer sheets or multiple usage sheets are present", () => {
    const retailerGrid1 = [
      ["Retailer", "Supply Charge", "Usage Rate", "Feed-in Rate"],
      ["Old Plan", "1.20", "0.30", "0.05"],
    ];
    const retailerGrid2 = [
      ["Retailer", "Supply Charge", "Usage Rate", "Feed-in Rate"],
      ["New Plan", "1.10", "0.28", "0.05"],
    ];
    const usageGrid1 = [
      ["Date", "Import kWh", "Export kWh"],
      ["2026-06-14", "1.0", "5.0"],
      ["2026-06-15", "1.0", "5.0"],
    ];
    const usageGrid2 = [
      ["Date", "Import kWh", "Export kWh"],
      ["2026-06-14", "2.0", "6.0"],
      ["2026-06-15", "2.0", "6.0"],
    ];

    const loaded = interpretGrids([
      { label: "Rates Old", grid: retailerGrid1 },
      { label: "Rates New", grid: retailerGrid2 },
      { label: "Usage A", grid: usageGrid1 },
      { label: "Usage B", grid: usageGrid2 },
    ]);

    expect(loaded.errors).toEqual([]);
    expect(loaded.retailers?.[0]?.name).toBe("New Plan");
    expect(loaded.usage?.totalImport.equals(new Decimal("4"))).toBe(true);
    expect(loaded.warnings).toEqual([
      'Multiple retailer rate sheets found ("Rates Old" and "Rates New"). Using "Rates New".',
      'Multiple daily usage sheets found ("Usage A" and "Usage B"). Using "Usage B".',
    ]);
  });

  it("prefers cell.w over float-noisy cell.v for non-date numbers and handles UTC Date cells", () => {
    const sheet: XLSX.WorkSheet = {
      "!ref": "A1:D2",
      A1: { t: "s", v: "Date" },
      B1: { t: "s", v: "Import" },
      C1: { t: "s", v: "Export" },
      D1: { t: "s", v: "AccountingZero" },
      A2: { t: "d", v: new Date(Date.UTC(2026, 5, 14, 23, 30, 0)) },
      B2: { t: "n", v: 0.27390000000000003, w: "0.2739" },
      C2: { t: "n", v: 12.5, w: "$12.50" },
      D2: { t: "n", v: 0, w: "$ -" },
    };

    expect(sheetToGrid(sheet)).toEqual([
      ["Date", "Import", "Export", "AccountingZero"],
      ["2026-06-14", "0.2739", "$12.50", "0"],
    ]);
  });
});
