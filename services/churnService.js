/**
 * Churn Service for WS Plan v3
 * Computes churn time (lead days + days of stock + payout days)
 */

const DAYS_PER_MONTH = 30;
const WEEKS_PER_MONTH = 4.33;
const BUSINESS_WORDS = /(dell|lenovo|microsoft|hp|dock|docks|monitor)/i;

/**
 * Get payout days based on product title
 * Business products get 42 days, others get 14 days
 */
function getPayoutDays(productTitle) {
  if (!productTitle) return 14;
  return BUSINESS_WORDS.test(String(productTitle)) ? 42 : 14;
}

/**
 * Get churn configuration for a supplier
 * @param {string} supplierKey - Normalized supplier key
 * @param {Object} churnSettings - Churn settings map { supplierKey: { irstDays, payoutDays } }
 * @param {Object} supplierInfo - Supplier info object
 * @returns {Object} { leadDays, payoutDays }
 */
function getChurnConfig(supplierKey, churnSettings, supplierInfo) {
  const churn = churnSettings[supplierKey] || {};
  
  const leadDays = typeof churn.irstDays === 'number' && !isNaN(churn.irstDays)
    ? churn.irstDays
    : 0;
  
  const payoutDays = typeof churn.payoutDays === 'number' && !isNaN(churn.payoutDays)
    ? churn.payoutDays
    : 14; // Default payout days
  
  return { leadDays, payoutDays };
}

/**
 * Compute daily sales from monthly sales and seller count
 */
function computeDailySales(monthlySales, sellerCount) {
  if (!monthlySales || monthlySales <= 0 || !sellerCount || sellerCount <= 0) {
    return 0;
  }
  return monthlySales / sellerCount / DAYS_PER_MONTH;
}

/**
 * Compute days of stock for given units and daily sales
 */
function computeDaysOfStock(units, dailySales) {
  if (!dailySales || dailySales <= 0) {
    return 0;
  }
  return units / dailySales;
}

/**
 * Compute churn weeks
 * @param {number} leadDays - Lead days (IRST)
 * @param {number} daysOfStock - Days of stock
 * @param {number} payoutDays - Payout days
 * @returns {number} Churn time in weeks
 */
function computeChurnWeeks(leadDays, daysOfStock, payoutDays) {
  const totalDays = leadDays + daysOfStock + payoutDays;
  return totalDays / 7;
}

/**
 * Compute monthly ROI from ROI and churn weeks
 * @param {number} roi - ROI (decimal, e.g., 0.5 for 50%)
 * @param {number} churnWeeks - Churn time in weeks
 * @returns {number} Monthly ROI (decimal)
 */
function computeMonthlyROI(roi, churnWeeks) {
  if (!churnWeeks || churnWeeks <= 0) {
    return 0;
  }
  return (roi / churnWeeks) * WEEKS_PER_MONTH;
}

/**
 * Compute weighted churn weeks across multiple products
 * @param {Array} products - Array of products with churnWeeks and cost
 * @returns {number} Weighted average churn weeks
 */
function computeWeightedChurnWeeks(products) {
  if (!Array.isArray(products) || products.length === 0) {
    return 0;
  }
  
  const totalCost = products.reduce(function(sum, p) {
    return sum + (p.totalCost || 0);
  }, 0);
  
  if (totalCost <= 0) {
    return 0;
  }
  
  const weightedSum = products.reduce(function(sum, p) {
    return sum + (p.churnWeeks || 0) * (p.totalCost || 0);
  }, 0);
  
  return weightedSum / totalCost;
}

module.exports = {
  getPayoutDays,
  getChurnConfig,
  computeDailySales,
  computeDaysOfStock,
  computeChurnWeeks,
  computeMonthlyROI,
  computeWeightedChurnWeeks,
  DAYS_PER_MONTH,
  WEEKS_PER_MONTH,
};
