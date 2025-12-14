/**
 * WS Plan v3.3 Controller
 * ------------------------
 * Exposes a stage-based pipeline endpoint:
 *   POST /ws-plan/v3?stage=1..8
 *
 * Body:
 * {
 *   "inputs": { "budget": 10000, ...rawInputs },
 *   "state": { ...previousStageState } // optional
 * }
 *
 * The controller delegates to the v3.3 engine, which returns the full state.
 */

const { runStage } = require("../services/ws/wsPlanV33Engine");

/**
 * Run a single WS Plan v3.3 stage
 * POST /ws-plan/v3?stage=1..8
 */
async function runWSPlanV33Stage(req, res) {
  try {
    const stageParam = req.query.stage;
    const stageNumber = Number(stageParam);

    if (!stageParam || Number.isNaN(stageNumber)) {
      return res.status(400).json({
        success: false,
        error: "Query parameter 'stage' is required and must be a number between 1 and 8.",
      });
    }

    if (stageNumber < 1 || stageNumber > 8) {
      return res.status(400).json({
        success: false,
        error: "Stage must be between 1 and 8.",
      });
    }

    const inputs = req.body && req.body.inputs ? req.body.inputs : {};
    const previousState = req.body && req.body.state ? req.body.state : null;

    if (!inputs || typeof inputs !== "object") {
      return res.status(400).json({
        success: false,
        error: "Request body must include an 'inputs' object.",
      });
    }

    if (typeof inputs.budget !== "number" || !(inputs.budget > 0)) {
      return res.status(400).json({
        success: false,
        error: "inputs.budget must be a positive number.",
      });
    }

    const state = await runStage(stageNumber, previousState, inputs);

    return res.json({
      success: true,
      state,
    });
  } catch (error) {
    console.error("WS Plan v3.3 stage error:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Unexpected error while running WS Plan v3.3.",
    });
  }
}

module.exports = {
  runWSPlanV33Stage,
};


