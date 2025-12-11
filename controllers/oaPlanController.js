const { generate } = require("../services/oaPlanEngine");

exports.generateOaPlan = async (req, res) => {
  try {
    const {
      goodsValues,
      restockTimeValues,
      restockProductsValues,
      budget,
      excludedRetailers,
    } = req.body || {};

    // Basic shape validation
    if (!Array.isArray(goodsValues) || goodsValues.length <= 1) {
      return res.status(400).json({
        success: false,
        error: "goodsValues must be a non-empty 2D array with a header row.",
      });
    }

    if (!Array.isArray(restockTimeValues) || restockTimeValues.length <= 1) {
      return res.status(400).json({
        success: false,
        error:
          "restockTimeValues must be a non-empty 2D array with a header row.",
      });
    }

    if (
      !Array.isArray(restockProductsValues) ||
      restockProductsValues.length <= 1
    ) {
      return res.status(400).json({
        success: false,
        error:
          "restockProductsValues must be a non-empty 2D array with a header row.",
      });
    }

    const numericBudget = Number(budget);
    if (!numericBudget || Number.isNaN(numericBudget) || numericBudget <= 0) {
      return res.status(400).json({
        success: false,
        error: "Budget is missing or invalid.",
      });
    }

    const excluded =
      Array.isArray(excludedRetailers) && excludedRetailers.length
        ? excludedRetailers.map((s) => String(s || "").toLowerCase().trim())
        : [];

    const result = await generate({
      goodsValues,
      restockTimeValues,
      restockProductsValues,
      budget: numericBudget,
      excludedRetailers: excluded,
    });

    return res.json({
      success: true,
      ...result,
    });
  } catch (err) {
    console.error("OA Plan Engine Fatal Error:", err);
    return res.status(500).json({
      success: false,
      error: err.message,
      stack: err.stack,
    });
  }
};


