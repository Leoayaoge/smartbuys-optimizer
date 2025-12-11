const express = require("express");
const app = express();
app.use(express.json());

// Routes
const wsPlanRoutes = require("./routes/wsPlanRoutes");
const oaPlanRoutes = require("./routes/oaPlanRoutes");

// IMPORT WS ROUTES
const wsPlanRoutes = require("./routes/wsPlanRoutes");

// HOME ROUTE
app.get("/", (req, res) => {
  res.send("SmartBuys Optimizer Backend is running.");
});

app.post("/allocate", (req, res) => {
  const budget = req.body.budget;
  res.json({
    message: "Optimizer received data.",
    budgetReceived: budget,
  });
});

// SIMPLE TEST ROUTE
app.get("/test", (req, res) => res.send("Test route works!"));

// START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SmartBuys Optimizer running on port ${PORT}`);
});
