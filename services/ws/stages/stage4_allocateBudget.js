/**
 * Stage 4 – Budget Allocation (MOQ Level)
 * --------------------------------------
 * Walk ranked suppliers and add MOQ blocks while:
 *   Estimated ASF ≤ remaining budget
 *
 * Output (state.stage4):
 * {
 *   selectedSuppliers: [ rankedSupplierEntry, ... ],
 *   rejectedSuppliers: [ rankedSupplierEntry, ... ],
 *   totals: {
 *     budget,
 *     spentASF,
 *     remainingASF,
 *     selectedCount,
 *   }
 * }
 */

const { round } = require("../../../utils/maths");

module.exports = function stage4_allocateBudget(state) {
  const stage3 = state.stage3 || {};
  const rankedSuppliers = Array.isArray(stage3.rankedSuppliers)
    ? stage3.rankedSuppliers
    : [];
  const budget = typeof state.inputs?.budget === "number" ? state.inputs.budget : 0;

  if (!rankedSuppliers.length) {
    throw new Error("[Stage 4] No ranked suppliers from stage3.rankedSuppliers.");
  }
  if (!(budget > 0)) {
    throw new Error("[Stage 4] inputs.budget must be a positive number.");
  }

  let remaining = budget;
  const selectedSuppliers = [];
  const rejectedSuppliers = [];

  rankedSuppliers.forEach((entry) => {
    const asf = entry.estimatedASF || 0;
    if (asf <= 0) {
      rejectedSuppliers.push({ ...entry, reason: "non_positive_asf" });
      return;
    }

    if (asf <= remaining) {
      selectedSuppliers.push(entry);
      remaining -= asf;
    } else {
      rejectedSuppliers.push({ ...entry, reason: "insufficient_budget" });
    }
  });

  const spentASF = budget - remaining;

  const nextState = {
    ...state,
    stage4: {
      selectedSuppliers,
      rejectedSuppliers,
      totals: {
        budget: round(budget, 2),
        spentASF: round(spentASF, 2),
        remainingASF: round(remaining, 2),
        selectedCount: selectedSuppliers.length,
      },
    },
  };

  console.log(
    `[WS v3.3][Stage 4] Selected ${selectedSuppliers.length} suppliers under budget=${round(
      budget,
      2
    )}. spentASF=${round(spentASF, 2)}, remainingASF=${round(remaining, 2)}`
  );

  return nextState;
};


