const express = require("express");

const router = express.Router();

const { generateWsPlan } = require("../controllers/wsPlanController");

router.post("/ws-plan", generateWsPlan);

module.exports = router;


