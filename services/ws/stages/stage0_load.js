/**
 * Stage 0 – Load Data
 * -------------------
 * Load suppliers, products, and freight config into state.data.
 * Attach inputs. Do not perform any heavy calculations here.
 */

const { normalizeSupplierKey } = require("../../../utils/maths");

module.exports = function stage0_load(state) {
  const inputs = state.inputs || {};

  const suppliers = Array.isArray(inputs.suppliers) ? inputs.suppliers : [];
  const products = Array.isArray(inputs.products) ? inputs.products : [];
  const freightConfig = inputs.freightConfig || {};

  const supplierCount = suppliers.length;
  const productCount = products.length;

  const nextState = {
    ...state,
    inputs: {
      ...state.inputs,
      ...inputs,
    },
    data: {
      suppliers: suppliers.map((s) => ({
        ...s,
        supplierKey: normalizeSupplierKey(s.name || s.supplierName || ""),
      })),
      products: products.slice(),
      freightConfig: { ...freightConfig },
    },
  };

  nextState.stage0 = {
    suppliersLoaded: supplierCount,
    productsLoaded: productCount,
    hasFreightConfig: Object.keys(freightConfig || {}).length > 0,
  };

  console.log(
    `[WS v3.3][Stage 0] Loaded ${supplierCount} suppliers, ${productCount} products. Freight config keys=${Object.keys(
      freightConfig || {}
    ).length}`
  );

  return nextState;
};


