/**
 * Stage 8 – Finalise
 * ------------------
 * Freeze final buy plan.
 *
 * Using stage6.cases (and stage5 supplier info) we produce:
 *   - Per supplier summary
 *   - Per SKU breakdown
 *   - Budget used
 *   - Expected monthly profit
 *   - Average ROI
 *
 * Output (state.stage8):
 * {
 *   summary: {
 *     budget,
 *     budgetUsed,
 *     budgetRemaining,
 *     expectedProfit,
 *     averageROI,
 *   },
 *   suppliers: [
 *     {
 *       supplierKey,
 *       supplierName,
 *       totalASF,
 *       totalUnits,
 *       expectedProfit,
 *       averageROI,
 *       skus: [ { asin, itemName, units, asfCost, profit, roi }, ... ],
 *     },
 *   ],
 * }
 */

const { round } = require("../../../utils/maths");

module.exports = function stage8_finalize(state) {
  const stage6 = state.stage6 || {};
  const cases = Array.isArray(stage6.cases) ? stage6.cases : [];
  const budget = typeof state.inputs?.budget === "number" ? state.inputs.budget : 0;

  if (!cases.length) {
    throw new Error("[Stage 8] No cases in stage6.cases to finalise.");
  }

  const bySupplier = {};

  cases.forEach((c) => {
    const supplierKey = c.supplierKey || "unknown";
    if (!bySupplier[supplierKey]) {
      bySupplier[supplierKey] = {
        supplierKey,
        supplierName: c.supplierName || "",
        totalASF: 0,
        totalUnits: 0,
        expectedProfit: 0,
        skus: [],
      };
    }

    const asfCost = c.asfCost || 0;
    const profit = c.profit || 0;
    const roi = asfCost > 0 ? profit / asfCost : 0;

    bySupplier[supplierKey].totalASF += asfCost;
    bySupplier[supplierKey].totalUnits += c.units || 0;
    bySupplier[supplierKey].expectedProfit += profit;
    bySupplier[supplierKey].skus.push({
      asin: c.asin,
      itemName: c.itemName,
      units: c.units || 0,
      asfCost: round(asfCost, 2),
      profit: round(profit, 2),
      roi: round(roi, 4),
    });
  });

  const suppliersOut = Object.values(bySupplier).map((s) => {
    const avgRoi =
      s.totalASF > 0 ? s.expectedProfit / s.totalASF : 0;
    return {
      ...s,
      totalASF: round(s.totalASF, 2),
      expectedProfit: round(s.expectedProfit, 2),
      averageROI: round(avgRoi, 4),
    };
  });

  const budgetUsed = suppliersOut.reduce((sum, s) => sum + (s.totalASF || 0), 0);
  const expectedProfit = suppliersOut.reduce(
    (sum, s) => sum + (s.expectedProfit || 0),
    0
  );
  const averageROI =
    budgetUsed > 0 ? expectedProfit / budgetUsed : 0;

  const nextState = {
    ...state,
    stage8: {
      summary: {
        budget: round(budget, 2),
        budgetUsed: round(budgetUsed, 2),
        budgetRemaining: round(budget - budgetUsed, 2),
        expectedProfit: round(expectedProfit, 2),
        averageROI: round(averageROI, 4),
      },
      suppliers: suppliersOut,
    },
  };

  console.log(
    `[WS v3.3][Stage 8] Finalised plan for ${suppliersOut.length} suppliers. ` +
      `budgetUsed=${round(budgetUsed, 2)}, expectedProfit=${round(
        expectedProfit,
        2
      )}, avgROI=${round(averageROI, 4)}`
  );

  return nextState;
};


