/**
 * WS Plan v1 Controller
 * Handles API requests for WS Plan v1 (regression-based freight)
 */

const { calculateWSPlanV1 } = require('../services/wsPlanV1Service');

exports.generateWSPlanV1 = async (req, res) => {
  try {
    const { products, shipmentInfo, freightCurves, freightConfig } = req.body;
    
    // Validate required fields
    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Products array is required and must not be empty',
      });
    }
    
    if (!shipmentInfo) {
      return res.status(400).json({
        success: false,
        error: 'shipmentInfo is required',
      });
    }
    
    // Call service
    const result = calculateWSPlanV1({
      products,
      shipmentInfo,
      freightCurves: freightCurves || [],
      freightConfig: freightConfig || {},
    });
    
    if (!result || result.success === false) {
      return res.status(500).json(
        result || {
          success: false,
          error: 'Unknown error from WS Plan v1 service',
        }
      );
    }
    
    return res.json(result);
    
  } catch (error) {
    console.error('WS Plan v1 Controller Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
};
