# SmartBuys Wholesale Buy Plan v3 Backend

## Overview

WS Plan v3 is a complete rewrite of the wholesale buy plan optimization engine, moving all heavy computation from Google Apps Script to a Node.js backend. This eliminates runtime limits, crashes, and unpredictable behavior.

## Architecture

### Modular Service Structure

```
/backend
  /services
    freightService.js    - Freight calculation and shipping costs
    churnService.js      - Churn time computation
    roiService.js        - ROI and Monthly ROI calculation
    allocatorService.js  - Unified optimization engine
    wsPlanEngineV3.js   - Main orchestrator
  /utils
    maths.js            - Math utilities (cleanNumber, normalize, etc.)
    dims.js             - Dimension lookups (case size, weight, dimensions)
    suppliers.js        - Supplier info lookup
  /controllers
    wsPlanControllerV3.js - API handler
```

## API Endpoint

### POST `/ws-plan/allocate`

**Request Body:**
```json
{
  "budget": 10000,
  "products": [
    {
      "asin": "B001",
      "supplier": "Example Supplier",
      "supplierPrice": 4.50,
      "amazonPrice": 12.99,
      "amazonFees": 3.50,
      "vatPerUnit": 0.90,
      "monthlySales": 100,
      "sellers": 5,
      "itemName": "Product Name",
      "ean": "123456789"
    }
  ],
  "dims": {
    "byASIN": {
      "B001": {
        "caseSize": 12,
        "weightKg": 2.5,
        "length": 30,
        "width": 20,
        "height": 15
      }
    },
    "byEAN": {},
    "byTitle": {}
  },
  "suppliers": [
    {
      "name": "Example Supplier",
      "warehouse": "UK Warehouse",
      "country": "UK",
      "freightMode": "Road",
      "packagingType": "Box",
      "packagingWeightPercent": 0.05,
      "moqGBP": 500
    }
  ],
  "freightCurves": [
    {
      "freightMode": "Air",
      "useCBM": false,
      "points": [
        { "x": 0, "y": 0 },
        { "x": 100, "y": 500 },
        { "x": 500, "y": 2000 }
      ]
    }
  ],
  "freightConfig": {
    "ratePerKG": 2.5,
    "ratePerCBM": 150,
    "minCharge": 50,
    "handlingFee": 25,
    "boxSurcharge": 5,
    "palletSurcharge": 50,
    "domesticUkRatePerBox": 8
  },
  "churnSettings": {
    "examplesupplier": {
      "irstDays": 14,
      "payoutDays": 14
    }
  }
}
```

**Response:**
```json
{
  "success": true,
  "summary": {
    "totalUnits": 240,
    "totalCostASF": 9500.00,
    "expectedProfit": 2850.00,
    "remainingBudget": 500.00,
    "monthlyROI": 0.187
  },
  "suppliers": [
    {
      "supplierKey": "examplesupplier",
      "supplierName": "Example Supplier",
      "freight": {
        "freightCost": 125.50,
        "currencyFee": 0,
        "shippingAndFees": 125.50
      },
      "products": [
        {
          "asin": "B001",
          "itemName": "Product Name",
          "unitsToOrder": 24,
          "supplierPrice": 4.50,
          "landedCostPerUnit": 5.21,
          "profitPerUnit": 4.28,
          "roi": 0.821,
          "monthlyROI": 0.187,
          "churnWeeks": 18.5,
          "totalCost": 125.04,
          "totalProfit": 102.72
        }
      ]
    }
  ]
}
```

## Algorithm Flow

### Step 1: Preprocess Products
- Clean and validate product data
- Compute raw ROI (BSF)
- Get case sizes and dimensions
- Filter out zero-velocity items

### Step 2: Compute Freight-Adjusted Metrics
- For each product option:
  - Simulate shipment (weight, CBM)
  - Compute freight cost
  - Compute currency fee (0.67% for non-UK)
  - Compute landed cost per unit
  - Recompute profit and ROI (ASF)
  - Compute Monthly ROI

### Step 3: Build Case-Size Options
- For each SKU:
  - Generate options: 1 case, 2 cases, ... up to max (3 months stock)
  - Limit to top 20 options per product

### Step 4: Build Supplier Bundles
- Single-product bundles (best option per product)
- Multi-product bundles (greedy combination)
- Filter by MOQ
- Keep top 8 bundles per supplier

### Step 5: Global Optimization
- For ≤20 bundles: exhaustive search
- For >20 bundles: greedy with improvement passes
- Maximize Monthly ROI while using as much budget as possible

### Step 6: Format Output
- Group by supplier
- Compute summary metrics
- Return clean JSON

## Key Improvements Over v2

1. **Single Unified Allocator** - No competing algorithms
2. **Deterministic** - Same input = same output
3. **Modular** - Each service does one job
4. **Testable** - Pure functions, no Google dependencies
5. **Efficient** - No memory-heavy nested objects
6. **Optimized** - True knapsack optimization, not greedy-only

## Usage

The backend is ready to use. Apps Script should:
1. Collect data from sheets
2. Format as JSON payload
3. POST to `/ws-plan/allocate`
4. Write returned JSON to sheet

No heavy computation happens in Apps Script.
