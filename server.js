require("dotenv").config();
const express = require("express");
const app = express();

app.use(express.json());
app.use(express.static("public"));
app.use("/output", express.static("output"));

app.use("/generate", require("./routes/generate"));

// ── Health check (used by Render uptime monitoring) ───────────────────────────
app.get("/health", (_req, res) =>
  res.json({ status: "ok", timestamp: new Date().toISOString() })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));