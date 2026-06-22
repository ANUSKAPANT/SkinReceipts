import express from "express";
import cors from "cors";
import "dotenv/config";

import { pool } from "./db/pool.js";
import ingredientsRouter from "./routes/ingredients.js";
import checkRouter from "./routes/check.js";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", async (_req, res) => {
  try {
    await pool.query("select 1");
    res.json({ ok: true, db: "connected" });
  } catch (err) {
    res.status(503).json({ ok: false, db: "unreachable", error: err.message });
  }
});

app.use("/api/ingredients", ingredientsRouter);
app.use("/api/check", checkRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

export default app;
