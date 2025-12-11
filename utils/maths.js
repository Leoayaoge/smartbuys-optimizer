/**
 * Math utilities for WS Plan v3
 * Pure functions for numeric operations
 */

/**
 * Clean numeric value from string/number input
 * Handles currency symbols, percentages, commas
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
  const cleaned = str
    .replace(/[£$€,]/g, '')
    .replace(/%/g, '');
  
  const num = Number(cleaned);
  if (isNaN(num)) return NaN;
  
  // If percentage and > 1, assume it's already a percentage (e.g., 50 = 50%)
  // Otherwise, if it was marked as %, divide by 100
  if (hasPercent && num > 1) {
    return num / 100;
  }
  
  return num;
}

/**
 * Normalize string for comparison (lowercase, trim)
 */
function normalize(str) {
  return String(str || '').toLowerCase().trim();
}

/**
 * Normalize supplier key (lowercase, remove special chars)
 */
function normalizeSupplierKey(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Round to specified decimal places
 */
function round(value, decimals = 2) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/**
 * Clamp value between min and max
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Safe division (returns 0 if denominator is 0 or NaN)
 */
function safeDivide(numerator, denominator) {
  if (!denominator || isNaN(denominator) || isNaN(numerator)) {
    return 0;
  }
  return numerator / denominator;
}

module.exports = {
  cleanNumber,
  normalize,
  normalizeSupplierKey,
  round,
  clamp,
  safeDivide,
};
