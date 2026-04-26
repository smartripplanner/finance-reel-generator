require("dotenv").config();
const express = require("express");
const app = express();

app.use(express.json());
app.use(express.static("public"));
app.use("/output", express.static("output"));

app.use("/generate", require("./routes/generate"));
app.use("/admin",    require("./routes/admin"));

// ── Health check (used by Render uptime monitoring) ───────────────────────────
app.get("/health", (_req, res) => {
  const mem = process.memoryUsage();
  const mb  = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;
  res.json({
    status:    "ok",
    timestamp: new Date().toISOString(),
    uptime:    `${Math.round(process.uptime())}s`,
    memory: {
      heapUsed:  mb(mem.heapUsed),
      heapTotal: mb(mem.heapTotal),
      rss:       mb(mem.rss),
      external:  mb(mem.external),
    },
    node: process.version,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));