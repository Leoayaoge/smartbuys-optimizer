const express = require("express");
const app = express();

// Middleware
app.use(express.json({ limit: "10mb" }));

// Routes
const wsPlanRoutes = require("./routes/wsPlanRoutes");
const oaPlanRoutes = require("./routes/oaPlanRoutes");

// Home route
app.get("/", (req, res) => {
  res.send("SmartBuys Optimizer Backend is running.");
});

// Mount WS and OA routes
app.use("/", wsPlanRoutes);
app.use("/", oaPlanRoutes);

// Legacy test route
app.post("/allocate", (req, res) => {
  const budget = req.body.budget;
  res.json({
    message: "Optimizer received data.",
    budgetReceived: budget,
  });
});

// Simple test endpoint
app.get("/test", (req, res) => res.send("Test route works!"));

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SmartBuys Optimizer running on port ${PORT}`);
});
