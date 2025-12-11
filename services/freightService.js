/**
 * Freight Service for WS Plan v3
 * Computes shipping costs, landed costs, and freight multipliers
 */

const { safeDivide, round } = require('../utils/maths');

/**
 * Compute total weight for a shipment
 * @param {Array} products - Array of products with units, weightKg, caseSize
 * @param {number} packagingWeightPercent - Packaging weight as percentage (0-1)
 * @returns {number} Total weight in kg
 */
function computeTotalWeight(products, packagingWeightPercent = 0) {
  if (!Array.isArray(products) || products.length === 0) {
    return 0;
  }
  
  let totalWeight = 0;
  
  products.forEach(function(product) {
    const units = product.units || 0;
    const weightKg = product.weightKg || 0;
    const caseSize = product.caseSize || 1;
    
    if (units > 0 && weightKg > 0) {
      const cases = Math.ceil(units / caseSize);
      totalWeight += cases * weightKg;
    }
  });
  
  // Add packaging weight
  if (packagingWeightPercent > 0) {
    totalWeight *= (1 + packagingWeightPercent);
  }
  
  return round(totalWeight, 2);
}

/**
 * Compute total CBM (Cubic Meters) for a shipment
 * @param {Array} products - Array of products with units, dimensions, caseSize
 * @returns {number} Total CBM
 */
function computeTotalCBM(products) {
  if (!Array.isArray(products) || products.length === 0) {
    return 0;
  }
  
  let totalCBM = 0;
  
  products.forEach(function(product) {
    const units = product.units || 0;
    const caseSize = product.caseSize || 1;
    const length = product.length || 0; // cm
    const width = product.width || 0; // cm
    const height = product.height || 0; // cm
    
    if (units > 0 && length > 0 && width > 0 && height > 0) {
      const cases = Math.ceil(units / caseSize);
      // Convert cm³ to m³ (divide by 1,000,000)
      const caseCBM = (length * width * height) / 1000000;
      totalCBM += cases * caseCBM;
    }
  });
  
  return round(totalCBM, 3);
}

/**
 * Compute freight cost using regression curve
 * @param {number} weightKg - Total weight in kg
 * @param {number} cbm - Total CBM
 * @param {Array} freightCurves - Array of freight curve objects
 * @param {string} freightMode - Freight mode (e.g., "Air", "Sea", "Road")
 * @returns {number|null} Freight cost or null if no curve matches
 */
function computeFreightFromCurve(weightKg, cbm, freightCurves, freightMode) {
  if (!Array.isArray(freightCurves) || freightCurves.length === 0) {
    return null;
  }
  
  // Find matching curve by freight mode
  const curve = freightCurves.find(function(c) {
    return c.freightMode && 
           c.freightMode.toLowerCase() === String(freightMode || '').toLowerCase();
  });
  
  if (!curve || !Array.isArray(curve.points) || curve.points.length === 0) {
    return null;
  }
  
  // Use weight or CBM based on curve type
  const value = curve.useCBM ? cbm : weightKg;
  
  if (value <= 0) {
    return null;
  }
  
  // Find the two points that bracket the value
  const points = curve.points.sort(function(a, b) {
    return (a.x || 0) - (b.x || 0);
  });
  
  // If value is below first point, use first point's y
  if (value <= points[0].x) {
    return points[0].y || 0;
  }
  
  // If value is above last point, use last point's y
  if (value >= points[points.length - 1].x) {
    return points[points.length - 1].y || 0;
  }
  
  // Linear interpolation between two points
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    
    if (value >= p1.x && value <= p2.x) {
      const slope = safeDivide((p2.y - p1.y), (p2.x - p1.x));
      const freight = p1.y + slope * (value - p1.x);
      return round(freight, 2);
    }
  }
  
  return null;
}

/**
 * Compute freight cost using generic model (rate per KG/CBM)
 * @param {number} weightKg - Total weight in kg
 * @param {number} cbm - Total CBM
 * @param {Object} freightConfig - Freight configuration
 * @param {string} packagingType - Packaging type ("Box", "Pallet", etc.)
 * @param {number} boxCount - Number of boxes
 * @param {number} palletCount - Number of pallets
 * @returns {number} Freight cost
 */
function computeFreightGeneric(weightKg, cbm, freightConfig, packagingType, boxCount = 0, palletCount = 0) {
  if (!freightConfig) {
    return 0;
  }
  
  const ratePerKG = freightConfig.ratePerKG || 0;
  const ratePerCBM = freightConfig.ratePerCBM || 0;
  const minCharge = freightConfig.minCharge || 0;
  const boxSurcharge = freightConfig.boxSurcharge || 0;
  const palletSurcharge = freightConfig.palletSurcharge || 0;
  const handlingFee = freightConfig.handlingFee || 0;
  
  // Compute base freight (max of weight-based or CBM-based)
  const costByWeight = weightKg * ratePerKG;
  const costByCBM = cbm * ratePerCBM;
  let freightCost = Math.max(costByWeight, costByCBM, minCharge);
  
  // Add packaging surcharges
  if (packagingType === 'Box' || packagingType === 'CourierCandidate') {
    freightCost += boxCount * boxSurcharge;
  } else if (packagingType === 'Pallet') {
    freightCost += palletCount * palletSurcharge;
  }
  
  // Add handling fee
  freightCost += handlingFee;
  
  return round(freightCost, 2);
}

/**
 * Compute shipment freight cost
 * @param {Array} products - Array of products in shipment
 * @param {Object} supplierInfo - Supplier information
 * @param {Array} freightCurves - Freight regression curves
 * @param {Object} freightConfig - Freight configuration
 * @returns {Object} { freightCost, method, totalWeight, totalCBM }
 */
function computeShipment(products, supplierInfo, freightCurves, freightConfig) {
  if (!Array.isArray(products) || products.length === 0) {
    return {
      freightCost: 0,
      method: 'none',
      totalWeight: 0,
      totalCBM: 0,
    };
  }
  
  const packagingWeightPercent = (supplierInfo && supplierInfo.packagingWeightPercent) || 0;
  const freightMode = (supplierInfo && supplierInfo.freightMode) || '';
  const packagingType = (supplierInfo && supplierInfo.packagingType) || '';
  const isUK = (supplierInfo && supplierInfo.isUK) || false;
  
  // Compute total weight and CBM
  const totalWeight = computeTotalWeight(products, packagingWeightPercent);
  const totalCBM = computeTotalCBM(products);
  
  // Estimate box/pallet counts (simplified)
  const boxCount = Math.ceil(totalWeight / 20); // Rough estimate: 20kg per box
  const palletCount = Math.ceil(totalCBM / 1.2); // Rough estimate: 1.2 CBM per pallet
  
  let freightCost = 0;
  let method = 'generic';
  
  // Try regression curve first (for non-UK suppliers)
  if (!isUK && freightCurves && freightCurves.length > 0 && freightMode) {
    const curveCost = computeFreightFromCurve(totalWeight, totalCBM, freightCurves, freightMode);
    if (curveCost !== null) {
      freightCost = curveCost;
      method = 'regression';
    }
  }
  
  // Fall back to generic model if no curve or UK supplier
  if (method === 'generic' || freightCost === 0) {
    freightCost = computeFreightGeneric(
      totalWeight,
      totalCBM,
      freightConfig,
      packagingType,
      boxCount,
      palletCount
    );
  }
  
  // For UK domestic, use simple per-box rate if configured
  if (isUK && freightConfig && freightConfig.domesticUkRatePerBox) {
    freightCost = boxCount * freightConfig.domesticUkRatePerBox;
    method = 'domestic_uk';
  }
  
  return {
    freightCost: round(freightCost, 2),
    method: method,
    totalWeight: totalWeight,
    totalCBM: totalCBM,
    boxCount: boxCount,
    palletCount: palletCount,
  };
}

/**
 * Compute currency fee (0.67% for non-UK suppliers)
 * @param {number} costBSF - Cost before shipping and freight
 * @param {boolean} isUK - Whether supplier is UK-based
 * @returns {number} Currency fee
 */
function computeCurrencyFee(costBSF, isUK) {
  if (isUK || !costBSF || costBSF <= 0) {
    return 0;
  }
  return round(costBSF * 0.0067, 2); // 0.67%
}

/**
 * Compute freight multiplier
 * @param {number} costBSF - Cost before shipping and freight
 * @param {number} freightCost - Freight cost
 * @param {number} currencyFee - Currency fee
 * @returns {number} Multiplier (e.g., 1.15 for 15% freight overhead)
 */
function computeFreightMultiplier(costBSF, freightCost, currencyFee) {
  if (!costBSF || costBSF <= 0) {
    return 1.0;
  }
  
  const shippingAndFees = freightCost + currencyFee;
  const multiplier = 1 + (shippingAndFees / costBSF);
  return round(multiplier, 4);
}

/**
 * Compute landed cost per unit
 * @param {number} supplierPrice - Supplier price (EXW)
 * @param {number} freightMultiplier - Freight multiplier
 * @returns {number} Landed cost per unit
 */
function computeLandedCostPerUnit(supplierPrice, freightMultiplier) {
  return round(supplierPrice * freightMultiplier, 2);
}

module.exports = {
  computeTotalWeight,
  computeTotalCBM,
  computeFreightFromCurve,
  computeFreightGeneric,
  computeShipment,
  computeCurrencyFee,
  computeFreightMultiplier,
  computeLandedCostPerUnit,
};
