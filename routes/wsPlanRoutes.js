const express = require("express");

const router = express.Router();

const { generateWsPlan } = require("../controllers/wsPlanController");
const { allocateWSPlan } = require("../controllers/wsPlanControllerV3");

// v2 endpoint (legacy)
router.post("/ws-plan", generateWsPlan);

// v3 endpoint (new unified allocator)
router.post("/ws-plan/allocate", allocateWSPlan);

module.exports = router;


