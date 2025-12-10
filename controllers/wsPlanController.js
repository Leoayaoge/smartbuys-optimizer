const runWholesaleEngine = require("../services/wsBuyPlanEngine");

exports.generateWsPlan = async (req, res) => {
  try {
    const { budget, productsSheet } = req.body;

    // Validate: productsSheet must be a 2D array from Google Sheets
    if (!productsSheet || !Array.isArray(productsSheet)) {
      return res.status(400).json({
        success: false,
        error: "Products sheet data missing or invalid.",
      });
    }

    // Validate: budget must be a number
    if (!budget || isNaN(budget)) {
      return res.status(400).json({
        success: false,
        error: "Budget is missing or invalid.",
      });
    }

    // Call the SmartBuys Engine (your heavy logic)
    const engineResult = await runWholesaleEngine({
      budget,
      productsSheet,
    });

    // If engine itself returns a structured error, forward it
    if (!engineResult || engineResult.success === false) {
      return res.status(500).json(
        engineResult || {
          success: false,
          error: "Unknown error from wholesale engine.",
        }
      );
    }

    // Return engine result directly to Google Sheets
    return res.json(engineResult);
  } catch (err) {
    console.error("WS Engine Fatal Error:", err);
    res.status(500).json({
      success: false,
      error: err.message,
      stack: err.stack,
    });
  }
};

