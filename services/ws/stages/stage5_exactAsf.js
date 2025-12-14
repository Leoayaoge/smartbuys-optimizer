/**
 * Stage 5 – Exact ASF
 * -------------------
 * For selected suppliers only:
 *   - Determine boxes vs pallets (simplified)
 *   - Compute exact landed cost using freight services
 *   - Recalculate monthly ROI
 *
 * Output (state.stage5):
 * {
 *   suppliers: [
 *     {
 *       supplierKey,
 *       supplierName,
 *       block,           // from stage4
 *       freight,
 *       currencyFee,
 *       freightMultiplier,
 *       exactASF,
 *       exactMonthlyROI,
 *     },
 *   ],
 *   totals: { totalBSF, totalASF, totalFreight, totalCurrencyFee }
 * }
 */

const { round, cleanNumber } = require("../../../utils/maths");
const { buildSupplierMap, getSupplierInfo, isUKSupplier } = require("../../../utils/suppliers");
const {
  computeShipment,
  computeCurrencyFee,
  computeFreightMultiplier,
} = require("../../freightService");

module.exports = function stage5_exactAsf(state) {
  const data = state.data || {};
  const stage4 = state.stage4 || {};

  const selected = Array.isArray(stage4.selectedSuppliers)
    ? stage4.selectedSuppliers
    : [];
  const suppliers = Array.isArray(data.suppliers) ? data.suppliers : [];
  const freightConfig = data.freightConfig || {};
  const inputs = state.inputs || {};
  const freightCurves = Array.isArray(inputs.freightCurves) ? inputs.freightCurves : [];

  if (!selected.length) {
    throw new Error("[Stage 5] No selected suppliers from stage4.selectedSuppliers.");
  }

  const supplierMap = buildSupplierMap(suppliers);

  const suppliersOut = [];
  let totalBSF = 0;
  let totalASF = 0;
  let totalFreight = 0;
  let totalCurrencyFee = 0;

  selected.forEach((entry) => {
    const block = entry.moqBlock || entry.moqBlock;
    if (!block || !Array.isArray(block.products) || !block.products.length) {
      return;
    }

    const supplierKey = entry.supplierKey;
    const supplierInfo = getSupplierInfo(supplierKey, supplierMap) || {};
    const isUK = isUKSupplier(supplierKey, supplierMap);

    // Map products to the shape expected by freightService
    const shipmentProducts = block.products.map((p) => ({
      units: p.units || 0,
      weightKg: cleanNumber(p.weightKg),
      caseSize: cleanNumber(p.caseSize) || 1,
      length: cleanNumber(p.length),
      width: cleanNumber(p.width),
      height: cleanNumber(p.height),
    }));

    const shipment = computeShipment(
      shipmentProducts,
      supplierInfo,
      freightCurves,
      freightConfig
    );

    const costBSF =
      block.totalBSF ||
      block.products.reduce(
        (sum, p) => sum + (p.units || 0) * (p.supplierPrice || 0),
        0
      );

    const currencyFee = computeCurrencyFee(costBSF, isUK);
    const freightMultiplier = computeFreightMultiplier(
      costBSF,
      shipment.freightCost,
      currencyFee
    );
    const exactASF = costBSF * freightMultiplier;

    let profitLand = 0;
    block.products.forEach((p) => {
      const units = p.units || 0;
      const supplierPrice = cleanNumber(p.supplierPrice);
      const amazonPrice = cleanNumber(p.amazonPrice);
      const amazonFees = cleanNumber(p.amazonFees);
      const vatPerUnit = cleanNumber(p.vatPerUnit);

      const landedCostPerUnit = supplierPrice * freightMultiplier;
      const profitPerUnit = amazonPrice - amazonFees - vatPerUnit - landedCostPerUnit;
      profitLand += units * profitPerUnit;
    });

    const roi = exactASF > 0 ? profitLand / exactASF : 0;
    const exactMonthlyROI = roi; // churn refinement happens later

    const supplierEntry = {
      supplierKey,
      supplierName: entry.supplierName,
      block,
      freight: {
        cost: shipment.freightCost,
        method: shipment.method,
        totalWeight: shipment.totalWeight,
        totalCBM: shipment.totalCBM,
        boxCount: shipment.boxCount,
        palletCount: shipment.palletCount,
      },
      currencyFee,
      freightMultiplier,
      exactASF: round(exactASF, 2),
      exactMonthlyROI: round(exactMonthlyROI, 4),
      profitLand: round(profitLand, 2),
    };

    suppliersOut.push(supplierEntry);
    totalBSF += costBSF;
    totalASF += exactASF;
    totalFreight += shipment.freightCost;
    totalCurrencyFee += currencyFee;
  });

  const nextState = {
    ...state,
    stage5: {
      suppliers: suppliersOut,
      totals: {
        totalBSF: round(totalBSF, 2),
        totalASF: round(totalASF, 2),
        totalFreight: round(totalFreight, 2),
        totalCurrencyFee: round(totalCurrencyFee, 2),
      },
    },
  };

  console.log(
    `[WS v3.3][Stage 5] Exact ASF computed for ${suppliersOut.length} suppliers. totalASF=${round(
      totalASF,
      2
    )}`
  );

  return nextState;
};


