/**
 * Stage 1 – Build MOQ Blocks (BSF)
 * --------------------------------
 * For each supplier:
 *   - Filter valid products
 *   - Rank by monthly ROI (BSF) DESC
 *   - Add cases until supplier MOQ (in GBP) is met
 *
 * Output (state.stage1):
 * {
 *   moqBlocks: [
 *     {
 *       supplierKey,
 *       supplierName,
 *       moqGBP,
 *       totalBSF,
 *       totalUnits,
 *       totalCases,
 *       products: [...],
 *     },
 *   ],
 *   totals: {
 *     supplierCount,
 *     productCount,
 *     includedSuppliers,
 *     includedSkus,
 *     totalBSF,
 *   }
 * }
 */

const { cleanNumber, normalizeSupplierKey, round } = require("../../../utils/maths");
const { buildSupplierMap, getSupplierMOQ, getSupplierInfo } = require("../../../utils/suppliers");

module.exports = function stage1_moqBlocks(state) {
  const data = state.data || {};
  const products = Array.isArray(data.products) ? data.products : [];
  const suppliersInput = Array.isArray(data.suppliers) ? data.suppliers : [];

  if (!products.length) {
    throw new Error("[Stage 1] No products available in state.data.products.");
  }

  const supplierMap = buildSupplierMap(suppliersInput);

  // Group products by supplierKey
  const bySupplier = {};
  products.forEach((pRaw) => {
    const supplierName = pRaw.supplierName || pRaw.supplier || "";
    const supplierKey = normalizeSupplierKey(pRaw.supplierKey || supplierName);

    const supplierPrice = cleanNumber(pRaw.supplierPrice);
    const amazonPrice = cleanNumber(pRaw.amazonPrice);
    const amazonFees = cleanNumber(pRaw.amazonFees);
    const vatPerUnit = cleanNumber(pRaw.vatPerUnit);
    const monthlySales = cleanNumber(pRaw.monthlySales);

    if (!supplierKey || !supplierPrice || supplierPrice <= 0) {
      return;
    }
    if (!monthlySales || monthlySales <= 0) {
      return;
    }

    // Approximate BSF profit per unit
    const profitPerUnitBSF = !Number.isNaN(cleanNumber(pRaw.profitPerUnitBSF))
      ? cleanNumber(pRaw.profitPerUnitBSF)
      : (amazonPrice || 0) - (amazonFees || 0) - (vatPerUnit || 0) - supplierPrice;

    const roiBSF = supplierPrice > 0 ? profitPerUnitBSF / supplierPrice : 0;
    const monthlyRoiBSF = roiBSF; // simple proxy; churn refinements happen later

    const product = {
      ...pRaw,
      supplierKey,
      supplierName,
      supplierPrice,
      profitPerUnitBSF,
      roiBSF,
      monthlyRoiBSF,
      monthlySales,
      caseSize: cleanNumber(pRaw.caseSize) || 1,
    };

    if (!bySupplier[supplierKey]) {
      bySupplier[supplierKey] = [];
    }
    bySupplier[supplierKey].push(product);
  });

  const moqBlocks = [];
  let globalTotalBSF = 0;
  let includedSkus = 0;

  Object.keys(bySupplier).forEach((supplierKey) => {
    const productsForSupplier = bySupplier[supplierKey];
    const supplierInfo = getSupplierInfo(supplierKey, supplierMap) || {};
    const moqGBP = getSupplierMOQ(supplierKey, supplierMap) || 0;

    // Rank by monthly ROI (BSF) DESC
    productsForSupplier.sort((a, b) => (b.monthlyRoiBSF || 0) - (a.monthlyRoiBSF || 0));

    let runningCost = 0;
    let totalUnits = 0;
    let totalCases = 0;
    const chosenProducts = [];

    productsForSupplier.forEach((p) => {
      // Add 1 case at a time to hit MOQ without overshooting massively.
      const caseSize = p.caseSize || 1;
      const caseCost = caseSize * p.supplierPrice;

      // Always include at least one case of the top product if we have an MOQ.
      if (!chosenProducts.length && moqGBP > 0) {
        runningCost += caseCost;
        totalUnits += caseSize;
        totalCases += 1;
        chosenProducts.push({
          ...p,
          units: caseSize,
          cases: 1,
        });
        return;
      }

      if (moqGBP > 0 && runningCost >= moqGBP) {
        return;
      }

      runningCost += caseCost;
      totalUnits += caseSize;
      totalCases += 1;

      chosenProducts.push({
        ...p,
        units: caseSize,
        cases: 1,
      });
    });

    if (!chosenProducts.length) {
      return;
    }

    const totalBSF = chosenProducts.reduce(
      (sum, p) => sum + (p.units * p.supplierPrice),
      0
    );

    const block = {
      supplierKey,
      supplierName: supplierInfo.name || chosenProducts[0].supplierName || "",
      moqGBP,
      totalBSF: round(totalBSF, 2),
      totalUnits,
      totalCases,
      products: chosenProducts,
    };

    moqBlocks.push(block);
    globalTotalBSF += totalBSF;
    includedSkus += chosenProducts.length;
  });

  // Rank blocks by BSF-based monthly ROI proxy (average of products)
  moqBlocks.sort((a, b) => {
    const aRoi =
      a.products.reduce((sum, p) => sum + (p.monthlyRoiBSF || 0), 0) /
      Math.max(1, a.products.length);
    const bRoi =
      b.products.reduce((sum, p) => sum + (p.monthlyRoiBSF || 0), 0) /
      Math.max(1, b.products.length);
    return bRoi - aRoi;
  });

  const nextState = {
    ...state,
    stage1: {
      moqBlocks,
      totals: {
        supplierCount: suppliersInput.length,
        productCount: products.length,
        includedSuppliers: moqBlocks.length,
        includedSkus,
        totalBSF: round(globalTotalBSF, 2),
      },
    },
  };

  console.log(
    `[WS v3.3][Stage 1] Built ${moqBlocks.length} MOQ blocks, includedSkus=${includedSkus}, totalBSF=${round(
      globalTotalBSF,
      2
    )}`
  );

  return nextState;
};


