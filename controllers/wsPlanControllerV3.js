/**
 * WS Plan v3 Controller
 * Handles /ws-plan/allocate endpoint
 */

const { generateWSPlanV3 } = require('../services/wsPlanEngineV3');

/**
 * Allocate WS Plan v3
 * POST /ws-plan/allocate
 */
exports.allocateWSPlan = async (req, res) => {
  try {
    const {
      budget,
      products,
      dims,
      suppliers,
      freightCurves,
      freightConfig,
      churnSettings,
    } = req.body;
    
    // Validate required fields
    if (!budget || isNaN(budget) || budget <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Budget is missing or invalid',
      });
    }
    
    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Products array is missing or empty',
      });
    }
    
    // Call the v3 engine
    const result = await generateWSPlanV3({
      budget,
      products: products || [],
      dims: dims || {},
      suppliers: suppliers || [],
      freightCurves: freightCurves || [],
      freightConfig: freightConfig || {},
      churnSettings: churnSettings || {},
    });
    
    return res.json({
      success: true,
      ...result,
    });
    
  } catch (error) {
    console.error('WS Plan v3 Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};
