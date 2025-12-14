/**
 * WS Plan v3.3 Engine (Stage-Based)
 * =================================
 *
 * Central coordinator for the 8-stage WS Plan pipeline.
 * Each stage is implemented as a pure function under ./stages and operates
 * on a shared state object with the following contract:
 *
 * {
 *   meta: {
 *     version: "v3.3",
 *     stage: 0,
 *     createdAt: "...",
 *     updatedAt: "..."
 *   },
 *   inputs: {
 *     budget: number
 *   },
 *   data: {
 *     suppliers: [],
 *     products: [],
 *     freightConfig: {}
 *   },
 *   stage1: {},
 *   ...
 *   stage8: {}
 * }
 *
 * Engine API:
 *   runStage(stageNumber, previousState, inputs)
 *
 * Rules:
 *   - If previousState is null → run stage0_load, then the requested stage.
 *   - Only the requested stage is executed after stage0 (no cascading).
 *   - meta.stage and meta.updatedAt are updated on every call.
 *   - All stages are deterministic and side-effect free (beyond logging).
 */

const { round } = require("../../utils/maths");

const stage0Load = require("./stages/stage0_load");
const stage1MoqBlocks = require("./stages/stage1_moqBlocks");
const stage2EstimatedAsf = require("./stages/stage2_estimatedAsf");
const stage3RankSuppliers = require("./stages/stage3_rankSuppliers");
const stage4AllocateBudget = require("./stages/stage4_allocateBudget");
const stage5ExactAsf = require("./stages/stage5_exactAsf");
const stage6ReallocateCases = require("./stages/stage6_reallocateCases");
const stage7SupplierSubstitution = require("./stages/stage7_supplierSubstitution");
const stage8Finalize = require("./stages/stage8_finalize");

const ENGINE_VERSION = "v3.3";

/**
 * Create a brand-new empty state with meta + inputs wired in.
 */
function createEmptyState(inputs) {
  const now = new Date().toISOString();
  return {
    meta: {
      version: ENGINE_VERSION,
      stage: 0,
      createdAt: now,
      updatedAt: now,
    },
    inputs: {
      budget: typeof inputs.budget === "number" ? inputs.budget : 0,
      ...(inputs || {}),
    },
    data: {
      suppliers: [],
      products: [],
      freightConfig: {},
    },
    stage1: {},
    stage2: {},
    stage3: {},
    stage4: {},
    stage5: {},
    stage6: {},
    stage7: {},
    stage8: {},
  };
}

/**
 * Normalise a potentially-partial previous state to the canonical shape.
 */
function normaliseState(previousState, inputs) {
  if (!previousState || typeof previousState !== "object") {
    return createEmptyState(inputs);
  }

  const base = createEmptyState(inputs);

  const merged = {
    ...base,
    ...previousState,
    meta: {
      ...base.meta,
      ...(previousState.meta || {}),
      version: ENGINE_VERSION,
    },
    inputs: {
      ...base.inputs,
      ...(previousState.inputs || {}),
      ...(inputs || {}),
    },
    data: {
      ...base.data,
      ...(previousState.data || {}),
    },
    stage1: previousState.stage1 || base.stage1,
    stage2: previousState.stage2 || base.stage2,
    stage3: previousState.stage3 || base.stage3,
    stage4: previousState.stage4 || base.stage4,
    stage5: previousState.stage5 || base.stage5,
    stage6: previousState.stage6 || base.stage6,
    stage7: previousState.stage7 || base.stage7,
    stage8: previousState.stage8 || base.stage8,
  };

  return merged;
}

/**
 * Dispatch to the correct stage function.
 */
function runSingleStage(stageNumber, state) {
  switch (stageNumber) {
    case 0:
      return stage0Load(state);
    case 1:
      return stage1MoqBlocks(state);
    case 2:
      return stage2EstimatedAsf(state);
    case 3:
      return stage3RankSuppliers(state);
    case 4:
      return stage4AllocateBudget(state);
    case 5:
      return stage5ExactAsf(state);
    case 6:
      return stage6ReallocateCases(state);
    case 7:
      return stage7SupplierSubstitution(state);
    case 8:
      return stage8Finalize(state);
    default:
      throw new Error(`Unsupported stage ${stageNumber}. Must be between 0 and 8.`);
  }
}

/**
 * Public engine entrypoint.
 *
 * @param {number} stageNumber - Integer 1..8
 * @param {Object|null} previousState - Previous state or null
 * @param {Object} inputs - Raw inputs (budget, products, suppliers, etc.)
 * @returns {Promise<Object>} Full updated state
 */
async function runStage(stageNumber, previousState, inputs) {
  if (!stageNumber || typeof stageNumber !== "number") {
    throw new Error("stageNumber must be a number between 1 and 8.");
  }
  if (stageNumber < 1 || stageNumber > 8) {
    throw new Error("stageNumber must be between 1 and 8.");
  }

  // Start from normalised previous state (or brand new).
  let state = normaliseState(previousState, inputs);

  // If this is a fresh run (no previous state) we always go through stage 0 first.
  const isFresh = !previousState;
  if (isFresh) {
    console.log("[WS v3.3] Running stage 0 (load) before stage", stageNumber);
    state = runSingleStage(0, state);
  }

  console.log(`[WS v3.3] Running stage ${stageNumber} for budget=${round(state.inputs.budget || 0, 2)}`);
  state = runSingleStage(stageNumber, state);

  // Bump meta information.
  const now = new Date().toISOString();
  state = {
    ...state,
    meta: {
      ...(state.meta || {}),
      version: ENGINE_VERSION,
      stage: stageNumber,
      createdAt: state.meta && state.meta.createdAt ? state.meta.createdAt : now,
      updatedAt: now,
    },
  };

  return state;
}

module.exports = {
  ENGINE_VERSION,
  runStage,
};


