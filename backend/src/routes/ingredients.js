import { Router } from "express";
import { pool } from "../db/pool.js";

const router = Router();

router.get("/", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      "select id, inci_name, aliases, comedogenic_rating, pore_clogging, fungal_acne_risk, source from ingredients order by inci_name"
    );
    res.json({ ingredients: rows });
  } catch (err) {
    next(err);
  }
});

export default router;
