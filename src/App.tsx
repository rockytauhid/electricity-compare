import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { compareBills, type PreparedUsage, type RetailerRates } from "./bill";
import { Decimal, formatKwh, formatMoney, formatRate } from "./money";
import { loadPastedTable, loadSpreadsheetFile, type LoadedTables } from "./parse";
import { PROJECTION_DAYS, projectBills, type ProjectionHorizon } from "./projection";
import { loadSampleData } from "./sampleData";

const UNCAPPED_LIMIT = new Decimal(999);

function formatPlanRates(plan: RetailerRates): string {
  const parts = [
    `Supply ${formatRate(plan.supplyCharge)}/day`,
    `Usage ${formatRate(plan.usageRate)}/kWh`,
  ];

  if (plan.feedInLimit.greaterThanOrEqualTo(UNCAPPED_LIMIT)) {
    parts.push(`FiT ${formatRate(plan.feedInRate)}/kWh`);
  } else {
    parts.push(
      `FiT ${formatRate(plan.feedInRate)}/kWh (first ${formatKwh(plan.feedInLimit)} kWh/day, then ${formatRate(plan.afterLimitFit)})`,
    );
  }

  return parts.join(" · ");
}

export function App() {
  const [usage, setUsage] = useState<PreparedUsage | null>(null);
  const [retailers, setRetailers] = useState<RetailerRates[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [pasteText, setPasteText] = useState("");
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [horizon, setHorizon] = useState<ProjectionHorizon>("exact");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function applyLoaded(loaded: LoadedTables, label: string) {
    if (loaded.errors.length > 0) {
      setErrors(loaded.errors);
      setWarnings(loaded.warnings);
      return;
    }

    setErrors([]);
    setWarnings(loaded.warnings);
    if (loaded.usage) setUsage(loaded.usage);
    if (loaded.retailers) setRetailers(loaded.retailers);
    setSourceLabel(label);
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const collectedErrors: string[] = [];
    const collectedWarnings: string[] = [];
    let nextUsage = usage;
    let nextRetailers = retailers;
    const names: string[] = [];

    for (const file of Array.from(files)) {
      names.push(file.name);
      try {
        const loaded = await loadSpreadsheetFile(file);
        collectedErrors.push(...loaded.errors);
        collectedWarnings.push(...loaded.warnings);
        if (loaded.errors.length === 0) {
          if (loaded.usage) nextUsage = loaded.usage;
          if (loaded.retailers) nextRetailers = loaded.retailers;
        }
      } catch {
        collectedErrors.push(`${file.name}: could not be read as a spreadsheet or text table.`);
      }
    }

    setErrors(collectedErrors);
    setWarnings(collectedWarnings);
    if (collectedErrors.length === 0) {
      setUsage(nextUsage);
      setRetailers(nextRetailers);
      setSourceLabel(names.join(", "));
    }
  }

  function handleLoadPasted() {
    if (pasteText.trim() === "") return;
    const loaded = loadPastedTable(pasteText);
    applyLoaded(loaded, "Pasted table");
  }

  function handleLoadSample() {
    const sample = loadSampleData();
    setUsage(sample.usage);
    setRetailers(sample.retailers);
    setErrors([]);
    setWarnings(sample.usage.warnings);
    setSourceLabel("Sample dataset (21 days, 24 plans)");
  }

  function handleClear() {
    setUsage(null);
    setRetailers(null);
    setErrors([]);
    setWarnings([]);
    setPasteText("");
    setSourceLabel(null);
    setHorizon("exact");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const exactResults = useMemo(() => {
    if (!usage || !retailers || retailers.length === 0) return [];
    return compareBills(retailers, usage);
  }, [retailers, usage]);

  const canProject = Boolean(usage && usage.supplyDays > 0);
  const activeHorizon: ProjectionHorizon = canProject ? horizon : "exact";

  const displayedRows = useMemo(() => {
    if (activeHorizon === "exact") {
      return exactResults.map((row) => ({
        retailer: row.retailer,
        supply: row.supply,
        usage: row.usage,
        solar: row.solar,
        membership: row.membership as Decimal | null,
        bill: row.bill,
      }));
    }
    if (!usage) return [];
    const projected = projectBills(exactResults, usage.supplyDays, PROJECTION_DAYS[activeHorizon]);
    if (!projected) return [];
    return projected.map((row) => ({
      retailer: row.retailer,
      supply: row.supply,
      usage: row.usage,
      solar: row.solar,
      membership: null as Decimal | null,
      bill: row.bill,
    }));
  }, [activeHorizon, exactResults, usage]);

  const planByName = useMemo(() => {
    const map = new Map<string, RetailerRates>();
    if (retailers) {
      for (const plan of retailers) map.set(plan.name, plan);
    }
    return map;
  }, [retailers]);

  const cheapestBill = displayedRows[0]?.bill ?? null;

  return (
    <main className="page">
      <header className="header">
        <h1>Single-rate electricity comparison</h1>
        <p className="subtitle">
          Compare Australian single-rate electricity plans against your daily import and solar export data,
          ranked cheapest first.
        </p>
        <div className="meta-notes">
          <span>Runs 100% locally in your browser — your data never leaves this device.</span>
          <span>Rates and totals assume GST-inclusive dollar amounts (as on Energy Made Easy).</span>
        </div>
      </header>

      <section className="card" aria-labelledby="inputs-heading">
        <h2 id="inputs-heading">1. Load usage and retailer rates</h2>
        <div className="input-grid">
          <div className="field">
            <label htmlFor="file-upload">Upload spreadsheet or CSV (.xlsx, .csv, .txt)</label>
            <input
              ref={fileInputRef}
              id="file-upload"
              type="file"
              accept=".xlsx,.xls,.csv,.txt"
              multiple
              onChange={handleFileChange}
            />
            <p className="hint">
              Upload one workbook containing both sheets, or upload usage and retailer files separately.
            </p>
          </div>

          <div className="field">
            <label htmlFor="paste-table">Or paste a CSV / TSV table</label>
            <textarea
              id="paste-table"
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
              placeholder="Paste daily usage or retailer rates (copied from Excel, Sheets, or CSV)..."
            />
            <p className="hint">
              Rates must be in dollars (e.g. 0.2739 $/kWh, 1.881 $/day). Single-rate plans only.
            </p>
          </div>
        </div>

        <div className="actions">
          <button
            type="button"
            className="primary"
            onClick={handleLoadPasted}
            disabled={pasteText.trim() === ""}
          >
            Load pasted table
          </button>
          <button type="button" onClick={handleLoadSample}>
            Load sample data
          </button>
          <button
            type="button"
            onClick={handleClear}
            disabled={!usage && !retailers && errors.length === 0 && warnings.length === 0 && pasteText === ""}
          >
            Clear
          </button>
        </div>
      </section>

      {errors.length > 0 && (
        <section className="banner error" role="alert" aria-labelledby="errors-heading">
          <h2 id="errors-heading">Could not load table</h2>
          <ul>
            {errors.map((message, index) => (
              <li key={`${index}-${message}`}>{message}</li>
            ))}
          </ul>
        </section>
      )}

      {warnings.length > 0 && (
        <section className="banner warning" role="status" aria-labelledby="warnings-heading">
          <h2 id="warnings-heading">Warnings</h2>
          <ul>
            {warnings.map((message, index) => (
              <li key={`${index}-${message}`}>{message}</li>
            ))}
          </ul>
        </section>
      )}

      {(usage || retailers) && (
        <section className="card" aria-labelledby="summary-heading">
          <h2 id="summary-heading">
            Period summary{sourceLabel ? ` — ${sourceLabel}` : ""}
          </h2>
          <div className="summary-grid">
            <div className="stat">
              <div className="stat-label">Period</div>
              <div className="stat-value">
                {usage ? `${usage.firstDate} to ${usage.lastDate}` : "Not loaded"}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Supply days</div>
              <div className="stat-value">{usage ? String(usage.supplyDays) : "—"}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Total import</div>
              <div className="stat-value">{usage ? `${formatKwh(usage.totalImport)} kWh` : "—"}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Total solar export</div>
              <div className="stat-value">{usage ? `${formatKwh(usage.totalExport)} kWh` : "—"}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Plans loaded</div>
              <div className="stat-value">{retailers ? String(retailers.length) : "0"}</div>
            </div>
          </div>
        </section>
      )}

      <section className="card" aria-labelledby="results-heading">
        <div className="results-header">
          <h2 id="results-heading">
            2. Ranked comparison (GST-inclusive)
            {activeHorizon === "quarter" && " — Quarterly estimate (91.25 days)"}
            {activeHorizon === "year" && " — Annual estimate (365 days)"}
          </h2>

          {exactResults.length > 0 && (
            <div className="horizon-toggle" role="group" aria-label="Billing period view">
              <button
                type="button"
                className={activeHorizon === "exact" ? "primary" : undefined}
                aria-pressed={activeHorizon === "exact"}
                onClick={() => setHorizon("exact")}
              >
                Exact period ({usage?.supplyDays ?? 0}d)
              </button>
              <button
                type="button"
                className={activeHorizon === "quarter" ? "primary" : undefined}
                aria-pressed={activeHorizon === "quarter"}
                disabled={!canProject}
                onClick={() => setHorizon("quarter")}
              >
                Quarterly est. (91.25d)
              </button>
              <button
                type="button"
                className={activeHorizon === "year" ? "primary" : undefined}
                aria-pressed={activeHorizon === "year"}
                disabled={!canProject}
                onClick={() => setHorizon("year")}
              >
                Annual est. (365d)
              </button>
            </div>
          )}
        </div>

        {activeHorizon !== "exact" && (
          <div className="banner info" role="note">
            <p>
              <strong>Estimate only (simple per-day average):</strong> scaled linearly from your{" "}
              {usage?.supplyDays}-day period. Actual bills vary by <strong>season</strong> (more heating in
              winter, more cooling and solar export in summer) and <strong>location</strong> (northern vs.
              southern climates) — seasonal/location-aware projection is planned as a future improvement.{" "}
              <strong>Membership fees are excluded</strong> from projections because retailers apply different
              one-time or recurring rules.
            </p>
          </div>
        )}

        {displayedRows.length === 0 ? (
          <p className="empty-state">
            {usage && !retailers
              ? "Usage data is loaded. Upload or paste a single-rate retailer table to compare plans."
              : !usage && retailers
                ? "Retailer rates are loaded. Upload or paste daily usage data to calculate bills."
                : 'Load your daily usage and retailer rates above, or click "Load sample data" to see an example.'}
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col" className="num">Rank</th>
                  <th scope="col">Retailer / Plan</th>
                  <th scope="col" className="num">Supply</th>
                  <th scope="col" className="num">Usage</th>
                  <th scope="col" className="num">Solar credit</th>
                  <th scope="col" className="num">Membership</th>
                  <th scope="col" className="num">
                    {activeHorizon === "exact" ? "Total" : "Est. Total"}
                  </th>
                  <th scope="col" className="num">vs. Cheapest</th>
                </tr>
              </thead>
              <tbody>
                {displayedRows.map((row, index) => {
                  const isCheapest = index === 0;
                  const diff = cheapestBill ? row.bill.minus(cheapestBill) : new Decimal(0);
                  const plan = planByName.get(row.retailer);
                  return (
                    <tr key={`${index}-${row.retailer}`} className={isCheapest ? "cheapest-row" : undefined}>
                      <td className="num">{index + 1}</td>
                      <td>
                        <div className="retailer-name">{row.retailer}</div>
                        {plan && <div className="rate-meta">{formatPlanRates(plan)}</div>}
                      </td>
                      <td className="num">{formatMoney(row.supply)}</td>
                      <td className="num">{formatMoney(row.usage)}</td>
                      <td className="num">-{formatMoney(row.solar)}</td>
                      <td className="num">
                        {row.membership === null ? (
                          <span className="muted-cell">Excluded</span>
                        ) : (
                          formatMoney(row.membership)
                        )}
                      </td>
                      <td className="num total-cell">{formatMoney(row.bill)}</td>
                      <td className="num">
                        {isCheapest ? (
                          <span className="cheapest-badge">Cheapest</span>
                        ) : (
                          `+${formatMoney(diff)}`
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
