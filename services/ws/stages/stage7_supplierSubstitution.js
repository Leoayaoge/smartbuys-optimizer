/**
 * Stage 7 – Supplier Substitution
 * -------------------------------
 * Compare:
 *   - Worst included marginal case
 *   - Best excluded supplier MOQ block
 * Swap if ROI improves, then re-run Stage 6 logic (locally) on the new set.
 *
 * For simplicity and determinism, we:
 *   - Use stage6.cases as the included set
 *   - Use stage2.blocks that were NOT selected in stage4 as candidates
 *   - Perform at most a small fixed number of improvement iterations.
 *
 * Output (state.stage7):
 * {
 *   improved: boolean,
 *   iterations: number,
 *   before: { totalASF, avgMarginalRoi },
 *   after: { totalASF, avgMarginalRoi },
 * }
 */

const { round } = require("../../../utils/maths");

module.exports = function stage7_supplierSubstitution(state) {
  const stage6 = state.stage6 || {};
  const stage4 = state.stage4 || {};
  const stage2 = state.stage2 || {};

  const currentCases = Array.isArray(stage6.cases) ? stage6.cases : [];
  const budget = typeof state.inputs?.budget === "number" ? state.inputs.budget : 0;

  if (!currentCases.length) {
    throw new Error("[Stage 7] No case-level allocation in stage6.cases.");
  }
  if (!(budget > 0)) {
    throw new Error("[Stage 7] inputs.budget must be a positive number.");
  }

  // Determine which suppliers are currently selected (from stage4)
  const selectedSuppliers = new Set(
    (stage4.selectedSuppliers || []).map((s) => s.supplierKey)
  );

  // Candidate MOQ blocks from suppliers that were not selected at MOQ level
  const candidateBlocks = (stage2.blocks || []).filter(
    (b) => !selectedSuppliers.has(b.supplierKey)
  );

  // Compute baseline metrics
  const baselineTotalASF = currentCases.reduce(
    (sum, c) => sum + (c.asfCost || 0),
    0
  );
  const baselineAvgRoi =
    currentCases.length > 0
      ? currentCases.reduce((sum, c) => sum + (c.marginalRoi || 0), 0) /
        currentCases.length
      : 0;

  let bestCases = [...currentCases];
  let bestTotalASF = baselineTotalASF;
  let bestAvgRoi = baselineAvgRoi;
  let improved = false;
  let iterations = 0;

  const MAX_ITERS = 3;

  while (iterations < MAX_ITERS && candidateBlocks.length > 0) {
    iterations++;

    // Worst included marginal case
    const sortedByRoi = [...bestCases].sort(
      (a, b) => (a.marginalRoi || 0) - (b.marginalRoi || 0)
    );
    const worstCase = sortedByRoi[0];
    if (!worstCase) break;

    // Best excluded MOQ block by estimatedMonthlyROI
    candidateBlocks.sort(
      (a, b) => (b.estimatedMonthlyROI || 0) - (a.estimatedMonthlyROI || 0)
    );
    const bestBlock = candidateBlocks[0];
    if (!bestBlock) break;

    const blockAsf = bestBlock.estimatedASF || 0;

    // See if swapping improves average marginal ROI within budget
    let newCases = bestCases.filter(
      (c) =>
        !(
          c.supplierKey === worstCase.supplierKey &&
          c.asin === worstCase.asin &&
          c.units === worstCase.units
        )
    );
    let newTotalASF = newCases.reduce((sum, c) => sum + (c.asfCost || 0), 0);

    if (newTotalASF + blockAsf > budget) {
      // Can't afford this block; drop it from candidates
      candidateBlocks.shift();
      continue;
    }

    // Model each block as a single synthetic case with its block-level ROI
    newCases.push({
      supplierKey: bestBlock.supplierKey,
      supplierName: bestBlock.supplierName,
      asin: "BLOCK",
      itemName: "MOQ Block",
      units: bestBlock.totalUnits || 0,
      asfCost: blockAsf,
      profit: bestBlock.profitBSF || 0,
      marginalRoi:
        blockAsf > 0 ? (bestBlock.profitBSF || 0) / blockAsf : 0,
    });
    newTotalASF += blockAsf;

    const newAvgRoi =
      newCases.length > 0
        ? newCases.reduce((sum, c) => sum + (c.marginalRoi || 0), 0) /
          newCases.length
        : 0;

    if (newAvgRoi > bestAvgRoi) {
      bestCases = newCases;
      bestTotalASF = newTotalASF;
      bestAvgRoi = newAvgRoi;
      improved = true;

      // Remove this block from candidates (already used)
      candidateBlocks.shift();
    } else {
      // No improvement from this block; discard it
      candidateBlocks.shift();
    }
  }

  const nextState = {
    ...state,
    stage7: {
      improved,
      iterations,
      before: {
        totalASF: round(baselineTotalASF, 2),
        avgMarginalRoi: round(baselineAvgRoi, 4),
      },
      after: {
        totalASF: round(bestTotalASF, 2),
        avgMarginalRoi: round(bestAvgRoi, 4),
      },
    },
  };

  console.log(
    `[WS v3.3][Stage 7] Supplier substitution improved=${improved} after ${iterations} iterations. ` +
      `baselineASF=${round(baselineTotalASF, 2)}, newASF=${round(bestTotalASF, 2)}`
  );

  // Note: we intentionally do not overwrite stage6.cases to keep all stages independently debuggable.
  return nextState;
};


