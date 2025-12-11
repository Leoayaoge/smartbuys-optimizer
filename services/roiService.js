/**
 * ROI Service for WS Plan v3
 * Computes ROI, profit, and Monthly ROI metrics
 */

const { safeDivide } = require('../utils/maths');
const { computeMonthlyROI } = require('./churnService');

/**
 * Compute profit per unit (BSF - Before Shipping and Freight)
 * @param {number} amazonPrice - Amazon selling price
 * @param {number} amazonFees - Amazon fees per unit
 * @param {number} supplierPrice - Supplier price (EXW)
 * @param {number} vatPerUnit - VAT per unit (optional)
 * @returns {number} Profit per unit in GBP
 */
function computeProfitPerUnitBSF(amazonPrice, amazonFees, supplierPrice, vatPerUnit = 0) {
  if (!amazonPrice || !supplierPrice) {
    return 0;
  }
  
  const vat = vatPerUnit || 0;
  return amazonPrice - amazonFees - vat - supplierPrice;
}

/**
 * Compute profit per unit (ASF - After Shipping and Freight)
 * @param {number} amazonPrice - Amazon selling price
 * @param {number} amazonFees - Amazon fees per unit
 * @param {number} landedCostPerUnit - Landed cost per unit (including freight)
 * @param {number} vatPerUnit - VAT per unit (optional)
 * @returns {number} Profit per unit in GBP
 */
function computeProfitPerUnitASF(amazonPrice, amazonFees, landedCostPerUnit, vatPerUnit = 0) {
  if (!amazonPrice || !landedCostPerUnit) {
    return 0;
  }
  
  const vat = vatPerUnit || 0;
  return amazonPrice - amazonFees - vat - landedCostPerUnit;
}

/**
 * Compute ROI (Return on Investment) as decimal
 * @param {number} profitPerUnit - Profit per unit
 * @param {number} costPerUnit - Cost per unit
 * @returns {number} ROI as decimal (e.g., 0.5 for 50%)
 */
function computeROI(profitPerUnit, costPerUnit) {
  return safeDivide(profitPerUnit, costPerUnit);
}

/**
 * Compute Monthly ROI for a product
 * @param {number} roi - ROI as decimal
 * @param {number} churnWeeks - Churn time in weeks
 * @returns {number} Monthly ROI as decimal
 */
function computeProductMonthlyROI(roi, churnWeeks) {
  return computeMonthlyROI(roi, churnWeeks);
}

/**
 * Compute total profit for a product
 * @param {number} units - Number of units
 * @param {number} profitPerUnit - Profit per unit
 * @returns {number} Total profit
 */
function computeTotalProfit(units, profitPerUnit) {
  return (units || 0) * (profitPerUnit || 0);
}

/**
 * Compute total cost for a product
 * @param {number} units - Number of units
 * @param {number} costPerUnit - Cost per unit
 * @returns {number} Total cost
 */
function computeTotalCost(units, costPerUnit) {
  return (units || 0) * (costPerUnit || 0);
}

/**
 * Compute aggregate ROI across multiple products
 * @param {Array} products - Array of products with totalCost and totalProfit
 * @returns {number} Aggregate ROI as decimal
 */
function computeAggregateROI(products) {
  if (!Array.isArray(products) || products.length === 0) {
    return 0;
  }
  
  const totalCost = products.reduce(function(sum, p) {
    return sum + (p.totalCost || 0);
  }, 0);
  
  const totalProfit = products.reduce(function(sum, p) {
    return sum + (p.totalProfit || 0);
  }, 0);
  
  return safeDivide(totalProfit, totalCost);
}

module.exports = {
  computeProfitPerUnitBSF,
  computeProfitPerUnitASF,
  computeROI,
  computeProductMonthlyROI,
  computeTotalProfit,
  computeTotalCost,
  computeAggregateROI,
};
