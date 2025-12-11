/**
 * Dimension utilities for WS Plan v3
 * Handles case sizes, weights, dimensions lookup
 */

const { normalize } = require('./maths');

/**
 * Find dimension record by ASIN, EAN, or title
 * @param {string} asin - Product ASIN
 * @param {string} ean - Product EAN
 * @param {string} title - Product title
 * @param {Object} dims - Dimensions lookup object with byASIN, byEAN, byTitle maps
 * @returns {Object|null} Dimension record or null
 */
function findDimensions(asin, ean, title, dims) {
  if (!dims) return null;
  
  const asinKey = asin ? String(asin).toUpperCase().trim() : '';
  const eanKey = ean ? String(ean).trim() : '';
  const titleKey = title ? normalize(title) : '';
  
  // Try ASIN first
  if (asinKey && dims.byASIN && dims.byASIN[asinKey]) {
    return dims.byASIN[asinKey];
  }
  
  // Try EAN
  if (eanKey && dims.byEAN && dims.byEAN[eanKey]) {
    return dims.byEAN[eanKey];
  }
  
  // Try title
  if (titleKey && dims.byTitle && dims.byTitle[titleKey]) {
    return dims.byTitle[titleKey];
  }
  
  return null;
}

/**
 * Get case size for a product
 * @param {string} asin - Product ASIN
 * @param {string} ean - Product EAN
 * @param {string} title - Product title
 * @param {Object} dims - Dimensions lookup object
 * @returns {number} Case size (default: 1)
 */
function getCaseSize(asin, ean, title, dims) {
  const dimRec = findDimensions(asin, ean, title, dims);
  if (dimRec && typeof dimRec.caseSize === 'number' && dimRec.caseSize > 0) {
    return Math.round(dimRec.caseSize);
  }
  return 1;
}

/**
 * Get product dimensions (length, width, height in cm)
 * @param {string} asin - Product ASIN
 * @param {string} ean - Product EAN
 * @param {string} title - Product title
 * @param {Object} dims - Dimensions lookup object
 * @returns {Object} { length, width, height } in cm, or null values
 */
function getDimensions(asin, ean, title, dims) {
  const dimRec = findDimensions(asin, ean, title, dims);
  if (!dimRec) {
    return { length: null, width: null, height: null };
  }
  
  return {
    length: typeof dimRec.length === 'number' ? dimRec.length : null,
    width: typeof dimRec.width === 'number' ? dimRec.width : null,
    height: typeof dimRec.height === 'number' ? dimRec.height : null,
  };
}

/**
 * Get product weight (in kg)
 * @param {string} asin - Product ASIN
 * @param {string} ean - Product EAN
 * @param {string} title - Product title
 * @param {Object} dims - Dimensions lookup object
 * @returns {number|null} Weight in kg or null
 */
function getWeight(asin, ean, title, dims) {
  const dimRec = findDimensions(asin, ean, title, dims);
  if (dimRec && typeof dimRec.weightKg === 'number' && dimRec.weightKg > 0) {
    return dimRec.weightKg;
  }
  return null;
}

module.exports = {
  findDimensions,
  getCaseSize,
  getDimensions,
  getWeight,
};
