/**
 * SmartBuys OA Plan Engine (Node.js version)
 * ------------------------------------------
 * Pure data-processing engine extracted from the Apps Script
 * "Generate OA Plan V1" function. NO Google Sheets / UI / formatting.
 *
 * Inputs:
 *   - goodsValues: 2D array (including header row) from "Good products"
 *   - restockTimeValues: 2D array from "Inbound Restock Time"
 *   - restockProductsValues: 2D array from "Inbound Restock Products"
 *   - budget: number
 *   - excludedRetailers: array of lowercase strings
 *
 * Output:
 *   {
 *     plan: [ { ...chosen item fields... }, ... ],
 *     summary: {
 *       totalUnits,
 *       numberOfBuys,
 *       totalCost,
 *       totalProfit,
 *       roiPct,
 *       weightedChurnWeeks,
 *       monthlyRoiPct
 *     }
 *   }
 */

// SmartBuys OA constants (exact values from Apps Script SB object)
const DAYS_PER_MONTH = 30;
const WEEKS_PER_MONTH = 4.33;
const CHURN_CAP_WEEKS = 15;
const BUSINESS_WORDS = /(dell|lenovo|microsoft|hp|dock|docks|monitor)/i;

// ---------- Utilities ported from Apps Script ----------

function cleanNum(v) {
  if (typeof v === "number") return v;
  if (v == null || v === "") return Number.NaN;
  const s = String(v)
    .replace(/\u00A0/g, " ")
    .trim();
  const n = Number(
    s
      .replace(/[\u00A3$%,]/g, "")
      .replace(/[^0-9.\-]/g, "")
  );
  return Number.isNaN(n) ? Number.NaN : n;
}

function extractBrandHost(raw) {
  const UNKNOWN = { brand: "unknown", host: "unknown" };
  if (!raw) return UNKNOWN;
  try {
    const hostMatch = String(raw).match(
      new RegExp("(?:https?:\\/\\/)?(?:www\\.)?([^\\/:#?]+)", "i")
    );
    const host = hostMatch
      ? hostMatch[1].toLowerCase()
      : String(raw).toLowerCase();
    const parts = host.split(".");
    const brand =
      host.endsWith(".co.uk") && parts.length >= 3
        ? parts[parts.length - 3]
        : parts.length >= 2
        ? parts[parts.length - 2]
        : "unknown";
    return { brand, host };
  } catch (_) {
    return UNKNOWN;
  }
}

function mapToSupplierName(brand, host, supplierNames) {
  const low = (x) => String(x || "").toLowerCase();
  const candidates = supplierNames.map((s) => ({
    raw: s,
    key: low(s),
  }));

  const b = low(brand);
  const h = low(host);

  const direct = candidates.find(
    (c) => c.key === b || c.key === h
  );
  if (direct) return direct.raw;

  const clean = (x) =>
    low(x)
      .replace(new RegExp("www\\.|\\.co\\.uk|\\.com", "g"), "")
      .replace(/[^a-z0-9]/g, "");

  const cb = clean(b);
  const ch = clean(h);

  let best = candidates.find(
    (c) =>
      clean(c.key).includes(cb) || cb.includes(clean(c.key))
  );
  if (best) return best.raw;

  best = candidates.find(
    (c) =>
      clean(c.key).includes(ch) || ch.includes(clean(c.key))
  );
  return best ? best.raw : brand || host || "Unknown";
}

function buildColumnMap(headers) {
  return headers.reduce((acc, header, idx) => {
    const key = String(header || "").trim().toLowerCase();
    if (key) acc[key] = idx;
    return acc;
  }, {});
}

function pickFromRow(row, map, fallbackIndex, aliases) {
  if (aliases && aliases.length) {
    for (const alias of aliases) {
      const key = String(alias || "").toLowerCase();
      if (key && map[key] !== undefined) {
        return row[map[key]];
      }
    }
  }
  if (
    typeof fallbackIndex === "number" &&
    fallbackIndex >= 0 &&
    fallbackIndex < row.length
  ) {
    return row[fallbackIndex];
  }
  return "";
}

// ---------- Main OA Plan engine ----------

async function generate({
  goodsValues,
  restockTimeValues,
  restockProductsValues,
  budget,
  excludedRetailers = [],
}) {
  // Ensure arrays are usable
  if (!Array.isArray(goodsValues) || goodsValues.length <= 1) {
    throw new Error('goodsValues must have at least a header and one data row.');
  }
  if (!Array.isArray(restockTimeValues) || restockTimeValues.length <= 1) {
    throw new Error(
      "restockTimeValues must have at least a header and one data row."
    );
  }
  if (!Array.isArray(restockProductsValues) || restockProductsValues.length <= 1) {
    throw new Error(
      "restockProductsValues must have at least a header and one data row."
    );
  }

  const goods = goodsValues;
  const restockTime = restockTimeValues;
  const restockProd = restockProductsValues;

  const goodsHeaderRow = goods[0];
  const goodsRows = goods.slice(1);

  const columnMap = buildColumnMap(goodsHeaderRow);

  const getFromRow = (row, fallbackIndex, aliases) =>
    pickFromRow(row, columnMap, fallbackIndex, aliases);

  // ---------- Lead days by supplier (restockTimeValues) ----------
  const rt = restockTime;
  const leadDaysBySupplier = {};
  const supplierList = [];
  for (let r = 1; r < rt.length; r++) {
    const name = String(rt[r][0] || "").trim();
    if (!name) continue;
    const lead = cleanNum(rt[r][4]);
    leadDaysBySupplier[name.toLowerCase()] = Number.isNaN(lead) ? 0 : lead;
    supplierList.push(name);
  }

  // ---------- Queued churn weeks by ASIN (restockProductsValues) ----------
  const rp = restockProd;
  const rh = rp[0].map((h) => String(h || "").trim().toLowerCase());
  const aCol = rh.indexOf("asin");
  const qCol = rh.findIndex(
    (h) => h.includes("queued") && h.includes("churn")
  );
  const queuedByASIN = {};
  if (aCol >= 0 && qCol >= 0) {
    for (let r = 1; r < rp.length; r++) {
      const asinKey = String(rp[r][aCol] || "")
        .trim()
        .toUpperCase();
      if (!asinKey) continue;
      const w = cleanNum(rp[r][qCol]);
      queuedByASIN[asinKey] = Number.isNaN(w) ? 0 : w;
    }
  }

  // ---------- Build items[] with OA metrics ----------
  const items = [];
  let skippedCount = 0;

  goodsRows.forEach((row, idx) => {
    const asin = String(
      getFromRow(row, 0, ["asin"]) || ""
    )
      .trim()
      .toUpperCase();

    const link = String(
      getFromRow(row, 3, [
        "retail supplier link",
        "retailer link",
        "supplier link",
        "link",
        "url",
      ]) || ""
    ).trim();

    if (!asin || !link) {
      skippedCount++;
      return;
    }

    const productTitle = getFromRow(row, 2, [
      "item name",
      "title",
      "product title",
      "name",
    ]);

    // Determine if link looks like a URL or a retailer name
    const isUrl =
      /^(https?:\/\/|www\.|.*\.[a-z]{2,}(\/|$|\?|#))/i.test(link) ||
      (link.includes(".") && link.includes("/"));

    let brand;
    let host;
    let supplier;

    if (isUrl) {
      const extracted = extractBrandHost(link);
      brand = extracted.brand;
      host = extracted.host;
      supplier = mapToSupplierName(brand, host, supplierList);
    } else {
      const retailerName = link.trim();
      brand = retailerName.toLowerCase();
      host = retailerName.toLowerCase();
      supplier = mapToSupplierName(retailerName, retailerName, supplierList);
      if (
        !supplier ||
        supplier === "Unknown" ||
        supplier.toLowerCase() === "unknown"
      ) {
        supplier = retailerName;
      }
    }

    const supplierKey = (supplier || brand || host || "").toLowerCase();

    const sellers =
      Math.max(
        1,
        cleanNum(
          getFromRow(row, 4, ["# of sellers", "sellers"])
        ) || 1
      ) || 1;

    const monthlySales =
      Math.max(
        0,
        cleanNum(
          getFromRow(row, 5, ["monthly sales", "sales"])
        ) || 0
      ) || 0;

    const amazonPrice = cleanNum(
      getFromRow(row, 6, [
        "amazon price",
        "sell price",
        "amazon sell price",
      ])
    );
    const unitCost = cleanNum(
      getFromRow(row, 7, [
        "retail price",
        "cost",
        "buy cost",
        "retail price",
      ])
    );
    const ppu = cleanNum(
      getFromRow(row, 10, ["profit per unit", "ppu", "profit per unit"])
    );
    let roi = cleanNum(
      getFromRow(row, 13, ["roi %", "roi", "roi%"])
    );
    if (roi > 1) roi /= 100;

    const dailySales = monthlySales / sellers / DAYS_PER_MONTH;
    const unitsWanted = Math.max(
      1,
      Math.ceil(DAYS_PER_MONTH * dailySales)
    );

    const payoutDays = BUSINESS_WORDS.test(String(productTitle || ""))
      ? 42
      : 14;

    const leadDays = leadDaysBySupplier[supplierKey] || 0;
    const queuedWeeks = queuedByASIN[asin] || 0;
    const daysBoughtSeed =
      dailySales > 0 ? unitsWanted / dailySales : 0;

    let churnWeeks =
      (leadDays + daysBoughtSeed + payoutDays) / 7 + queuedWeeks;
    if (Number.isFinite(CHURN_CAP_WEEKS)) {
      churnWeeks = Math.min(CHURN_CAP_WEEKS, churnWeeks);
    }

    const monthlyROI =
      churnWeeks > 0 ? (roi / churnWeeks) * WEEKS_PER_MONTH : 0;

    items.push({
      supplier,
      retailerKey: supplier || brand || host,
      retailerLabel:
        supplier ||
        (brand
          ? brand.charAt(0).toUpperCase() + brand.slice(1)
          : host),
      asin,
      productTitle,
      retailerLink: link,
      sellers,
      monthlySales,
      amazonPrice,
      unitCost,
      ppu,
      roi,
      dailySales,
      unitsWanted,
      leadDays,
      payoutDays,
      queuedWeeks,
      churnWeeks,
      monthlyROI,
    });
  });

  if (!items.length) {
    throw new Error(
      "No valid OA rows found. Check ASIN and Retail Supplier link columns."
    );
  }

  // ---------- Sort items by monthlyROI ----------
  items.sort((a, b) => (b.monthlyROI || 0) - (a.monthlyROI || 0));

  // ---------- Allocate budget to build chosen[] ----------
  let remaining = budget;
  const chosen = [];

  for (const p of items) {
    if (
      excludedRetailers.includes(
        String(p.supplier || "").toLowerCase()
      )
    ) {
      continue;
    }

    const costSafe =
      Number.isNaN(p.unitCost) || p.unitCost <= 0 ? 0 : p.unitCost;
    let buyUnits = 0;

    if (costSafe > 0) {
      const maxUnits = Math.floor(remaining / costSafe);
      buyUnits = Math.min(
        p.unitsWanted,
        Math.max(0, maxUnits)
      );
      if (
        buyUnits === 0 &&
        p.unitsWanted > 0 &&
        remaining >= costSafe
      ) {
        buyUnits = 1;
      }
    } else {
      buyUnits = p.unitsWanted;
    }

    if (buyUnits <= 0) continue;

    const totalCost = buyUnits * costSafe;
    const expProfit =
      buyUnits * (Number.isNaN(p.ppu) ? 0 : p.ppu);
    const daysBought =
      p.dailySales > 0 ? buyUnits / p.dailySales : 0;

    let churnW =
      (p.leadDays + daysBought + p.payoutDays) / 7 +
      (p.queuedWeeks || 0);
    if (Number.isFinite(CHURN_CAP_WEEKS)) {
      churnW = Math.min(CHURN_CAP_WEEKS, churnW);
    }

    const mROI =
      churnW > 0 ? (p.roi / churnW) * WEEKS_PER_MONTH : 0;

    chosen.push({
      retailerKey: p.retailerKey,
      retailerLabel: p.retailerLabel,
      supplier: p.supplier,
      asin: p.asin,
      productTitle: p.productTitle,
      retailerLink: p.retailerLink,
      sellers: p.sellers,
      monthlySales: p.monthlySales,
      amazonPrice: p.amazonPrice,
      unitCost: p.unitCost,
      ppu: p.ppu,
      roi: p.roi,
      dailySales: p.dailySales,
      units: buyUnits,
      totalCost,
      expProfit,
      daysToArrival: p.leadDays,
      daysOfStock: daysBought,
      churnWeeks: churnW,
      monthlyROI: mROI,
    });

    remaining -= totalCost;
    if (remaining <= 0) break;
  }

  // ---------- Global summary ----------
  const totalUnits = chosen.reduce(
    (sum, r) => sum + (r.units || 0),
    0
  );
  const numberOfBuys = chosen.length;
  const totalCost = chosen.reduce(
    (sum, r) => sum + (r.totalCost || 0),
    0
  );
  const totalProfit = chosen.reduce(
    (sum, r) => sum + (r.expProfit || 0),
    0
  );
  const roi = totalCost > 0 ? totalProfit / totalCost : 0;
  const weightedChurnWeeks =
    totalCost > 0
      ? chosen.reduce(
          (s, r) =>
            s + (r.churnWeeks || 0) * (r.totalCost || 0),
          0
        ) / totalCost
      : 0;
  const monthlyRoiPct =
    weightedChurnWeeks > 0
      ? ((roi / weightedChurnWeeks) * WEEKS_PER_MONTH) * 100
      : 0;

  const summary = {
    totalUnits,
    numberOfBuys,
    totalCost,
    totalProfit,
    roiPct: roi * 100,
    weightedChurnWeeks,
    monthlyRoiPct,
  };

  return {
    plan: chosen,
    summary,
  };
}

module.exports = {
  generate,
};


