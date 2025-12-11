const express = require("express");

const router = express.Router();

const { generateOaPlan } = require("../controllers/oaPlanController");

// POST /oa/plan
router.post("/oa/plan", generateOaPlan);

module.exports = router;


