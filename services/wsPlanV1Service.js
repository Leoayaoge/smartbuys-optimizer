/**
 * WS Plan v1 Service - Regression-based Freight Calculation
 * ==========================================================
 * 
 * Handles freight calculation using regression curves from Freight_training_data.
 * This service replicates the exact behavior of the last known good working version.
 * 
 * Input:
 * {
 *   products: Array<{ asin, supplier, itemName, supplierPrice, amazonPrice, amazonFees, vatPerUnit, 
 *                    monthlySales, sellers, codeLink, ean, unitsToOrder, caseSize, weightKg, length, width, height }>,
 *   shipmentInfo: { warehouse, country, freightMode, packagingType, region }
 * }
 * 
 * Output:
 * {
 *   products: Array<{ ...original fields, freightMultiplier, landedCostPerUnit, profitPerUnit, roi, monthlyROI, totalCost, expectedProfit }>,
 *   shipmentTotals: { totalWeightKg, totalCBM, boxCount, palletCount },
 *   freight: { costBSF, fuelSurcharge, currencyFee, costASF },
 *   regression: { found: boolean, curveId: string|null, message: string|null }
 * }
 */

const { round } = require('../utils/maths');

/**
 * Normalize string for comparison
 */
function normalize(str) {
  return String(str || '').toLowerCase().trim();
}

/**
 * Normalize supplier key
 */
function normalizeSupplierKey(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Clean number value
 */
function cleanNumber(value) {
  if (value === null || value === undefined || value === '') {
    return NaN;
  }
  if (typeof value === 'number') {
    return value;
  }
  
  const str = String(value).trim();
  if (!str) return NaN;
  
  const hasPercent = str.indexOf('%') !== -1;
  const cleaned = str.replace(/[£$€,]/g, '').replace(/%/g, '');
  const num = Number(cleaned);
  
  if (isNaN(num)) return NaN;
  if (hasPercent && num > 1) {
    return num / 100;
  }
  return num;
}

/**
 * Find regression curve from training data
 * 
 * @param {Array} freightCurves - Array of curve objects from Freight_training_data
 * @param {string} region - Region name
 * @param {string} freightMode - Freight mode (Road/Sea/Air)
 * @param {string} packagingType - Packaging type (Box/Pallet/Any)
 * @param {number} chargeableWeightKg - Total weight in KG
 * @returns {Object|null} - Matched curve row or null
 */
function findRegressionCurve(freightCurves, region, freightMode, packagingType, chargeableWeightKg) {
  if (!freightCurves || !Array.isArray(freightCurves) || freightCurves.length === 0) {
    return null;
  }
  
  const regionNorm = normalize(region || '');
  const modeNorm = normalize(freightMode || '');
  const packagingNorm = normalize(packagingType || '');
  
  // Determine desired packaging type
  let desiredPackagingType = '';
  if (packagingNorm === 'pallet') {
    desiredPackagingType = modeNorm === 'sea' ? 'Pallet' : 'Any';
  } else if (packagingNorm === 'box') {
    desiredPackagingType = 'Box';
  } else {
    desiredPackagingType = 'Any';
  }
  
  let matchedRow = null;
  let fallbackRow = null;
  let fallbackMinKg = null;
  
  for (let i = 0; i < freightCurves.length; i++) {
    const row = freightCurves[i];
    
    // Match region
    const rowRegion = normalize(String(row.region || ''));
    if (regionNorm && rowRegion !== regionNorm) continue;
    
    // Match freight mode
    const rowMode = normalize(String(row.mode || row.freightMode || ''));
    if (modeNorm && rowMode !== modeNorm) continue;
    
    // Match packaging type
    const rowPack = normalize(String(row.packagingType || row.packaging || ''));
    if (desiredPackagingType && rowPack !== normalize(desiredPackagingType)) continue;
    
    // Check weight range
    const minKg = cleanNumber(row.minKg || row['min kg']);
    const maxKg = cleanNumber(row.maxKg || row['max kg']);
    
    const inMin = isNaN(minKg) ? true : chargeableWeightKg >= minKg;
    const inMax = isNaN(maxKg) ? true : chargeableWeightKg <= maxKg;
    
    if (inMin && inMax) {
      matchedRow = row;
      break;
    }
    
    // Track fallback (lowest minKg when weight is below all curves)
    if (!isNaN(minKg) && chargeableWeightKg < minKg) {
      if (!fallbackRow || (typeof fallbackMinKg === 'number' && minKg < fallbackMinKg)) {
        fallbackRow = row;
        fallbackMinKg = minKg;
      }
    }
  }
  
  return matchedRow || fallbackRow;
}

/**
 * Calculate freight using regression curve
 * 
 * @param {Object} curve - Regression curve object
 * @param {number} chargeableWeightKg - Total weight in KG
 * @param {Object} freightConfig - Freight config with fuel surcharge settings
 * @returns {Object} - { costBSF, fuelSurcharge, totalFreight }
 */
function calculateFreightFromCurve(curve, chargeableWeightKg, freightConfig) {
  const intercept = cleanNumber(curve.intercept);
  const slope = cleanNumber(curve.slope);
  const baseFuelRaw = curve.baseFuel || curve['base fuel'] || '';
  
  const baseCost = (isNaN(intercept) ? 0 : intercept) + (isNaN(slope) ? 0 : slope) * chargeableWeightKg;
  
  let fuelSurcharge = 0;
  let totalFreight = baseCost;
  
  const baseFuelStr = String(baseFuelRaw).trim();
  if (baseFuelStr) {
    if (baseFuelStr.indexOf('%') !== -1) {
      // Percentage-based fuel surcharge
      const fuelDec = cleanNumber(baseFuelStr);
      if (!isNaN(fuelDec) && fuelDec !== 0) {
        fuelSurcharge = baseCost * fuelDec;
        totalFreight = baseCost * (1 + fuelDec);
      }
    } else if (baseFuelStr.indexOf('£') !== -1 && baseFuelStr.toLowerCase().indexOf('/kg') !== -1) {
      // Per-KG fuel surcharge
      const numericFuel = Number(baseFuelStr.replace(/[^0-9.]/g, ''));
      if (!isNaN(numericFuel) && numericFuel > 0) {
        fuelSurcharge = numericFuel * chargeableWeightKg;
        totalFreight = baseCost + fuelSurcharge;
      }
    }
  }
  
  return {
    costBSF: round(baseCost, 2),
    fuelSurcharge: round(fuelSurcharge, 2),
    totalFreight: round(totalFreight, 2),
  };
}

/**
 * Calculate shipment totals (weight, CBM, boxes, pallets)
 */
function calculateShipmentTotals(products) {
  let totalWeightKg = 0;
  let totalCBM = 0;
  let totalBoxes = 0;
  let totalPallets = 0;
  
  products.forEach((product) => {
    const unitsToOrder = product.unitsToOrder || 0;
    const caseSize = product.caseSize || 1;
    const weightKg = product.weightKg || 0;
    const length = product.length || 0;
    const width = product.width || 0;
    const height = product.height || 0;
    
    const cases = Math.ceil(unitsToOrder / caseSize);
    const caseWeight = weightKg * caseSize;
    const caseCBM = (length * width * height) / 1000000; // Convert cm³ to m³
    
    totalWeightKg += caseWeight * cases;
    totalCBM += caseCBM * cases;
    
    // Simple box/pallet counting (can be enhanced with packaging type logic)
    if (product.packagingType === 'Pallet') {
      totalPallets += cases;
    } else {
      totalBoxes += cases;
    }
  });
  
  return {
    totalWeightKg: round(totalWeightKg, 2),
    totalCBM: round(totalCBM, 3),
    boxCount: totalBoxes,
    palletCount: totalPallets,
  };
}

/**
 * Main service function: Calculate WS Plan v1 with regression freight
 * 
 * @param {Object} input - Input payload from Apps Script
 * @returns {Object} - Complete plan with freight calculations
 */
function calculateWSPlanV1(input) {
  const { products, shipmentInfo, freightCurves, freightConfig } = input;
  
  if (!products || !Array.isArray(products) || products.length === 0) {
    return {
      success: false,
      error: 'No products provided',
    };
  }
  
  // Calculate shipment totals
  const shipmentTotals = calculateShipmentTotals(products);
  
  // Determine if UK origin (free freight)
  const countryNorm = normalize(shipmentInfo?.country || '');
  const isUkOrigin = countryNorm === 'uk' || countryNorm === 'united kingdom';
  
  // Initialize freight result
  let freight = {
    costBSF: 0,
    fuelSurcharge: 0,
    currencyFee: 0,
    costASF: 0,
  };
  
  let regression = {
    found: false,
    curveId: null,
    message: null,
  };
  
  // Calculate freight using regression (only for non-UK suppliers)
  if (!isUkOrigin && shipmentTotals.totalWeightKg > 0 && freightCurves && freightCurves.length > 0) {
    const region = shipmentInfo?.region || '';
    const freightMode = shipmentInfo?.freightMode || '';
    const packagingType = shipmentInfo?.packagingType || 'Box';
    
    const matchedCurve = findRegressionCurve(
      freightCurves,
      region,
      freightMode,
      packagingType,
      shipmentTotals.totalWeightKg
    );
    
    if (matchedCurve) {
      const freightCalc = calculateFreightFromCurve(
        matchedCurve,
        shipmentTotals.totalWeightKg,
        freightConfig
      );
      
      freight.costBSF = freightCalc.costBSF;
      freight.fuelSurcharge = freightCalc.fuelSurcharge;
      
      regression.found = true;
      regression.curveId = matchedCurve.curveId || matchedCurve.id || null;
    } else {
      regression.found = false;
      regression.message = `No regression curve found for region="${region}", mode="${freightMode}", packaging="${packagingType}", weight=${shipmentTotals.totalWeightKg}kg`;
    }
  } else if (isUkOrigin) {
    regression.found = false;
    regression.message = 'UK origin supplier - freight is free';
  } else if (shipmentTotals.totalWeightKg <= 0) {
    regression.found = false;
    regression.message = 'Invalid shipment weight (0 or negative)';
  } else {
    regression.found = false;
    regression.message = 'No freight curves provided';
  }
  
  // Calculate currency fee: 0.67% of product cost BSF for non-UK suppliers
  const totalCostBSF = products.reduce((sum, p) => {
    return sum + ((p.supplierPrice || 0) * (p.unitsToOrder || 0));
  }, 0);
  
  if (!isUkOrigin && totalCostBSF > 0) {
    freight.currencyFee = round(totalCostBSF * 0.0067, 2);
  }
  
  // Cost ASF = freight cost (BSF + fuel) + currency fee
  freight.costASF = round(freight.costBSF + freight.fuelSurcharge + freight.currencyFee, 2);
  
  // Calculate freight multiplier: 1 + (Shipping & Fees / Cost BSF)
  const shippingAndFees = freight.costASF;
  const freightMultiplier = totalCostBSF > 0 
    ? round(1 + (shippingAndFees / totalCostBSF), 2)
    : 1.0;
  
  // Apply freight multiplier to products and recalculate landed costs
  const processedProducts = products.map((product) => {
    const supplierPrice = product.supplierPrice || 0;
    const unitsToOrder = product.unitsToOrder || 0;
    const amazonPrice = product.amazonPrice || 0;
    const amazonFees = product.amazonFees || 0;
    const vatPerUnit = product.vatPerUnit || 0;
    
    const landedCostPerUnit = round(supplierPrice * freightMultiplier, 2);
    const profitPerUnitBSF = amazonPrice - amazonFees - vatPerUnit - supplierPrice;
    const extraCostPerUnit = landedCostPerUnit - supplierPrice;
    const profitPerUnit = round(profitPerUnitBSF - extraCostPerUnit, 2);
    
    const roi = landedCostPerUnit > 0 ? round(profitPerUnit / landedCostPerUnit, 4) : 0;
    
    // Churn calculation (simplified - should come from backend churn service)
    const monthlySales = product.monthlySales || 0;
    const sellers = product.sellers || 1;
    const dailySales = monthlySales > 0 && sellers > 0 ? (monthlySales / sellers) / 30 : 0;
    const daysOfStock = dailySales > 0 && unitsToOrder > 0 ? Math.ceil(unitsToOrder / dailySales) : 0;
    const leadDays = product.leadDays || 0;
    const payoutDays = product.payoutDays || 14;
    const churnWeeks = (leadDays + payoutDays + daysOfStock) / 7;
    const monthlyROI = churnWeeks > 0 ? round((roi / churnWeeks) * 4.33, 4) : 0;
    
    return {
      ...product,
      freightMultiplier: freightMultiplier,
      landedCostPerUnit: landedCostPerUnit,
      profitPerUnit: profitPerUnit,
      roi: roi,
      monthlyROI: monthlyROI,
      totalCost: round(landedCostPerUnit * unitsToOrder, 2),
      expectedProfit: round(profitPerUnit * unitsToOrder, 2),
      dailySalesAvg: round(dailySales, 2),
      daysOfStock: daysOfStock,
      churnWeeks: round(churnWeeks, 2),
    };
  });
  
  return {
    success: true,
    products: processedProducts,
    shipmentTotals: {
      ...shipmentTotals,
      warehouse: shipmentInfo?.warehouse || '',
      country: shipmentInfo?.country || '',
      freightMode: shipmentInfo?.freightMode || '',
      packagingType: shipmentInfo?.packagingType || '',
    },
    freight: freight,
    regression: regression,
  };
}

module.exports = {
  calculateWSPlanV1,
};
