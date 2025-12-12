/**
 * SmartBuys Wholesale Buy Plan Engine v3
 * ======================================
 *
 * Unified, modular, deterministic optimization engine
 * Moves all heavy calculation from Apps Script to Node.js backend
 *
 * Versioning
 * ----------
 * We track semantic engine versions as 3.x.y so that we can
 * later answer questions like "why did v3.4 freight logic
 * work better than v3.6?". Every time we change the core logic
 * (especially allocation / freight / churn), we should bump
 * the version and document the change in the version log.
 *
 * Input:
 * {
 *   budget: number,
 *   products: Array<{ asin, supplier, supplierPrice, amazonPrice, ... }>,
 *   dims: { byASIN: {}, byEAN: {}, byTitle: {} },
 *   suppliers: Array<{ name, warehouse, country, ... }>,
 *   freightCurves: Array<{ freightMode, points: [{x, y}] }>,
 *   freightConfig: { ratePerKG, ratePerCBM, ... },
 *   churnSettings: { supplierKey: { irstDays, payoutDays } }
 * }
 *
 * Output:
 * {
 *   engineVersion: string, // e.g. "3.1.0"
 *   summary: { totalUnits, totalCostASF, expectedProfit, remainingBudget, monthlyROI },
 *   suppliers: Array<{ supplierKey, supplierName, freight, products: [...] }>
 * }
 */

// NOTE: This is the canonical engine version for v3.
// Start explicit tracking at 3.1.0; bump on logic changes.
const ENGINE_VERSION = '3.1.0';

const { cleanNumber, normalizeSupplierKey, round } = require('../utils/maths');
const { getCaseSize, getDimensions, getWeight } = require('../utils/dims');
const { buildSupplierMap, getSupplierInfo, getSupplierMOQ } = require('../utils/suppliers');
const { getChurnConfig, getPayoutDays } = require('./churnService');
const { computeProfitPerUnitBSF, computeROI } = require('./roiService');
const { buildSupplierBundles, optimizeGlobalBudget } = require('./allocatorService');

/**
 * Main WS Plan v3 engine
 */
async function generateWSPlanV3(input) {
  try {
    const {
      budget,
      products,
      dims,
      suppliers,
      freightCurves,
      freightConfig,
      churnSettings,
    } = input;
    
    // Validate inputs
    const globalBudget = Number(budget);
    if (!globalBudget || isNaN(globalBudget) || globalBudget <= 0) {
      throw new Error('Budget is missing or invalid');
    }
    
    if (!Array.isArray(products) || products.length === 0) {
      throw new Error('Products array is missing or empty');
    }
    
    // Build lookup maps
    const supplierMap = buildSupplierMap(suppliers || []);
    
    // ============================================
    // STEP 1: Preprocess products and compute raw metrics
    // ============================================
    
    const processedProducts = [];
    
    products.forEach(function(product) {
      const asin = String(product.asin || '').toUpperCase().trim();
      const supplierName = String(product.supplier || '').trim();
      const supplierKey = normalizeSupplierKey(supplierName);
      
      if (!asin || !supplierKey) {
        return; // Skip invalid products
      }
      
      const supplierPrice = cleanNumber(product.supplierPrice);
      const amazonPrice = cleanNumber(product.amazonPrice);
      const amazonFees = cleanNumber(product.amazonFees);
      const vatPerUnit = cleanNumber(product.vatPerUnit);
      const monthlySales = cleanNumber(product.monthlySales);
      const sellerCount = Math.max(1, cleanNumber(product.sellers) || 1);
      
      if (!supplierPrice || supplierPrice <= 0) {
        return; // Skip products with invalid price
      }
      
      // Drop items with 0 velocity
      if (!monthlySales || monthlySales <= 0) {
        return;
      }
      
      // Get dimensions
      const caseSize = getCaseSize(asin, product.ean, product.itemName, dims);
      const dimsObj = getDimensions(asin, product.ean, product.itemName, dims);
      const weightKg = getWeight(asin, product.ean, product.itemName, dims);
      
      // Compute raw ROI (BSF)
      const profitPerUnitBSF = computeProfitPerUnitBSF(
        amazonPrice,
        amazonFees,
        supplierPrice,
        vatPerUnit
      );
      const roiBSF = computeROI(profitPerUnitBSF, supplierPrice);
      
      // Get supplier info and churn config
      const supplierInfo = getSupplierInfo(supplierKey, supplierMap);
      const churnConfig = getChurnConfig(supplierKey, churnSettings || {}, supplierInfo);
      
      processedProducts.push({
        asin: asin,
        supplierKey: supplierKey,
        supplierName: supplierName,
        itemName: String(product.itemName || '').trim(),
        supplierPrice: supplierPrice,
        amazonPrice: amazonPrice,
        amazonFees: amazonFees,
        vatPerUnit: vatPerUnit || 0,
        profitPerUnitBSF: profitPerUnitBSF,
        roiBSF: roiBSF,
        monthlySales: monthlySales,
        sellerCount: sellerCount,
        caseSize: caseSize,
        length: dimsObj.length,
        width: dimsObj.width,
        height: dimsObj.height,
        weightKg: weightKg,
        supplierInfo: supplierInfo,
        churnConfig: churnConfig,
        codeLink: String(product.codeLink || '').trim(), // Preserve code link for output
      });
    });
    
    if (processedProducts.length === 0) {
      return {
        summary: {
          totalUnits: 0,
          totalCostASF: 0,
          expectedProfit: 0,
          remainingBudget: globalBudget,
          monthlyROI: 0,
        },
        suppliers: [],
      };
    }
    
    // ============================================
    // STEP 2-3: Group by supplier and build bundles
    // ============================================
    
    const productsBySupplier = {};
    
    processedProducts.forEach(function(product) {
      const key = product.supplierKey;
      if (!productsBySupplier[key]) {
        productsBySupplier[key] = [];
      }
      productsBySupplier[key].push(product);
    });
    
    const allBundles = [];
    const supplierBudget = Math.min(globalBudget, 5000); // Per-supplier cap
    
    Object.keys(productsBySupplier).forEach(function(supplierKey) {
      const supplierProducts = productsBySupplier[supplierKey];
      const supplierInfo = supplierProducts[0].supplierInfo;
      const churnConfig = supplierProducts[0].churnConfig;
      const moq = getSupplierMOQ(supplierKey, supplierMap);
      
      // Build bundles for this supplier
      const bundles = buildSupplierBundles(
        supplierProducts,
        supplierInfo,
        freightCurves || [],
        freightConfig || {},
        churnConfig,
        supplierBudget,
        moq
      );
      
      allBundles.push(...bundles);
    });
    
    // ============================================
    // STEP 4-5: Global optimization
    // ============================================
    
    const optimalAllocation = optimizeGlobalBudget(allBundles, globalBudget);
    
    // ============================================
    // STEP 6: Format output
    // ============================================
    
    // Group selected bundles by supplier and aggregate freight
    const suppliersOutput = {};
    
    optimalAllocation.bundles.forEach(function(bundle) {
      const key = bundle.supplierKey;
      if (!suppliersOutput[key]) {
        suppliersOutput[key] = {
          supplierKey: key,
          supplierName: bundle.supplierName,
          freight: {
            freightCost: 0,
            currencyFee: 0,
            shippingAndFees: 0,
            totalWeightKG: 0,
            totalCBM: 0,
            totalBoxes: 0,
            pallets: 0,
            palletHeight: 0,
            palletL: 0,
            palletW: 0,
            caseL: 0,
            caseW: 0,
            caseH: 0,
            exampleCaseSize: 0,
          },
          products: [],
        };
      }
      
      // Aggregate freight costs
      suppliersOutput[key].freight.freightCost += bundle.freightCost || 0;
      suppliersOutput[key].freight.currencyFee += bundle.currencyFee || 0;
      suppliersOutput[key].freight.shippingAndFees = 
        suppliersOutput[key].freight.freightCost + suppliersOutput[key].freight.currencyFee;
      
      // Add products
      suppliersOutput[key].products.push(...bundle.products);
    });
    
    // Convert to array and compute supplier summaries
    const suppliersArray = Object.values(suppliersOutput);
    
    // Compute supplier summaries (roi, monthlyROI, etc.)
    suppliersArray.forEach(function(supplier) {
      const products = supplier.products || [];
      if (products.length === 0) {
        supplier.summary = {
          costBSF: 0,
          costASF: 0,
          expectedProfit: 0,
          roi: 0,
          churnWeeks: 0,
          monthlyROI: 0,
        };
        return;
      }
      
      const costBSF = products.reduce(function(sum, p) {
        return sum + ((p.supplierPrice || 0) * (p.unitsToOrder || 0));
      }, 0);
      
      const costASF = supplier.freight && supplier.freight.shippingAndFees
        ? costBSF + supplier.freight.shippingAndFees
        : costBSF;
      
      const expectedProfit = products.reduce(function(sum, p) {
        return sum + (p.totalProfit || 0);
      }, 0);
      
      const roiSupplier = costASF > 0 ? expectedProfit / costASF : 0;
      
      // Weighted churn
      let churnWeeks = 0;
      if (products.length === 1) {
        churnWeeks = products[0].churnWeeks || 0;
      } else if (costBSF > 0) {
        const churnNumer = products.reduce(function(sum, p) {
          const costBSF = (p.supplierPrice || 0) * (p.unitsToOrder || 0);
          return sum + (p.churnWeeks || 0) * costBSF;
        }, 0);
        churnWeeks = churnNumer / costBSF;
      }
      
      const monthlyROI = churnWeeks > 0 ? (roiSupplier / churnWeeks) * 4.33 : 0;
      
      supplier.summary = {
        costBSF: round(costBSF, 2),
        costASF: round(costASF, 2),
        expectedProfit: round(expectedProfit, 2),
        roi: round(roiSupplier, 4),
        churnWeeks: round(churnWeeks, 2),
        monthlyROI: round(monthlyROI, 4),
      };
    });
    
    // Compute summary
    const totalUnits = optimalAllocation.bundles.reduce(function(sum, bundle) {
      return sum + bundle.products.reduce(function(s, p) {
        return s + (p.unitsToOrder || 0);
      }, 0);
    }, 0);
    
    // Compute global ROI and weighted churn from all products
    let totalCostBSF = 0;
    let totalChurnNumer = 0;
    
    optimalAllocation.bundles.forEach(function(bundle) {
      bundle.products.forEach(function(product) {
        const costBSF = (product.supplierPrice || 0) * (product.unitsToOrder || 0);
        totalCostBSF += costBSF;
        totalChurnNumer += (product.churnWeeks || 0) * costBSF;
      });
    });
    
    const weightedChurnWeeks = totalCostBSF > 0 ? totalChurnNumer / totalCostBSF : 0;
    const roi = optimalAllocation.totalCostASF > 0 
      ? optimalAllocation.totalProfit / optimalAllocation.totalCostASF 
      : 0;
    
    // Compute supplier summaries
    suppliersArray.forEach(function(supplier) {
      const products = supplier.products || [];
      if (products.length === 0) {
        supplier.summary = {
          costBSF: 0,
          costASF: 0,
          expectedProfit: 0,
          roi: 0,
          churnWeeks: 0,
          monthlyROI: 0,
        };
        return;
      }
      
      const costBSF = products.reduce(function(sum, p) {
        return sum + ((p.supplierPrice || 0) * (p.unitsToOrder || 0));
      }, 0);
      
      const costASF = supplier.freight && supplier.freight.shippingAndFees
        ? costBSF + supplier.freight.shippingAndFees
        : costBSF;
      
      const expectedProfit = products.reduce(function(sum, p) {
        return sum + (p.expectedProfit || 0);
      }, 0);
      
      const roiSupplier = costASF > 0 ? expectedProfit / costASF : 0;
      
      // Weighted churn
      let churnWeeks = 0;
      if (products.length === 1) {
        churnWeeks = products[0].churnWeeks || 0;
      } else if (costBSF > 0) {
        const churnNumer = products.reduce(function(sum, p) {
          const costBSF = (p.supplierPrice || 0) * (p.unitsToOrder || 0);
          return sum + (p.churnWeeks || 0) * costBSF;
        }, 0);
        churnWeeks = churnNumer / costBSF;
      }
      
      const monthlyROI = churnWeeks > 0 ? (roiSupplier / churnWeeks) * 4.33 : 0;
      
      supplier.summary = {
        costBSF: round(costBSF, 2),
        costASF: round(costASF, 2),
        expectedProfit: round(expectedProfit, 2),
        roi: round(roiSupplier, 4),
        churnWeeks: round(churnWeeks, 2),
        monthlyROI: round(monthlyROI, 4),
      };
    });
    
    return {
      engineVersion: ENGINE_VERSION,
      summary: {
        totalUnits: totalUnits,
        totalCostASF: optimalAllocation.totalCostASF,
        expectedProfit: optimalAllocation.totalProfit,
        remainingBudget: optimalAllocation.remainingBudget,
        roi: round(roi, 4), // Decimal ROI
        weightedChurnWeeks: round(weightedChurnWeeks, 2),
        monthlyROI: optimalAllocation.monthlyROI, // Already decimal
      },
      suppliers: suppliersArray,
    };
    
  } catch (error) {
    throw new Error('WS Plan v3 generation failed: ' + error.message);
  }
}

module.exports = {
  generateWSPlanV3,
  ENGINE_VERSION,
};
