import { Router } from "express";
import { pool } from "../db/pool.js";

const router = Router();

const RISK_RANK = { low: 1, medium: 2, high: 3 };

const normalize = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();

// INCI lists are comma-separated; some pasted labels use line breaks instead.
function parseIngredientList(text) {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

router.post("/", async (req, res, next) => {
  try {
    const { text } = req.body;
    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "text is required" });
    }

    const inputs = parseIngredientList(text);
    if (inputs.length === 0) {
      return res.status(400).json({ error: "no ingredients found in text" });
    }

    const [{ rows: ingredients }, { rows: keywordRules }] = await Promise.all([
      pool.query(
        "select inci_name, aliases, comedogenic_rating, pore_clogging, fungal_acne_risk, source from ingredients"
      ),
      pool.query("select keyword, fungal_acne_risk, notes from keyword_risk_rules"),
    ]);

    const byName = new Map();
    for (const row of ingredients) {
      byName.set(normalize(row.inci_name), row);
      for (const alias of row.aliases || []) {
        byName.set(normalize(alias), row);
      }
    }

    // Check highest-risk keywords first so e.g. a "high" suffix match wins
    // over a "low" one if an ingredient name happens to match both.
    const sortedRules = [...keywordRules].sort(
      (a, b) => RISK_RANK[b.fungal_acne_risk] - RISK_RANK[a.fungal_acne_risk]
    );

    const results = inputs.map((input) => {
      const key = normalize(input);
      const match = byName.get(key);

      if (match) {
        return {
          input,
          status: "known",
          inci_name: match.inci_name,
          comedogenic_rating: match.comedogenic_rating,
          pore_clogging: match.pore_clogging,
          fungal_acne_risk: match.fungal_acne_risk,
          source: match.source,
        };
      }

      const rule = sortedRules.find((r) => key.endsWith(normalize(r.keyword)));
      if (rule) {
        return {
          input,
          status: "keyword_match",
          keyword: rule.keyword,
          fungal_acne_risk: rule.fungal_acne_risk,
          notes: rule.notes,
        };
      }

      return { input, status: "unknown" };
    });

    const summary = results.reduce(
      (acc, r) => {
        acc.total += 1;
        if (r.status === "unknown") acc.unknownCount += 1;
        if (r.pore_clogging) acc.poreCloggingCount += 1;
        if (r.fungal_acne_risk) {
          acc.fungalAcneCount += 1;
          const rank = RISK_RANK[r.fungal_acne_risk];
          const currentRank = acc.worstFungalAcneRisk ? RISK_RANK[acc.worstFungalAcneRisk] : 0;
          if (rank > currentRank) acc.worstFungalAcneRisk = r.fungal_acne_risk;
        }
        return acc;
      },
      { total: 0, unknownCount: 0, poreCloggingCount: 0, fungalAcneCount: 0, worstFungalAcneRisk: null }
    );

    res.json({ results, summary });
  } catch (err) {
    next(err);
  }
});

export default router;
