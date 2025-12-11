/**
 * Supplier utilities for WS Plan v3
 * Handles supplier info lookup and normalization
 */

const { normalizeSupplierKey } = require('./maths');

/**
 * Build supplier lookup map from supplier array
 * @param {Array} suppliers - Array of supplier objects
 * @returns {Object} Map of supplierKey -> supplier info
 */
function buildSupplierMap(suppliers) {
  if (!Array.isArray(suppliers)) {
    return {};
  }
  
  const map = {};
  
  suppliers.forEach(function(supplier) {
    if (!supplier || !supplier.name) return;
    
    const key = normalizeSupplierKey(supplier.name);
    if (!key) return;
    
    map[key] = {
      name: supplier.name,
      warehouse: supplier.warehouse || '',
      country: supplier.country || '',
      freightMode: supplier.freightMode || '',
      packagingType: supplier.packagingType || '',
      packagingWeightPercent: supplier.packagingWeightPercent || 0,
      moqGBP: supplier.moqGBP || 0,
      isUK: (supplier.country || '').toLowerCase().includes('uk'),
    };
  });
  
  return map;
}

/**
 * Get supplier info by key
 * @param {string} supplierKey - Normalized supplier key
 * @param {Object} supplierMap - Supplier lookup map
 * @returns {Object|null} Supplier info or null
 */
function getSupplierInfo(supplierKey, supplierMap) {
  if (!supplierKey || !supplierMap) {
    return null;
  }
  
  const key = normalizeSupplierKey(supplierKey);
  return supplierMap[key] || null;
}

/**
 * Check if supplier is UK-based
 * @param {string} supplierKey - Normalized supplier key
 * @param {Object} supplierMap - Supplier lookup map
 * @returns {boolean} True if UK supplier
 */
function isUKSupplier(supplierKey, supplierMap) {
  const info = getSupplierInfo(supplierKey, supplierMap);
  return info ? info.isUK : false;
}

/**
 * Get supplier MOQ (Minimum Order Quantity in GBP)
 * @param {string} supplierKey - Normalized supplier key
 * @param {Object} supplierMap - Supplier lookup map
 * @returns {number} MOQ in GBP (default: 0)
 */
function getSupplierMOQ(supplierKey, supplierMap) {
  const info = getSupplierInfo(supplierKey, supplierMap);
  return info && info.moqGBP > 0 ? info.moqGBP : 0;
}

module.exports = {
  buildSupplierMap,
  getSupplierInfo,
  isUKSupplier,
  getSupplierMOQ,
};
