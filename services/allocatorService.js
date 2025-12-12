/**
 * Allocator Service for WS Plan v3
 * Unified optimization engine - ONE allocator, not four competing ones
 */

const { round } = require('../utils/maths');
const { computeMonthlyROI, computeChurnWeeks, computeDaysOfStock, computeDailySales } = require('./churnService');
const { computeROI, computeProfitPerUnitASF, computeTotalCost, computeTotalProfit } = require('./roiService');
const { computeShipment, computeCurrencyFee, computeFreightMultiplier, computeLandedCostPerUnit } = require('./freightService');

/**
 * Build case-size purchase options for a single SKU
 * @param {Object} product - Product object with all metrics
 * @param {number} maxBudget - Maximum budget available
 * @returns {Array} Array of purchase options [{ cases, units, costBSF, ... }]
 */
function buildCaseSizeOptions(product, maxBudget) {
  const options = [];
  const caseSize = product.caseSize || 1;
  const supplierPrice = product.supplierPrice || 0;
  
  if (supplierPrice <= 0) {
    return options;
  }
  
  const caseCost = supplierPrice * caseSize;
  const maxCasesByBudget = Math.floor(maxBudget / caseCost);
  
  // Max 3 months of stock
  const dailySales = computeDailySales(product.monthlySales, product.sellerCount);
  const maxUnitsBySales = dailySales > 0 
    ? Math.floor(dailySales * 90) // 3 months
    : maxCasesByBudget * caseSize;
  
  const maxCasesBySales = Math.floor(maxUnitsBySales / caseSize);
  const maxCases = Math.min(maxCasesByBudget, maxCasesBySales);
  
  // Generate options: 1 case, 2 cases, ... up to maxCases
  // Limit to reasonable number (e.g., top 20 options)
  const maxOptions = Math.min(maxCases, 20);
  
  for (let cases = 1; cases <= maxOptions; cases++) {
    const units = cases * caseSize;
    const costBSF = cases * caseCost;
    
    if (costBSF > maxBudget) {
      break;
    }
    
    options.push({
      cases: cases,
      units: units,
      costBSF: round(costBSF, 2),
    });
  }
  
  return options;
}

/**
 * Compute metrics for a purchase option after freight
 * @param {Object} product - Base product object
 * @param {Object} option - Purchase option { cases, units, costBSF }
 * @param {Object} supplierInfo - Supplier information
 * @param {Array} freightCurves - Freight regression curves
 * @param {Object} freightConfig - Freight configuration
 * @param {Object} churnConfig - Churn configuration { leadDays, payoutDays }
 * @returns {Object} Enhanced option with all metrics
 */
function computeOptionMetrics(product, option, supplierInfo, freightCurves, freightConfig, churnConfig) {
  // Create a single-product shipment for freight calculation
  const shipmentProducts = [{
    units: option.units,
    weightKg: product.weightKg || 0,
    caseSize: product.caseSize || 1,
    length: product.length || 0,
    width: product.width || 0,
    height: product.height || 0,
  }];
  
  // Compute freight
  const shipment = computeShipment(shipmentProducts, supplierInfo, freightCurves, freightConfig);
  const currencyFee = computeCurrencyFee(option.costBSF, supplierInfo && supplierInfo.isUK);
  const freightMultiplier = computeFreightMultiplier(option.costBSF, shipment.freightCost, currencyFee);
  
  // Compute landed cost
  const landedCostPerUnit = computeLandedCostPerUnit(product.supplierPrice, freightMultiplier);
  const totalCostASF = round(option.units * landedCostPerUnit, 2);
  
  // Compute profit and ROI
  const profitPerUnit = computeProfitPerUnitASF(
    product.amazonPrice,
    product.amazonFees,
    landedCostPerUnit,
    product.vatPerUnit
  );
  const roi = computeROI(profitPerUnit, landedCostPerUnit);
  
  // Compute churn
  const dailySales = computeDailySales(product.monthlySales, product.sellerCount);
  const daysOfStock = computeDaysOfStock(option.units, dailySales);
  const churnWeeks = computeChurnWeeks(
    churnConfig.leadDays,
    daysOfStock,
    churnConfig.payoutDays
  );
  
  // Compute Monthly ROI
  const monthlyROI = computeMonthlyROI(roi, churnWeeks);
  
  // Compute totals
  const totalProfit = computeTotalProfit(option.units, profitPerUnit);
  
  return {
    ...option,
    landedCostPerUnit: round(landedCostPerUnit, 2),
    profitPerUnit: round(profitPerUnit, 2),
    roi: round(roi, 4),
    churnWeeks: round(churnWeeks, 2),
    monthlyROI: round(monthlyROI, 4),
    totalCostASF: totalCostASF,
    totalProfit: round(totalProfit, 2),
    freightCost: shipment.freightCost,
    currencyFee: currencyFee,
    shippingAndFees: round(shipment.freightCost + currencyFee, 2),
  };
}

/**
 * Build supplier bundles (combinations of SKU options)
 * Uses greedy approach: start with best single-product bundles, then combine
 * @param {Array} products - Array of products for this supplier
 * @param {Object} supplierInfo - Supplier information
 * @param {Array} freightCurves - Freight regression curves
 * @param {Object} freightConfig - Freight configuration
 * @param {Object} churnConfig - Churn configuration
 * @param {number} maxBudget - Maximum budget for this supplier
 * @param {number} moq - Minimum order quantity in GBP
 * @returns {Array} Array of supplier bundles (top N by Monthly ROI)
 */
function buildSupplierBundles(products, supplierInfo, freightCurves, freightConfig, churnConfig, maxBudget, moq) {
  if (!Array.isArray(products) || products.length === 0) {
    return [];
  }
  
  // Build options for each product
  const productOptions = [];
  
  products.forEach(function(product) {
    const options = buildCaseSizeOptions(product, maxBudget);
    
    const computedOptions = options.map(function(option) {
      const metrics = computeOptionMetrics(
        product,
        option,
        supplierInfo,
        freightCurves,
        freightConfig,
        churnConfig
      );
      
      return {
        product: product,
        option: metrics,
      };
    });
    
    if (computedOptions.length > 0) {
      productOptions.push({
        asin: product.asin,
        options: computedOptions,
      });
    }
  });
  
  // Build single-product bundles (best option per product)
  const singleProductBundles = [];
  
  productOptions.forEach(function(productData) {
    // Find best option for this product
    let bestOption = null;
    let bestMonthlyROI = -Infinity;
    
    productData.options.forEach(function(item) {
      if (item.option.monthlyROI > bestMonthlyROI) {
        bestMonthlyROI = item.option.monthlyROI;
        bestOption = item;
      }
    });
    
    if (bestOption && bestOption.option.totalCostASF >= moq) {
      singleProductBundles.push({
        products: [bestOption],
        totalCostASF: bestOption.option.totalCostASF,
        totalProfit: bestOption.option.totalProfit,
        monthlyROI: bestOption.option.monthlyROI,
        freightCost: bestOption.option.freightCost,
        currencyFee: bestOption.option.currencyFee,
        costBSF: bestOption.option.costBSF, // Store for later combination
      });
    }
  });
  
  // Build multi-product bundles using greedy combination
  // Start with best single-product bundle, add next best that fits budget
  const multiProductBundles = [];
  const MAX_COMBINATIONS = 5; // Limit combinations to avoid explosion
  
  singleProductBundles.sort(function(a, b) {
    return (b.monthlyROI || 0) - (a.monthlyROI || 0);
  });
  
  // Try combining top bundles
  for (let i = 0; i < Math.min(singleProductBundles.length, MAX_COMBINATIONS); i++) {
    const baseBundle = singleProductBundles[i];
    let currentBundle = {
      products: [...baseBundle.products],
      totalCostASF: baseBundle.totalCostASF,
      totalProfit: baseBundle.totalProfit,
      monthlyROI: baseBundle.monthlyROI,
      freightCost: baseBundle.freightCost,
      currencyFee: baseBundle.currencyFee,
    };
    
    // Try to add other products
    for (let j = 0; j < singleProductBundles.length; j++) {
      if (i === j) continue;
      
      const candidate = singleProductBundles[j];
      
      // Estimate combined cost (simplified - use sum of individual costs)
      // In reality, freight might be slightly different, but this is a good approximation
      const estimatedCombinedCost = currentBundle.totalCostASF + candidate.totalCostASF;
      
      if (estimatedCombinedCost <= maxBudget) {
        // Recompute freight for combined bundle
        const combinedProducts = [...currentBundle.products, ...candidate.products];
        const shipmentProducts = combinedProducts.map(function(item) {
          return {
            units: item.option.units,
            weightKg: item.product.weightKg || 0,
            caseSize: item.product.caseSize || 1,
            length: item.product.length || 0,
            width: item.product.width || 0,
            height: item.product.height || 0,
          };
        });
        
        const shipment = computeShipment(shipmentProducts, supplierInfo, freightCurves, freightConfig);
        const costBSF = combinedProducts.reduce(function(sum, item) {
          return sum + (item.option.costBSF || 0);
        }, 0);
        const currencyFee = computeCurrencyFee(costBSF, supplierInfo && supplierInfo.isUK);
        
        // Recompute metrics for combined bundle
        const totalCostASF = costBSF + shipment.freightCost + currencyFee;
        const totalProfit = combinedProducts.reduce(function(sum, item) {
          return sum + (item.option.totalProfit || 0);
        }, 0);
        
        // Weighted Monthly ROI
        const monthlyROI = totalCostASF > 0
          ? combinedProducts.reduce(function(sum, item) {
              return sum + (item.option.monthlyROI || 0) * (item.option.totalCostASF || 0);
            }, 0) / totalCostASF
          : 0;
        
        // Only accept if it meets MOQ and improves or maintains Monthly ROI (within 5% tolerance)
        const currentMonthlyROI = currentBundle.monthlyROI || 0;
        if (totalCostASF >= moq && monthlyROI >= currentMonthlyROI * 0.95) {
          currentBundle = {
            products: combinedProducts,
            totalCostASF: round(totalCostASF, 2),
            totalProfit: round(totalProfit, 2),
            monthlyROI: round(monthlyROI, 4),
            freightCost: shipment.freightCost,
            currencyFee: currencyFee,
            costBSF: costBSF, // Store for reference
          };
        }
      }
    }
    
    if (currentBundle.totalCostASF >= moq) {
      multiProductBundles.push(currentBundle);
    }
  }
  
  // Combine single and multi-product bundles, sort by Monthly ROI
  const allBundles = [...singleProductBundles, ...multiProductBundles];
  allBundles.sort(function(a, b) {
    return (b.monthlyROI || 0) - (a.monthlyROI || 0);
  });
  
  // Take top 8 bundles
  const MAX_BUNDLES = 8;
  return allBundles.slice(0, MAX_BUNDLES).map(function(bundle) {
    return {
      supplierKey: products[0].supplierKey,
      supplierName: products[0].supplierName,
      products: bundle.products.map(function(item) {
        return {
          asin: item.product.asin,
          itemName: item.product.itemName,
          unitsToOrder: item.option.units,
          supplierPrice: item.product.supplierPrice,
          amazonPrice: item.product.amazonPrice,
          landedCostPerUnit: item.option.landedCostPerUnit,
          profitPerUnit: item.option.profitPerUnit,
          roi: item.option.roi,
          monthlyROI: item.option.monthlyROI,
          churnWeeks: item.option.churnWeeks,
          totalCost: item.option.totalCostASF,
          totalProfit: item.option.totalProfit,
          // Include original product fields for Apps Script (matching v1 layout)
          monthlySales: item.product.monthlySales,
          sellers: item.product.sellerCount,
          codeLink: item.product.codeLink || '',
        };
      }),
      totalCostASF: bundle.totalCostASF,
      totalProfit: bundle.totalProfit,
      monthlyROI: bundle.monthlyROI,
      freightCost: bundle.freightCost,
      currencyFee: bundle.currencyFee,
    };
  });
}

/**
 * Global budget optimization (knapsack variant)
 * Maximize total Monthly ROI while using as much budget as possible
 * Uses dynamic programming for better optimization
 * @param {Array} supplierBundles - Array of bundles from all suppliers
 * @param {number} budget - Total budget
 * @returns {Object} Best allocation { bundles, totalCost, totalProfit, monthlyROI }
 */
function optimizeGlobalBudget(supplierBundles, budget) {
  if (!Array.isArray(supplierBundles) || supplierBundles.length === 0 || !budget || budget <= 0) {
    return {
      bundles: [],
      totalCostASF: 0,
      totalProfit: 0,
      monthlyROI: 0,
      remainingBudget: budget,
    };
  }
  
  // Filter valid bundles
  const validBundles = supplierBundles.filter(function(b) {
    return b && b.totalCostASF > 0 && b.totalCostASF <= budget;
  });
  
  if (validBundles.length === 0) {
    return {
      bundles: [],
      totalCostASF: 0,
      totalProfit: 0,
      monthlyROI: 0,
      remainingBudget: budget,
    };
  }
  
  // For small number of bundles, use exhaustive search
  // For larger sets, use greedy with lookahead
  const MAX_EXHAUSTIVE = 20;
  
  if (validBundles.length <= MAX_EXHAUSTIVE) {
    // Exhaustive search: try all combinations
    return exhaustiveSearch(validBundles, budget);
  } else {
    // Greedy with improvement passes
    return greedyOptimization(validBundles, budget);
  }
}

/**
 * Exhaustive search for optimal combination (for small sets)
 */
function exhaustiveSearch(bundles, budget) {
  const n = bundles.length;
  const maxCombinations = Math.pow(2, n);
  let bestValue = -Infinity;
  let bestCombination = null;
  let bestCost = 0;
  let bestProfit = 0;
  
  // Try all combinations
  for (let mask = 1; mask < maxCombinations; mask++) {
    let cost = 0;
    let profit = 0;
    let weightedROISum = 0;
    const selected = [];
    
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        const bundle = bundles[i];
        if (cost + bundle.totalCostASF <= budget) {
          cost += bundle.totalCostASF;
          profit += bundle.totalProfit;
          weightedROISum += bundle.monthlyROI * bundle.totalCostASF;
          selected.push(bundle);
        } else {
          // Doesn't fit, skip this combination
          cost = Infinity;
          break;
        }
      }
    }
    
    if (cost <= budget && cost > 0) {
      const monthlyROI = cost > 0 ? weightedROISum / cost : 0;
      // Score: prioritize Monthly ROI, but also consider using more budget
      const score = monthlyROI * 1000 + (cost / budget) * 100;
      
      if (score > bestValue) {
        bestValue = score;
        bestCombination = selected;
        bestCost = cost;
        bestProfit = profit;
      }
    }
  }
  
  if (!bestCombination) {
    return {
      bundles: [],
      totalCostASF: 0,
      totalProfit: 0,
      monthlyROI: 0,
      remainingBudget: budget,
    };
  }
  
  const weightedMonthlyROI = bestCost > 0
    ? bestCombination.reduce(function(sum, b) {
        return sum + (b.monthlyROI || 0) * (b.totalCostASF || 0);
      }, 0) / bestCost
    : 0;
  
  return {
    bundles: bestCombination,
    totalCostASF: round(bestCost, 2),
    totalProfit: round(bestProfit, 2),
    monthlyROI: round(weightedMonthlyROI, 4),
    remainingBudget: round(budget - bestCost, 2),
  };
}

/**
 * Greedy optimization with improvement passes (for large sets)
 */
function greedyOptimization(bundles, budget) {
  // Sort by Monthly ROI descending
  const sorted = bundles.slice().sort(function(a, b) {
    return (b.monthlyROI || 0) - (a.monthlyROI || 0);
  });
  
  // Greedy selection
  const selected = [];
  let remaining = budget;
  
  sorted.forEach(function(bundle) {
    if (bundle.totalCostASF <= remaining) {
      selected.push(bundle);
      remaining -= bundle.totalCostASF;
    }
  });
  
  // Improvement pass: try swapping bundles to use more budget
  if (selected.length > 0 && remaining > 0) {
    // Try to replace a selected bundle with a larger one that fits
    for (let i = selected.length - 1; i >= 0; i--) {
      const current = selected[i];
      const available = remaining + current.totalCostASF;
      
      // Find better bundle that fits
      const replacement = sorted.find(function(b) {
        return b.totalCostASF <= available &&
               b.totalCostASF > current.totalCostASF &&
               b.monthlyROI >= current.monthlyROI &&
               !selected.includes(b);
      });
      
      if (replacement) {
        selected[i] = replacement;
        remaining = available - replacement.totalCostASF;
      }
    }
  }
  
  if (selected.length === 0) {
    return {
      bundles: [],
      totalCostASF: 0,
      totalProfit: 0,
      monthlyROI: 0,
      remainingBudget: budget,
    };
  }
  
  const totalCostASF = selected.reduce(function(sum, b) {
    return sum + (b.totalCostASF || 0);
  }, 0);
  
  const totalProfit = selected.reduce(function(sum, b) {
    return sum + (b.totalProfit || 0);
  }, 0);
  
  const weightedMonthlyROI = totalCostASF > 0
    ? selected.reduce(function(sum, b) {
        return sum + (b.monthlyROI || 0) * (b.totalCostASF || 0);
      }, 0) / totalCostASF
    : 0;
  
  return {
    bundles: selected,
    totalCostASF: round(totalCostASF, 2),
    totalProfit: round(totalProfit, 2),
    monthlyROI: round(weightedMonthlyROI, 4),
    remainingBudget: round(budget - totalCostASF, 2),
  };
}

module.exports = {
  buildCaseSizeOptions,
  computeOptionMetrics,
  buildSupplierBundles,
  optimizeGlobalBudget,
};
