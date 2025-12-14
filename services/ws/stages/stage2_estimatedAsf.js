/**
 * Stage 2 – Estimated ASF
 * -----------------------
 * For each MOQ block, estimate shipping using:
 *   - Region avg £/kg or £/CBM (via freightConfig)
 *   - Default freight mode (from supplier info)
 *   - Currency fees
 *
 * Output (state.stage2):
 * {
 *   blocks: [
 *     {
 *       supplierKey,
 *       supplierName,
 *       totalBSF,
 *       estimatedFreight,
 *       currencyFee,
 *       estimatedASF,
 *       estimatedMonthlyROI,
 *     },
 *   ],
 *   totals: { totalBSF, totalASF, totalFreight, totalCurrencyFee }
 * }
 */

const { round, cleanNumber } = require("../../../utils/maths");
const { buildSupplierMap, getSupplierInfo, isUKSupplier } = require("../../../utils/suppliers");
const { computeShipment, computeCurrencyFee, computeFreightMultiplier } = require("../../freightService");

module.exports = function stage2_estimatedAsf(state) {
  const data = state.data || {};
  const stage1 = state.stage1 || {};
  const suppliers = Array.isArray(data.suppliers) ? data.suppliers : [];
  const moqBlocks = Array.isArray(stage1.moqBlocks) ? stage1.moqBlocks : [];
  const freightConfig = data.freightConfig || {};
  const inputs = state.inputs || {};
  const freightCurves = Array.isArray(inputs.freightCurves) ? inputs.freightCurves : [];

  if (!moqBlocks.length) {
    throw new Error("[Stage 2] No MOQ blocks from stage1.moqBlocks.");
  }

  const supplierMap = buildSupplierMap(suppliers);

  const blocksOut = [];
  let totalBSF = 0;
  let totalASF = 0;
  let totalFreight = 0;
  let totalCurrencyFee = 0;

  moqBlocks.forEach((block) => {
    const supplierKey = block.supplierKey;
    const supplierInfo = getSupplierInfo(supplierKey, supplierMap) || {};
    const isUK = isUKSupplier(supplierKey, supplierMap);

    // Map products to the shape expected by freightService
    const shipmentProducts = (block.products || []).map((p) => ({
      units: p.units || p.totalUnits || 0,
      weightKg: cleanNumber(p.weightKg),
      caseSize: cleanNumber(p.caseSize) || 1,
      length: cleanNumber(p.length),
      width: cleanNumber(p.width),
      height: cleanNumber(p.height),
    }));

    const shipment = computeShipment(shipmentProducts, supplierInfo, freightCurves, freightConfig);

    const costBSF = block.totalBSF || 0;
    const currencyFee = computeCurrencyFee(costBSF, isUK);
    const freightMultiplier = computeFreightMultiplier(costBSF, shipment.freightCost, currencyFee);

    const estimatedASF = costBSF * freightMultiplier;

    // Approximate monthly ROI using BSF profit and multiplier
    let profitBSF = 0;
    (block.products || []).forEach((p) => {
      const units = p.units || 0;
      const profitPerUnitBSF = cleanNumber(p.profitPerUnitBSF);
      if (units > 0 && !Number.isNaN(profitPerUnitBSF)) {
        profitBSF += units * profitPerUnitBSF;
      }
    });

    const roi = estimatedASF > 0 ? profitBSF / estimatedASF : 0;
    const estimatedMonthlyROI = roi; // churn-aware refinement happens later

    const enrichedBlock = {
      ...block,
      estimatedFreight: shipment.freightCost,
      freightMethod: shipment.method,
      currencyFee,
      freightMultiplier,
      estimatedASF: round(estimatedASF, 2),
      profitBSF: round(profitBSF, 2),
      estimatedMonthlyROI: round(estimatedMonthlyROI, 4),
    };

    blocksOut.push(enrichedBlock);
    totalBSF += costBSF;
    totalASF += estimatedASF;
    totalFreight += shipment.freightCost;
    totalCurrencyFee += currencyFee;
  });

  const nextState = {
    ...state,
    stage2: {
      blocks: blocksOut,
      totals: {
        totalBSF: round(totalBSF, 2),
        totalASF: round(totalASF, 2),
        totalFreight: round(totalFreight, 2),
        totalCurrencyFee: round(totalCurrencyFee, 2),
      },
    },
  };

  console.log(
    `[WS v3.3][Stage 2] Estimated ASF for ${blocksOut.length} MOQ blocks. totalBSF=${round(
      totalBSF,
      2
    )}, totalASF=${round(totalASF, 2)}`
  );

  return nextState;
};


