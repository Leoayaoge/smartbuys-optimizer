const express = require("express");
const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("SmartBuys Optimizer Backend is running.");
});

app.post("/allocate", (req, res) => {
  const budget = req.body.budget;
  res.json({
    message: "Optimizer received data.",
    budgetReceived: budget
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SmartBuys Optimizer running on port ${PORT}`);
});
app.get("/test", (req, res) => res.send("Test route works"));
