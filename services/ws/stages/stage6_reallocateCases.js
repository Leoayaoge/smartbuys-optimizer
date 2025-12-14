/**
 * Stage 6 – Case-Level Reallocation
 * ---------------------------------
 * Build a list of all purchasable cases across selected suppliers (from stage5),
 * rank by marginal Monthly ROI (ASF), and:
 *   - While total ASF > budget: remove worst case
 *   - While total ASF < budget: add best remaining case
 * respecting MOQ implicitly by not going below 0 units for any product.
 *
 * Output (state.stage6):
 * {
 *   cases: [ { supplierKey, asin, units, asfCost, marginalRoi }, ... ],
 *   totals: { totalASF, totalUnits, caseCount }
 * }
 */

const { round, cleanNumber } = require("../../../utils/maths");

module.exports = function stage6_reallocateCases(state) {
  const stage5 = state.stage5 || {};
  const suppliers = Array.isArray(stage5.suppliers) ? stage5.suppliers : [];
  const budget = typeof state.inputs?.budget === "number" ? state.inputs.budget : 0;

  if (!suppliers.length) {
    throw new Error("[Stage 6] No suppliers in stage5.suppliers.");
  }
  if (!(budget > 0)) {
    throw new Error("[Stage 6] inputs.budget must be a positive number.");
  }

  // Flatten to case-level items
  const allCases = [];

  suppliers.forEach((sup) => {
    const block = sup.block;
    if (!block || !Array.isArray(block.products)) return;

    block.products.forEach((p) => {
      const units = p.units || 0;
      if (units <= 0) return;

      const caseSize = cleanNumber(p.caseSize) || units; // treat each "units" as one block if missing
      const caseCount = Math.max(1, Math.floor(units / caseSize));
      const supplierPrice = cleanNumber(p.supplierPrice);
      const amazonPrice = cleanNumber(p.amazonPrice);
      const amazonFees = cleanNumber(p.amazonFees);
      const vatPerUnit = cleanNumber(p.vatPerUnit);

      const landedCostPerUnit = supplierPrice * (sup.freightMultiplier || 1);
      const profitPerUnit = amazonPrice - amazonFees - vatPerUnit - landedCostPerUnit;
      const roiUnit = landedCostPerUnit > 0 ? profitPerUnit / landedCostPerUnit : 0;
      const marginalMonthlyRoi = roiUnit; // churn refinements omitted for simplicity

      for (let i = 0; i < caseCount; i++) {
        const unitsInCase = caseSize;
        const asfCost = unitsInCase * landedCostPerUnit;
        const profit = unitsInCase * profitPerUnit;

        allCases.push({
          supplierKey: sup.supplierKey,
          supplierName: sup.supplierName,
          asin: p.asin,
          itemName: p.itemName,
          units: unitsInCase,
          asfCost,
          profit,
          marginalRoi: asfCost > 0 ? profit / asfCost : 0,
        });
      }
    });
  });

  if (!allCases.length) {
    throw new Error("[Stage 6] No case-level items constructed from suppliers.");
  }

  // Initial ordering by marginal ROI DESC
  allCases.sort((a, b) => (b.marginalRoi || 0) - (a.marginalRoi || 0));

  let selected = [...allCases];
  let remaining = [];

  let totalASF = selected.reduce((sum, c) => sum + (c.asfCost || 0), 0);

  // Remove worst cases while over budget
  while (totalASF > budget && selected.length > 0) {
    // Worst case is at the end (since array is sorted desc)
    const removed = selected.pop();
    remaining.push(removed);
    totalASF -= removed.asfCost || 0;
  }

  // Add best remaining cases while under budget, if any
  // Ensure remaining is sorted by marginal ROI DESC
  remaining.sort((a, b) => (b.marginalRoi || 0) - (a.marginalRoi || 0));
  let idx = 0;
  while (totalASF < budget && idx < remaining.length) {
    const candidate = remaining[idx];
    if (totalASF + (candidate.asfCost || 0) > budget) {
      idx++;
      continue;
    }
    selected.push(candidate);
    totalASF += candidate.asfCost || 0;
    idx++;
  }

  const totalUnits = selected.reduce((sum, c) => sum + (c.units || 0), 0);

  const nextState = {
    ...state,
    stage6: {
      cases: selected,
      totals: {
        totalASF: round(totalASF, 2),
        totalUnits,
        caseCount: selected.length,
      },
    },
  };

  console.log(
    `[WS v3.3][Stage 6] Case-level reallocation produced ${selected.length} cases, totalASF=${round(
      totalASF,
      2
    )}, totalUnits=${totalUnits}`
  );

  return nextState;
};


