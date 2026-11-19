# electricity-compare (WattCast)

A client-side web app that compares Australian single-rate electricity plans against a household's daily grid import and solar export data, ranking plans cheapest first.

All calculations run locally in your browser with zero backend and zero external network calls — user data never leaves the device.

## Features

- **Exact decimal arithmetic**: Uses `decimal.js` (precision 40, `ROUND_HALF_UP`) for all energy and currency calculations.
- **Flexible input**: Upload `.xlsx`, `.xls`, `.csv`, or `.txt` files (single multi-sheet workbook or separate files), paste CSV/TSV directly from Excel or Google Sheets, or load the built-in 21-day / 24-plan sample dataset.
- **Daily solar feed-in cap**: Applies tiered feed-in tariffs (`feedInLimit` + `afterLimitFit`) per day after summing any duplicate dates.
- **Optional quarterly & annual estimates**: Linear per-day average projections (`91.25` days / `365` days) kept separate from the exact-period calculation.
- **Single-rate guard**: Clearly rejects time-of-use, controlled load, and EV tariff tables rather than miscalculating them.

## Input formats

### Daily usage table

Required columns (matched case-insensitively with common aliases):

- **Date**: `Date`, `Read Date`, `Day` (`YYYY-MM-DD`, `DD/MM/YYYY`, or Excel date serial)
- **Import kWh**: `Consumption kWh`, `Import kWh`, `Import`, `Usage kWh`
- **Export kWh**: `Sold to Grid kWh`, `Export kWh`, `Export`, `Feed-in kWh`

### Retailer rates table

Rates must be entered in **dollars** (GST-inclusive, matching Energy Made Easy). Entering cents (e.g. `27.39` instead of `0.2739`) triggers a plausibility warning without altering the numbers.

- **Required columns**:
  - **Retailer**: `Retailer`, `Name`, `Plan`, `Plan Name`
  - **Supply charge (`$/day`)**: `Supply Charge`, `Daily Supply Charge`, `Daily Supply`, `Supply`
  - **Usage rate (`$/kWh`)**: `Usage Rate`, `Single Rate`, `Flat Rate`
  - **Feed-in rate (`$/kWh`)**: `Feed-in Rate`, `FiT`, `Solar Rate`, `Solar FiT`
- **Optional columns** (also accept blank cells):
  - **Membership fee (`$`)**: `Membership Fee`, `Membership` (default `0`)
  - **After-limit FiT (`$/kWh`)**: `After Limit FiT`, `After Limit Rate`, `Excess FiT` (default `0`)
  - **Daily feed-in limit (`kWh/day`)**: `Feed-in Limit`, `FiT Limit`, `Export Limit`, `Daily Cap` (default `999`, meaning uncapped)

## Calculation assumptions

- **GST-inclusive**: Rates and totals assume GST-inclusive dollar amounts (as published on Energy Made Easy).
- **Supply days**: Computed as calendar difference `lastDate - firstDate` (e.g. 21 consecutive daily rows = 20 supply days). Missing dates add no usage/export and are still charged supply (with a warning).
- **Bill formula (exact period)**: `bill = supply + usage - solar + membership`.
- **Sorting**: Ascending by exact unrounded `bill`, breaking ties alphabetically by retailer name.

## Planned future improvements

- **Seasonality & climate-location projection**: Current quarterly/annual estimates use a simple per-day average. Future versions should account for season (higher heating in winter, higher cooling and solar export in summer) and geographic location (northern vs. southern Australian climates).
- **Membership fee rules**: Membership fees are currently excluded from projections because retailers apply differing one-time or recurring rules.
- **Additional tariff structures**: Time-of-use, controlled load, EV, demand tariffs, and conditional/pay-on-time discounts are currently out of scope.
- **Spreadsheet dependency (`xlsx`)**: Currently pinned to `xlsx@0.18.5` on npm; evaluate switching to SheetJS's official CDN tarball or an alternative reader before production launch.

## Local development

```bash
npm install
npm run dev      # Start Vite dev server
npm run build    # Type-check (tsc --noEmit) and build dist/
npm test         # Run Vitest unit & golden regression tests
```

## Self-hosting with Docker (Debian / `PLEX-PC`)

This repository includes a multi-stage `Dockerfile`, `nginx.conf`, and `docker-compose.yml` for hosting as a static container (e.g. staging at `wattcast.rockytauhid.dev` in `/home/rocky/docker/wattcast` before moving to `www.wattcast.com.au`):

```bash
mkdir -p /home/rocky/docker/wattcast
cd /home/rocky/docker/wattcast
# Clone or sync this repository here, then:
docker compose up -d --build
```

By default, `docker-compose.yml` binds the Nginx container to `127.0.0.1:8085:80`. Point your existing reverse proxy (Nginx, Caddy, Traefik, or Cloudflare Tunnel) for `wattcast.rockytauhid.dev` to `http://127.0.0.1:8085` (or attach the `wattcast` service to your reverse proxy's shared Docker network and remove `ports`).

## Licence

GPL-3.0
