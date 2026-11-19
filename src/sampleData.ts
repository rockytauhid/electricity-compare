import { prepareUsage, type PreparedUsage, type RetailerRates } from "./bill";
import { Decimal } from "./money";
import retailersRaw from "./sample/retailers.json";
import usageRaw from "./sample/usage.json";

export function loadSampleData(): {
  usage: PreparedUsage;
  retailers: RetailerRates[];
} {
  const usage = prepareUsage(
    usageRaw.map((row) => ({
      date: row.date,
      importKwh: new Decimal(row.importKwh),
      exportKwh: new Decimal(row.exportKwh),
    })),
  );

  const retailers: RetailerRates[] = retailersRaw.map((row) => ({
    name: row.name,
    membershipFee: new Decimal(row.membershipFee),
    supplyCharge: new Decimal(row.supplyCharge),
    usageRate: new Decimal(row.usageRate),
    feedInRate: new Decimal(row.feedInRate),
    afterLimitFit: new Decimal(row.afterLimitFit),
    feedInLimit: new Decimal(row.feedInLimit),
  }));

  return { usage, retailers };
}
