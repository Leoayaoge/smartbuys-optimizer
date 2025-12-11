/**
 * SmartBuys Wholesale Buy Plan Engine v3
 * ======================================
 * 
 * Unified, modular, deterministic optimization engine
 * Moves all heavy calculation from Apps Script to Node.js backend
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
 *   summary: { totalUnits, totalCostASF, expectedProfit, remainingBudget, monthlyROI },
 *   suppliers: Array<{ supplierKey, supplierName, freight, products: [...] }>
 * }
 */

const { cleanNumber, normalizeSupplierKey } = require('../utils/maths');
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
    
    // Convert to array
    const suppliersArray = Object.values(suppliersOutput);
    
    // Compute summary
    const totalUnits = optimalAllocation.bundles.reduce(function(sum, bundle) {
      return sum + bundle.products.reduce(function(s, p) {
        return s + (p.unitsToOrder || 0);
      }, 0);
    }, 0);
    
    return {
      summary: {
        totalUnits: totalUnits,
        totalCostASF: optimalAllocation.totalCostASF,
        expectedProfit: optimalAllocation.totalProfit,
        remainingBudget: optimalAllocation.remainingBudget,
        monthlyROI: optimalAllocation.monthlyROI,
      },
      suppliers: suppliersArray,
    };
    
  } catch (error) {
    throw new Error('WS Plan v3 generation failed: ' + error.message);
  }
}

module.exports = {
  generateWSPlanV3,
};
