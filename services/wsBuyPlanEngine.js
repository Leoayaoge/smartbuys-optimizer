/**
 * SmartBuys Wholesale Buy Plan Engine (Node.js version)
 * -----------------------------------------------------
 * Runs the full WS allocation logic in-memory using:
 *   - budget (number)
 *   - productsSheet (2D array representing the "WS Products" sheet)
 *
 * No SpreadsheetApp / UI / formatting calls. Pure JS only.
 *
 * Returns:
 * {
 *   success: true,
 *   summary: { ...global metrics... },
 *   table: [ [headers...], [...row1], ... ],   // flattened WS Buy Plan rows
 *   suppliers: { [supplierName]: { summary, shipping, shippingInfo, table } }
 * }
 */

module.exports = async function runWholesaleEngine({ budget, productsSheet }) {
  try {
    // Basic input validation
    if (!Array.isArray(productsSheet) || productsSheet.length <= 1) {
      throw new Error("Products sheet data missing or invalid.");
    }

    let globalBudget = Number(budget);
    if (!globalBudget || isNaN(globalBudget) || globalBudget <= 0) {
      throw new Error("Budget is missing or invalid.");
    }

    // -----------------------------
    // Helper utilities (pure JS)
    // -----------------------------

    const normalise = (v) => String(v || "").toLowerCase().trim();

    // Robust supplier key
    const normaliseSupplierKey = (v) =>
      String(v || "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .trim();

    // Find first matching column index
    const findCol = (headers, names) => {
      for (let name of names) {
        const key = normalise(name);
        for (let i = 0; i < headers.length; i++) {
          const h = normalise(headers[i]);
          if (h === key || h.includes(key)) return i;
        }
      }
      return -1;
    };

    // Clean numeric values (currency, %, commas)
    const cleanNumber = (v) => {
      if (v === null || v === "" || v === undefined) return NaN;
      if (typeof v === "number") return v;
      let s = String(v).trim();
      if (!s) return NaN;
      const hasPercent = s.indexOf("%") !== -1;
      s = s.replace(/[£$€,]/g, "").replace(/%/g, "");
      const n = Number(s);
      if (isNaN(n)) return NaN;
      return hasPercent && n > 1 ? n / 100 : n;
    };

    // Same business-word logic as OA plan for payout determination
    const BUSINESS_WORDS = /(dell|lenovo|microsoft|hp|dock|docks|monitor)/i;

    // -----------------------------
    // Static / default configs
    // -----------------------------
    // In Apps Script these are hydrated from other sheets (churn, supplier master,
    // freight config, dimensions, inbound restock, etc). In this backend engine
    // we keep the same structures but default them to empty so the core allocator
    // logic still runs correctly with reasonable fallbacks.

    const churnBySupplier = {}; // { supplierKey: { irstDays, payoutDays } }
    const leadDaysBySupplier = {}; // { supplierKey: leadDays }
    const supplierInfoByKey = {}; // { supplierKey: { name, warehouse, country, freightMode, packagingTypeDefault, packagingWeightPct, moqGBP } }

    // Freight fallback configuration
    const freightCfg = {
      ratePerKG: 0,
      ratePerCBM: 0,
      minCharge: 0,
      handlingFee: 0,
      boxSurcharge: 0,
      palletSurcharge: 0,
      defaultPalletWeightKg: 0,
      defaultPackagingWeightPercent: 0,
      domesticUkRatePerBox: 8,
    };

    // Dimension lookups (ASIN/EAN/title → case sizes, weights, dimensions)
    const dimsByASIN = {};
    const dimsByEAN = {};
    const dimsByTitle = {};

    // ======================================================
    // 1. PARSE INPUT SHEET DATA (2D array → rows)
    // ======================================================

    const productsValues = productsSheet;
    if (productsValues.length <= 1) {
      throw new Error('No data rows in "WS Products".');
    }

    const headers = productsValues[0];
    const dataRows = productsValues.slice(1);

    const colMap = {
      asin: findCol(headers, ["asin"]),
      supplier: findCol(headers, ["supplier"]),
      itemName: findCol(headers, ["item name", "title", "product name"]),
      supplierPrice: findCol(headers, [
        "supplier price (exw)",
        "supplier price",
        "exw",
      ]),
      amazonPrice: findCol(headers, ["amazon price", "sell price"]),
      supplierVat: findCol(headers, ["vat"]),
      amazonFees: findCol(headers, ["amazon fees", "fees"]),
      profitPerUnit: findCol(headers, ["profit per unit", "ppu"]),
      roi: findCol(headers, ["roi %", "roi"]),
      monthlySales: findCol(headers, ["monthly sales", "sales per month"]),
      sellers: findCol(headers, [
        "number of competitors",
        "number of competitors",
        "# of competitors",
        "# of sellers",
        "sellers",
      ]),
      codeLink: findCol(headers, [
        "code/supplier's link",
        "code / supplier's link",
        "code",
        "supplier link",
      ]),
      comments: findCol(headers, ["comments", "notes"]),
      ean: findCol(headers, ["ean", "barcode"]),
    };

    console.log("WS Products column map:", JSON.stringify(colMap));

    // Group rows by supplier
    const productsBySupplier = {};
    const supplierBudget = Math.min(globalBudget, 5000); // per-supplier BSF cap
    const LAMBDA_SLOW_MONEY = 0.25; // penalty for very long churn (years)

    // ======================================================
    // 2. BUILD PRODUCT LIST WITH SCORES PER SUPPLIER
    // ======================================================

    dataRows.forEach((row) => {
      const asin = String(row[colMap.asin] || "").toUpperCase().trim();
      const supplierNameRaw = String(row[colMap.supplier] || "").trim();
      const supplierKey = normaliseSupplierKey(supplierNameRaw);
      if (!asin || !supplierKey) return;

      const itemName = String(row[colMap.itemName] || "").trim();
      const supplierPrice = cleanNumber(row[colMap.supplierPrice]);
      const amazonPrice = cleanNumber(row[colMap.amazonPrice]);
      const amazonFees = cleanNumber(row[colMap.amazonFees]);
      const vatPerUnit =
        colMap.supplierVat >= 0 ? cleanNumber(row[colMap.supplierVat]) : NaN;
      const profitInput = cleanNumber(row[colMap.profitPerUnit]);
      let roiInput = cleanNumber(row[colMap.roi]);
      if (!isNaN(roiInput) && roiInput > 1) roiInput = roiInput / 100; // treat as %
      const monthlySales = cleanNumber(row[colMap.monthlySales]);
      const sellersVal =
        colMap.sellers >= 0 ? cleanNumber(row[colMap.sellers]) : NaN;
      const sellerCount =
        !isNaN(sellersVal) && sellersVal > 0 ? sellersVal : 1;
      const comments = String(row[colMap.comments] || "").trim();
      const codeLink =
        colMap.codeLink >= 0 ? String(row[colMap.codeLink] || "").trim() : "";
      const ean =
        colMap.ean >= 0 ? String(row[colMap.ean] || "").trim() : "";

      if (isNaN(supplierPrice) || supplierPrice <= 0) return;

      const supplierChurn = churnBySupplier[supplierKey] || {};
      let leadDays = leadDaysBySupplier[supplierKey];
      if (leadDays == null && !isNaN(supplierChurn.irstDays)) {
        leadDays = supplierChurn.irstDays;
      }
      if (leadDays == null) leadDays = 0;
      let payoutDays = !isNaN(supplierChurn.payoutDays)
        ? supplierChurn.payoutDays
        : BUSINESS_WORDS.test(itemName)
        ? 42
        : 14;
      const churnCfg = { leadDays, payoutDays };

      const FREIGHT_MULTIPLIER = 1.0; // Phase 2 placeholder
      const landedCost = supplierPrice * FREIGHT_MULTIPLIER;

      // Use WS Products profit per unit as the authoritative BSF profit where available.
      let profitPerUnit = NaN;
      if (!isNaN(profitInput)) {
        profitPerUnit = profitInput;
      } else if (
        !isNaN(amazonPrice) &&
        !isNaN(amazonFees) &&
        !isNaN(supplierPrice)
      ) {
        const vatAdj = !isNaN(vatPerUnit) ? vatPerUnit : 0;
        profitPerUnit = amazonPrice - amazonFees - vatAdj - supplierPrice;
      }
      if (isNaN(profitPerUnit)) profitPerUnit = 0;

      let roi =
        !isNaN(landedCost) && landedCost > 0
          ? profitPerUnit / landedCost
          : isNaN(roiInput)
          ? 0
          : roiInput;
      if (!isFinite(roi)) roi = 0;

      // Infer case size using ASIN, then EAN, then title (maps are empty by default)
      let caseSize = 1;
      const titleKey = normalise(itemName);
      let dimRec = dimsByASIN[asin];
      if (!dimRec && ean) dimRec = dimsByEAN[ean];
      if (!dimRec && titleKey) dimRec = dimsByTitle[titleKey];
      if (dimRec && !isNaN(dimRec.caseSize) && dimRec.caseSize > 0) {
        caseSize = Math.round(dimRec.caseSize);
      }

      // Provisional units used only for ranking (respect max 2 months of stock)
      const maxUnitsByBudget = Math.floor(supplierBudget / supplierPrice);
      const maxUnitsBySales =
        !isNaN(monthlySales) && monthlySales > 0
          ? Math.round(monthlySales * 2) // 2 months of stock
          : maxUnitsByBudget;
      let unitsForRanking = Math.max(
        0,
        Math.min(maxUnitsByBudget, maxUnitsBySales)
      );
      if (caseSize > 1 && unitsForRanking > 0) {
        unitsForRanking = Math.floor(unitsForRanking / caseSize) * caseSize;
      }

      const dailySales =
        !isNaN(monthlySales) && monthlySales > 0
          ? monthlySales / sellerCount / 30
          : 0;
      let daysOfStock =
        dailySales > 0 && unitsForRanking > 0
          ? Math.ceil(unitsForRanking / dailySales)
          : 0;

      const churnWeeks =
        (churnCfg.leadDays + churnCfg.payoutDays + daysOfStock) / 7;
      const monthlyROI = churnWeeks > 0 ? (roi / churnWeeks) * 4.33 : 0;
      const score =
        monthlyROI - LAMBDA_SLOW_MONEY * (churnWeeks / 52); // penalise very slow money

      const product = {
        asin,
        supplierName: supplierNameRaw,
        supplierKey,
        itemName,
        supplierPrice,
        amazonPrice,
        amazonFees,
        vatPerUnit,
        profitPerUnit,
        // Store BSF profit explicitly
        profitPerUnitBSF: profitPerUnit,
        roi,
        monthlySales: isNaN(monthlySales) ? 0 : monthlySales,
        sellerCount,
        comments,
        codeLink,
        churnCfg,
        monthlyROI,
        churnWeeks,
        score,
        caseSize,
      };

      if (!productsBySupplier[supplierKey]) {
        productsBySupplier[supplierKey] = [];
      }
      productsBySupplier[supplierKey].push(product);
    });

    // ======================================================
    // 3. PER-SUPPLIER ALLOCATION + FREIGHT SIMULATION
    // ======================================================

    const supplierPlans = [];

    Object.keys(productsBySupplier).forEach((supplierKey) => {
      const products = productsBySupplier[supplierKey];
      if (!products || !products.length) return;

      const supInfo = supplierInfoByKey[supplierKey];

      // Sort by adjusted score
      products.sort((a, b) => (b.score || 0) - (a.score || 0));

      let remainingBudget = supplierBudget;
      const rowsLocal = [];

      for (let i = 0; i < products.length; i++) {
        const p = products[i];
        const supplierPrice = p.supplierPrice;
        if (!supplierPrice || supplierPrice <= 0) continue;
        if (remainingBudget < supplierPrice) break; // cannot afford another case

        const caseSize = p.caseSize && p.caseSize > 0 ? p.caseSize : 1;

        // Budget cap within supplier MOQ
        let maxUnitsByBudget = Math.floor(remainingBudget / supplierPrice);
        // Max 2 months of stock
        let maxUnitsBySales =
          p.monthlySales > 0 ? Math.floor(p.monthlySales * 2) : maxUnitsByBudget;
        let maxUnits = Math.max(0, Math.min(maxUnitsByBudget, maxUnitsBySales));

        if (caseSize > 1 && maxUnits > 0) {
          maxUnits = Math.floor(maxUnits / caseSize) * caseSize;
        }
        if (maxUnits <= 0) continue;

        const unitsToOrder = maxUnits;
        const FREIGHT_MULTIPLIER = 1.0; // Phase 2 placeholder
        const landedCostPerUnit = supplierPrice * FREIGHT_MULTIPLIER;

        // Recalculate BSF profit with landed cost including VAT where available.
        let profitPerUnit = p.profitPerUnit;
        if (!isNaN(p.amazonPrice) && !isNaN(p.amazonFees)) {
          const vatAdj = !isNaN(p.vatPerUnit) ? p.vatPerUnit : 0;
          profitPerUnit =
            p.amazonPrice - p.amazonFees - vatAdj - landedCostPerUnit;
        }
        if (isNaN(profitPerUnit)) profitPerUnit = 0;

        const roi = landedCostPerUnit > 0 ? profitPerUnit / landedCostPerUnit : 0;

        const sellerCount = p.sellerCount || 1;
        const dailySales =
          p.monthlySales > 0 ? p.monthlySales / sellerCount / 30 : 0;
        let daysOfStock =
          dailySales > 0 ? Math.ceil(unitsToOrder / dailySales) : 0;

        const churnWeeks =
          (p.churnCfg.leadDays + p.churnCfg.payoutDays + daysOfStock) / 7;
        const monthlyROI = churnWeeks > 0 ? (roi / churnWeeks) * 4.33 : 0;

        const estimatedSpend = unitsToOrder * supplierPrice;
        const estimatedTotalProfit = unitsToOrder * profitPerUnit;

        rowsLocal.push({
          supplier: p.supplierName,
          asin: p.asin,
          itemName: p.itemName,
          supplierPrice,
          amazonPrice: p.amazonPrice,
          amazonFees: p.amazonFees,
          vatPerUnit: p.vatPerUnit,
          unitsToOrder,
          estimatedSpend,
          freightMultiplier: FREIGHT_MULTIPLIER,
          landedCostPerUnit,
          profitPerUnit,
          profitPerUnitBSF: p.profitPerUnitBSF || p.profitPerUnit,
          estimatedTotalProfit,
          dailySalesAvg: dailySales,
          daysOfStock,
          churnWeeks,
          monthlyROI,
          notes: p.comments,
          codeLink: p.codeLink,
        });

        remainingBudget -= estimatedSpend;
        if (remainingBudget < supplierPrice) break;
      }

      if (!rowsLocal.length) return;

      // ----- PACKAGING & FREIGHT SIMULATION FOR THIS SUPPLIER -----
      let costBSF = rowsLocal.reduce(
        (s, r) => s + (r.estimatedSpend || 0),
        0
      );
      let totalWeightKG = 0;
      let totalCBM = 0;
      let totalBoxes = 0;
      let palletCount = 0;
      let palletHeight = 0;
      let caseL = 0;
      let caseW = 0;
      let caseH = 0;
      let exampleCaseSize = 0;
      let totalCBMCases = 0;

      try {
        // Packaging weight %
        let packPct =
          supInfo && !isNaN(supInfo.packagingWeightPct)
            ? supInfo.packagingWeightPct
            : freightCfg.defaultPackagingWeightPercent;

        // LEVEL 1 & 2: Units -> Cases -> Boxes, and base gross weight
        rowsLocal.forEach((r) => {
          const asinKey = String(r.asin || "").toUpperCase().trim();
          const dimRec = dimsByASIN[asinKey];
          if (!dimRec) return;

          const units = r.unitsToOrder || 0;
          if (units <= 0) return;

          const thisCaseSize =
            !isNaN(dimRec.caseSize) && dimRec.caseSize > 0
              ? dimRec.caseSize
              : 1;
          const unitWeight = !isNaN(dimRec.unitWeightKg)
            ? dimRec.unitWeightKg
            : 0;

          const thisCaseL = !isNaN(dimRec.Lcm) ? dimRec.Lcm : 0;
          const thisCaseW = !isNaN(dimRec.Wcm) ? dimRec.Wcm : 0;
          const thisCaseH = !isNaN(dimRec.Hcm)
            ? dimRec.Hcm * thisCaseSize
            : 0; // stacked units

          const boxCount = Math.ceil(units / thisCaseSize);
          totalBoxes += boxCount;

          // Case weight including packaging
          let caseWeightKG = unitWeight * thisCaseSize;
          if (!isNaN(packPct) && packPct > 0) {
            caseWeightKG *= 1 + packPct;
          }
          totalWeightKG += caseWeightKG * boxCount;

          // CBM based purely on case geometry
          if (thisCaseL > 0 && thisCaseW > 0 && thisCaseH > 0) {
            const caseVolumeCBM = (thisCaseL * thisCaseW * thisCaseH) / 1e6;
            totalCBMCases += boxCount * caseVolumeCBM;
          }

          // Store first valid case geometry for pallet simulation
          if (
            caseL === 0 &&
            thisCaseL > 0 &&
            thisCaseW > 0 &&
            thisCaseH > 0
          ) {
            caseL = thisCaseL;
            caseW = thisCaseW;
            caseH = thisCaseH;
            exampleCaseSize = thisCaseSize;
          }
        });

        // LEVEL 3 & 4: Boxes -> Pallets and CBM
        const packagingTypeDefault =
          (supInfo && supInfo.packagingTypeDefault) || "";
        const packDefaultLower = String(packagingTypeDefault).toLowerCase();
        const palletL = 120;
        const palletW = 80;

        if (caseL > 0 && caseW > 0 && caseH > 0 && totalBoxes > 0) {
          const casesPerLayer = Math.max(
            1,
            Math.floor(palletL / caseL) * Math.floor(palletW / caseW)
          );

          if (packDefaultLower.includes("pallet")) {
            // Pallet flow
            const layers = Math.ceil(totalBoxes / casesPerLayer);
            palletCount = Math.max(1, Math.ceil(totalBoxes / casesPerLayer));
            palletHeight = layers * caseH;
            const palletCBMPer = (palletL * palletW * palletHeight) / 1e6;
            totalCBM = palletCBMPer * palletCount;
          } else {
            // Box flow (no pallets)
            totalCBM = (totalBoxes * caseL * caseW * caseH) / 1e6;
            palletCount = 0;
            palletHeight = 0;
          }
        }

        // LEVEL 5: Add pallet weight
        if (palletCount > 0 && freightCfg.defaultPalletWeightKg > 0) {
          totalWeightKG += palletCount * freightCfg.defaultPalletWeightKg;
        }

        // LEVEL 6: Freight cost
        const supplierCountryRaw =
          supInfo && supInfo.country ? String(supInfo.country).trim() : "";
        const supplierCountryLower = supplierCountryRaw.toLowerCase();
        const freightModeRaw =
          supInfo && supInfo.freightMode
            ? String(supInfo.freightMode).trim()
            : "";

        let region = "";
        if (
          supplierCountryLower === "netherlands" ||
          supplierCountryLower === "germany" ||
          supplierCountryLower === "italy"
        ) {
          region = "Western EU";
        } else if (supplierCountryLower === "poland") {
          region = "Eastern EU";
        } else if (supplierCountryLower === "united arab emirates") {
          region = "UAE";
        } else if (supplierCountryLower === "hong kong") {
          region = "Asia (Hong Kong)";
        } else if (supplierCountryLower === "singapore") {
          region = "Asia (Singapore)";
        } else if (supplierCountryLower === "california") {
          region = "US West";
        } else if (supplierCountryLower === "new york") {
          region = "US East";
        }

        const chargeableKG = totalWeightKG;
        let freightCost;
        let usedRegression = false;
        let regressionEstimate = NaN;
        let regressionSamples = NaN;
        let regressionUsedForPlan = false;

        // Packaging type selection
        const cbmForRules = totalCBM > 0 ? totalCBM : totalCBMCases;
        const modeUpper = String(freightModeRaw || "").toUpperCase();
        const isUkOrigin =
          supplierCountryLower.includes("united kingdom") ||
          supplierCountryLower === "uk" ||
          supplierCountryLower.endsWith(" uk");
        const isEuOrigin =
          region === "Western EU" || region === "Eastern EU";

        let packagingTypeEffective = "Box";
        let packagingTypeOverride = "";

        // Step 1 — UK → UK Road shipments
        if (isUkOrigin && modeUpper === "ROAD") {
          packagingTypeEffective = "Pallet";
          packagingTypeOverride = "UKDomesticRoadPallet";
        }

        // Step 2 & 3 — EU → UK Road shipments
        if (!packagingTypeOverride && isEuOrigin && modeUpper === "ROAD") {
          if (chargeableKG >= 60 || cbmForRules >= 0.15) {
            packagingTypeEffective = "Pallet";
            packagingTypeOverride = "EURoadPallet";
          } else {
            packagingTypeEffective = "CourierCandidate";
            packagingTypeOverride = "EURoadCourierCandidate";
          }
        }

        // Step 4 — Air Freight: always Any
        if (!packagingTypeOverride && modeUpper === "AIR") {
          packagingTypeEffective = "Any";
          packagingTypeOverride = "AirAny";
        }

        // Step 5 — Sea Freight thresholds
        if (!packagingTypeOverride && modeUpper === "SEA") {
          if (chargeableKG >= 80 || cbmForRules >= 0.25) {
            packagingTypeEffective = "Pallet";
            packagingTypeOverride = "SeaPalletThreshold";
          } else {
            packagingTypeEffective = "Box";
            packagingTypeOverride = "SeaBox";
          }
        }

        // Tiny shipments (<50kg AND <0.10 CBM) → CourierCandidate
        if (
          chargeableKG > 0 &&
          chargeableKG < 50 &&
          cbmForRules > 0 &&
          cbmForRules < 0.1
        ) {
          packagingTypeEffective = "CourierCandidate";
          if (!packagingTypeOverride) {
            packagingTypeOverride = "TinyShipmentCourierCandidate";
          }
        }

        // Fallback to supplier default packaging if still not set (non‑Air only)
        if (!packagingTypeOverride && modeUpper !== "AIR") {
          if (packDefaultLower.indexOf("pallet") !== -1) {
            packagingTypeEffective = "Pallet";
            packagingTypeOverride = "SupplierDefaultPallet";
          } else if (packDefaultLower.indexOf("box") !== -1) {
            packagingTypeEffective = "Box";
            packagingTypeOverride = "SupplierDefaultBox";
          }
        }

        // Standard cartonisation for box / courier shipments
        if (
          (packagingTypeEffective === "Box" ||
            packagingTypeEffective === "CourierCandidate") &&
          chargeableKG > 0
        ) {
          const STD_L = 50;
          const STD_W = 50;
          const STD_H = 40;
          const STD_MAX_KG = 20;
          const STD_CBM = (STD_L * STD_W * STD_H) / 1e6;
          const baseCBM = cbmForRules > 0 ? cbmForRules : totalCBM;
          const boxesByWeight = Math.max(
            1,
            Math.ceil(chargeableKG / STD_MAX_KG)
          );
          const boxesByVolume =
            STD_CBM > 0 && baseCBM > 0
              ? Math.ceil(baseCBM / STD_CBM)
              : boxesByWeight;
          const virtualBoxes = Math.max(boxesByWeight, boxesByVolume);
          totalBoxes = virtualBoxes;
          totalCBM = virtualBoxes * STD_CBM;
          caseL = STD_L;
          caseW = STD_W;
          caseH = STD_H;
        }

        console.log(
          "Freight packaging decision for supplier " +
            (supInfo ? supInfo.name : supplierKey) +
            ": mode=" +
            modeUpper +
            ", region=" +
            region +
            ", packagingType=" +
            packagingTypeEffective +
            " (" +
            packagingTypeOverride +
            "), totalWeightKG=" +
            chargeableKG.toFixed(2) +
            ", totalCBM=" +
            (totalCBM || cbmForRules).toFixed(3)
        );

        // In the backend engine we do NOT attempt to read Freight_Regression_Curve
        // (it lived in a separate sheet in Apps Script). We fall back to the
        // generic weight/CBM model from Freight_Config.

        const isCourierCandidate =
          packagingTypeEffective === "CourierCandidate";

        // For non-UK suppliers, always apply either regression or generic model.
        if (!usedRegression && !isUkOrigin) {
          const costKG = totalWeightKG * (freightCfg.ratePerKG || 0);
          const costCBM = totalCBM * (freightCfg.ratePerCBM || 0);
          freightCost = Math.max(
            costKG,
            costCBM,
            freightCfg.minCharge || 0
          );

          // Box/pallet surcharges
          if (
            packagingTypeEffective === "Box" ||
            packagingTypeEffective === "CourierCandidate"
          ) {
            freightCost += (totalBoxes || 0) * (freightCfg.boxSurcharge || 0);
          } else if (packagingTypeEffective === "Pallet") {
            freightCost +=
              (palletCount || 0) * (freightCfg.palletSurcharge || 0);
          }

          // Handling fee
          freightCost += freightCfg.handlingFee || 0;
        }

        const safeFreightCost =
          typeof freightCost === "number" &&
          !isNaN(freightCost) &&
          freightCost > 0
            ? freightCost
            : 0;

        const supCost = costBSF;

        // Currency fee: 0.67% of BSF for non‑UK suppliers.
        let currencyFee = 0;
        if (!isUkOrigin && supCost > 0) {
          currencyFee = supCost * 0.0067;
        }

        const shippingAndFees = safeFreightCost + currencyFee;

        // Multiplier = 1 + (Shipping & Fees / Cost before shipping)
        const multiplierNeeded =
          supCost > 0 ? 1 + shippingAndFees / supCost : 1;
        const multiplierRounded =
          Math.round(multiplierNeeded * 100) / 100;

        // Apply freight multiplier to each row and recompute margins/ROI.
        rowsLocal.forEach((r) => {
          r.freightMultiplier = multiplierRounded;
          const baseUnitCost = r.supplierPrice || 0;
          r.landedCostPerUnit = baseUnitCost * multiplierRounded;

          const baseProfitBSF = !isNaN(r.profitPerUnitBSF)
            ? r.profitPerUnitBSF
            : r.profitPerUnit;
          const extraCostPerUnit = r.landedCostPerUnit - baseUnitCost;
          let profitLand = baseProfitBSF - extraCostPerUnit;

          // Fallback: recompute from Amazon if needed
          if (!isFinite(profitLand)) {
            const amazonPrice = !isNaN(r.amazonPrice) ? r.amazonPrice : 0;
            const amazonFees = !isNaN(r.amazonFees) ? r.amazonFees : 0;
            const vatAdj = !isNaN(r.vatPerUnit) ? r.vatPerUnit : 0;
            profitLand =
              amazonPrice - amazonFees - vatAdj - r.landedCostPerUnit;
          }
          if (isNaN(profitLand)) profitLand = 0;
          r.profitPerUnit = profitLand;

          const roiRow =
            r.landedCostPerUnit > 0
              ? r.profitPerUnit / r.landedCostPerUnit
              : 0;
          r.roi = roiRow;
          const churnW = r.churnWeeks || 0;
          r.monthlyROI = churnW > 0 ? (roiRow / churnW) * 4.33 : 0;
          r.estimatedTotalProfit =
            (r.unitsToOrder || 0) * r.profitPerUnit;
        });

        const supProfit = rowsLocal.reduce(
          (s, r) => s + (r.estimatedTotalProfit || 0),
          0
        );
        const supRoiDec = supCost > 0 ? supProfit / supCost : 0;
        const supWeightedChurn =
          supCost > 0
            ? rowsLocal.reduce(
                (s, r) =>
                  s + (r.churnWeeks || 0) * (r.estimatedSpend || 0),
                0
              ) / supCost
            : 0;
        const supMonthlyRoiDec =
          supWeightedChurn > 0 ? (supRoiDec / supWeightedChurn) * 4.33 : 0;

        supplierPlans.push({
          supplierKey,
          supplierName: rowsLocal[0].supplier,
          rows: rowsLocal,
          totalSpend: supCost,
          totalSpendASF: supCost + shippingAndFees,
          monthlyROI: supMonthlyRoiDec,
          freightCost: safeFreightCost,
          currencyFee,
          shippingAndFees,
          totalWeightKG,
          totalCBM,
          boxes: totalBoxes,
          pallets: palletCount,
          packagingTypeDefault,
          palletHeight,
          palletL,
          palletW,
          caseL,
          caseW,
          caseH,
          exampleCaseSize,
          regressionEstimate,
          regressionSamples,
          regressionUsedForPlan,
          packagingTypeEffective,
          packagingTypeOverride,
        });
      } catch (err) {
        console.log(
          "Error in freight estimation for supplier " +
            (supInfo ? supInfo.name : supplierKey) +
            ": " +
            err
        );
      }
    });

    // ======================================================
    // 4. GLOBAL SUPPLIER SELECTION UNDER BUDGET
    // ======================================================

    supplierPlans.sort((a, b) => (b.monthlyROI || 0) - (a.monthlyROI || 0));

    const MAX_SUPPLIERS_FOR_SEARCH = 16;
    const plansForSearch = supplierPlans.slice(
      0,
      Math.min(supplierPlans.length, MAX_SUPPLIERS_FOR_SEARCH)
    );

    let bestMonthlyRoiDec = 0;
    let bestCostASF = 0;
    let bestMask = 0;
    let fallbackMonthlyRoiDec = 0;
    let fallbackCostASF = 0;
    let fallbackMask = 0;

    const n = plansForSearch.length;
    const subsetCount = 1 << n;
    const minSpendASF = globalBudget * 0.95;

    for (let mask = 1; mask < subsetCount; mask++) {
      let costASF = 0;
      let costBSF = 0;
      let profit = 0;
      let weightedChurnBSF = 0;

      for (let i = 0; i < n; i++) {
        if (!(mask & (1 << i))) continue;
        const plan = plansForSearch[i];
        const planCostASF = plan.totalSpendASF || plan.totalSpend || 0;
        const planCostBSF = plan.totalSpend || 0;
        if (planCostASF <= 0) continue;

        costASF += planCostASF;
        costBSF += planCostBSF;
        profit += plan.rows.reduce(
          (s, r) => s + (r.estimatedTotalProfit || 0),
          0
        );
        if (planCostBSF > 0) {
          weightedChurnBSF += plan.rows.reduce(
            (s, r) => s + (r.churnWeeks || 0) * (r.estimatedSpend || 0),
            0
          );
        }
      }

      if (
        costASF <= 0 ||
        costASF > globalBudget ||
        costBSF <= 0 ||
        weightedChurnBSF <= 0
      ) {
        continue;
      }

      const roiDec = profit / costASF;
      const weightedChurnWeeks = weightedChurnBSF / costBSF;
      if (!(weightedChurnWeeks > 0)) continue;

      const monthlyRoiDec = (roiDec / weightedChurnWeeks) * 4.33;

      // Primary objective: maximise Monthly ROI among subsets that spend at least
      // 95% of the budget. If none qualify, fall back to best subset <95%.
      const EPS = 1e-6;
      if (costASF >= minSpendASF) {
        if (
          monthlyRoiDec > bestMonthlyRoiDec + EPS ||
          (Math.abs(monthlyRoiDec - bestMonthlyRoiDec) <= EPS &&
            costASF > bestCostASF)
        ) {
          bestMonthlyRoiDec = monthlyRoiDec;
          bestCostASF = costASF;
          bestMask = mask;
        }
      } else {
        if (
          monthlyRoiDec > fallbackMonthlyRoiDec + EPS ||
          (Math.abs(monthlyRoiDec - fallbackMonthlyRoiDec) <= EPS &&
            costASF > fallbackCostASF)
        ) {
          fallbackMonthlyRoiDec = monthlyRoiDec;
          fallbackCostASF = costASF;
          fallbackMask = mask;
        }
      }
    }

    const chosenRows = [];
    const chosenPlans = [];
    let usedGlobalBudget = 0;

    const finalMask = bestMask || fallbackMask;

    if (finalMask !== 0) {
      for (let i = 0; i < n; i++) {
        if (!(finalMask & (1 << i))) continue;
        const plan = plansForSearch[i];
        chosenPlans.push(plan);
        chosenRows.push(...plan.rows);
        usedGlobalBudget += plan.totalSpendASF || plan.totalSpend || 0;
      }
    }

    console.log(
      "Chosen WS products (one per supplier/product): " + chosenRows.length
    );

    // ======================================================
    // 5. GLOBAL SUMMARY METRICS
    // ======================================================

    const totalUnits = chosenRows.reduce(
      (s, r) => s + (r.unitsToOrder || 0),
      0
    );
    const numBuys = chosenRows.length;
    const totalCostBSF = chosenRows.reduce(
      (s, r) => s + (r.estimatedSpend || 0),
      0
    );
    const totalCostASF = chosenPlans.reduce(
      (s, p) => s + (p.totalSpendASF || p.totalSpend || 0),
      0
    );
    const totalProfit = chosenRows.reduce(
      (s, r) => s + (r.estimatedTotalProfit || 0),
      0
    );
    const roiDec = totalCostASF > 0 ? totalProfit / totalCostASF : 0;
    const weightedChurnWeeks =
      totalCostBSF > 0
        ? chosenRows.reduce(
            (s, r) => s + (r.churnWeeks || 0) * (r.estimatedSpend || 0),
            0
          ) / totalCostBSF
        : 0;
    const monthlyRoiDec =
      weightedChurnWeeks > 0 ? (roiDec / weightedChurnWeeks) * 4.33 : 0;

    const summary = {
      budgetInput: globalBudget,
      usedBudgetASF: totalCostASF,
      remainingBudgetASF: Math.max(0, globalBudget - totalCostASF),
      totalUnits,
      numBuys,
      totalCostBSF,
      totalCostASF,
      totalProfit,
      roiDecimal: roiDec,
      weightedChurnWeeks,
      monthlyRoiDecimal: monthlyRoiDec,
    };

    // ======================================================
    // 6. BUILD TABLE + PER-SUPPLIER STRUCTURE (NO SHEETS)
    // ======================================================

    const headersOut = [
      "Supplier",
      "ASIN",
      "Item Name",
      "Code / Supplier's Link",
      "Amazon Price",
      "Supplier Price (EXW)",
      "Multiplier Needed",
      "Landed Cost per Unit",
      "Profit Per Unit (Land.)",
      "ROI",
      "Units to Order",
      "Daily Sales Avg",
      "Days of Stock",
      "Total Cost",
      "Expected Profit",
      "Churn Time",
    ];

    const table = [headersOut.slice()];
    const groupedBySupplier = {};
    const planBySupplier = {};

    chosenPlans.forEach((plan) => {
      const key = String(plan.supplierName || "Unknown").trim();
      planBySupplier[key] = plan;
      groupedBySupplier[key] = plan.rows;
    });

    const supplierNames = Object.keys(groupedBySupplier).sort((a, b) =>
      a.localeCompare(b)
    );

    const suppliers = {};

    const formatDim1 = (v) => {
      const n = Number(v);
      return isNaN(n) ? "" : n.toFixed(1);
    };

    supplierNames.forEach((supplierName) => {
      const rows = groupedBySupplier[supplierName];
      if (!rows || !rows.length) return;
      const plan = planBySupplier[supplierName];

      // Data rows for this supplier
      const data = rows.map((r) => {
        const dailySalesAvg = r.dailySalesAvg || 0;
        const roiRow = r.roi || 0;
        const daysOfStock = r.daysOfStock || 0;
        return [
          r.supplier,
          r.asin,
          r.itemName,
          r.codeLink || "",
          r.amazonPrice || 0,
          r.supplierPrice || 0,
          r.freightMultiplier || 0,
          r.landedCostPerUnit || 0,
          r.profitPerUnit || 0,
          roiRow,
          r.unitsToOrder || 0,
          dailySalesAvg,
          daysOfStock,
          r.estimatedSpend || 0,
          r.estimatedTotalProfit || 0,
          r.churnWeeks || 0,
        ];
      });

      data.forEach((row) => table.push(row));

      // Per-supplier summary
      const costBSF = rows.reduce(
        (s, r) => s + (r.estimatedSpend || 0),
        0
      );
      const costASF =
        plan && plan.shippingAndFees
          ? costBSF + plan.shippingAndFees
          : costBSF;
      const profitSum = rows.reduce(
        (s, r) => s + (r.estimatedTotalProfit || 0),
        0
      );
      const roiSupplierDec = costASF > 0 ? profitSum / costASF : 0;
      let wChurnSupplier = 0;
      if (rows.length === 1) {
        wChurnSupplier = rows[0].churnWeeks || 0;
      } else if (costASF > 0) {
        wChurnSupplier =
          rows.reduce(
            (s, r) => s + (r.churnWeeks || 0) * (r.estimatedSpend || 0),
            0
          ) / costASF;
      }
      const mRoiSupplierDec =
        wChurnSupplier > 0
          ? (roiSupplierDec / wChurnSupplier) * 4.33
          : 0;

      const supKeyNorm = normaliseSupplierKey(supplierName);
      const supInfoLocal = supplierInfoByKey[supKeyNorm] || {};

      const caseDimsStr =
        plan && plan.caseL && plan.caseW && plan.caseH
          ? `${formatDim1(plan.caseL)}×${formatDim1(
              plan.caseW
            )}×${formatDim1(plan.caseH)}`
          : "";
      const palletDimsStr =
        plan && plan.palletL && plan.palletW && plan.palletHeight
          ? `${formatDim1(plan.palletL)}×${formatDim1(
              plan.palletW
            )}×${formatDim1(plan.palletHeight)}`
          : "";
      const caseSizeStr =
        plan && plan.exampleCaseSize ? String(plan.exampleCaseSize) : "";

      const shipping = (plan && plan.freightCost) || 0;
      const currencyFees = (plan && plan.currencyFee) || 0;
      const shippingFeesTotal = (plan && plan.shippingAndFees) || 0;

      const shippingInfo =
        "Logistics - " +
        "\n\n" +
        "Warehouse: " +
        (supInfoLocal.warehouse || "") +
        "\n" +
        "Country: " +
        (supInfoLocal.country || "") +
        "\n\n" +
        "Shipping - " +
        "\n\n" +
        "Freight Mode: " +
        (supInfoLocal.freightMode || "") +
        "\n" +
        "Packaging Type: " +
        (supInfoLocal.packagingTypeDefault || "") +
        "\n" +
        "Case Size: " +
        caseSizeStr +
        "\n" +
        "Case Dimensions (cm): " +
        caseDimsStr +
        "\n" +
        "Total Boxes: " +
        ((plan && plan.boxes) || 0) +
        "\n" +
        "Total Pallets: " +
        ((plan && plan.pallets) || 0) +
        "\n" +
        "Pallet Height (cm): " +
        ((plan && plan.palletHeight) || 0) +
        "\n" +
        "Pallet Dimensions (cm): " +
        palletDimsStr +
        "\n\n" +
        "Totals - " +
        "\n\n" +
        "Total Weight (KG): " +
        ((plan && plan.totalWeightKG) || 0).toFixed(2) +
        "\n" +
        "Total CBM: " +
        ((plan && plan.totalCBM) || 0).toFixed(3) +
        "\n\n" +
        "Shipping cost: £" +
        shipping.toFixed(2);

      suppliers[supplierName] = {
        summary: {
          costBSF,
          costASF,
          expectedProfit: profitSum,
          roiDecimal: roiSupplierDec,
          averageChurnWeeks: wChurnSupplier,
          monthlyRoiDecimal: mRoiSupplierDec,
        },
        shipping: {
          shipping,
          currencyFees,
          shippingAndFeesTotal: shippingFeesTotal,
        },
        shippingInfo,
        table: [headersOut.slice(), ...data],
      };
    });

    return {
      success: true,
      summary,
      table,
      suppliers,
    };
  } catch (err) {
    console.error("Wholesale Engine Error:", err);
    return {
      success: false,
      error: err.message,
      stack: err.stack,
    };
  }
};
