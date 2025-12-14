const express = require("express");

const router = express.Router();

const { generateWsPlan } = require("../controllers/wsPlanController");
const { allocateWSPlan } = require("../controllers/wsPlanControllerV3");
const { generateWSPlanV1 } = require("../controllers/wsPlanV1Controller");
const { runWSPlanV33Stage } = require("../controllers/wsPlanControllerV3_3");

// v2 endpoint (legacy)
router.post("/ws-plan", generateWsPlan);

// v3 endpoint (new unified allocator)
router.post("/ws-plan/allocate", allocateWSPlan);

// v3.3 endpoint (stage-based pipeline)
router.post("/ws-plan/v3", runWSPlanV33Stage);

// v1 endpoint (regression-based freight)
router.post("/ws-plan/v1", generateWSPlanV1);

module.exports = router;


