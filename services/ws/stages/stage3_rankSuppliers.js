/**
 * Stage 3 – Rank Suppliers
 * ------------------------
 * Sort suppliers by Estimated Monthly ROI DESC using data from stage2.blocks.
 *
 * Output (state.stage3):
 * {
 *   rankedSuppliers: [
 *     {
 *       supplierKey,
 *       supplierName,
 *       moqBlock,              // original block from stage2
 *       estimatedMonthlyROI,
 *       estimatedASF,
 *     },
 *   ],
 *   totals: {
 *     supplierCount,
 *   }
 * }
 */

const { round } = require("../../../utils/maths");

module.exports = function stage3_rankSuppliers(state) {
  const stage2 = state.stage2 || {};
  const blocks = Array.isArray(stage2.blocks) ? stage2.blocks : [];

  if (!blocks.length) {
    throw new Error("[Stage 3] No blocks found in stage2.blocks.");
  }

  const rankedSuppliers = blocks
    .map((block) => ({
      supplierKey: block.supplierKey,
      supplierName: block.supplierName,
      moqBlock: block,
      estimatedMonthlyROI: block.estimatedMonthlyROI || 0,
      estimatedASF: block.estimatedASF || 0,
    }))
    .sort((a, b) => (b.estimatedMonthlyROI || 0) - (a.estimatedMonthlyROI || 0));

  const nextState = {
    ...state,
    stage3: {
      rankedSuppliers,
      totals: {
        supplierCount: rankedSuppliers.length,
      },
    },
  };

  const top = rankedSuppliers[0];
  console.log(
    `[WS v3.3][Stage 3] Ranked ${rankedSuppliers.length} suppliers. Top supplier=${top?.supplierName ||
      "n/a"} ROI=${top ? round(top.estimatedMonthlyROI || 0, 4) : 0}`
  );

  return nextState;
};


