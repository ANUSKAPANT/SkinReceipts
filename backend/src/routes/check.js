import { Router } from "express";
import { pool } from "../db/pool.js";

const router = Router();

const RISK_RANK = { low: 1, medium: 2, high: 3 };

const normalize = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();

// Minimum trigram similarity (0-1) for an unmatched token to be accepted as a
// fuzzy match. 0.4 corrects OCR misreads ("Dimeticone" → "Dimethicone") while
// staying well clear of false positives between genuinely different names.
const FUZZY_THRESHOLD = 0.4;

// INCI lists are comma-separated; some pasted labels use line breaks instead.
function parseIngredientList(text) {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// For tokens that didn't match exactly or by keyword, find each one's closest
// ingredient by trigram similarity against the inci_name and its aliases, in a
// single round-trip. Returns a map keyed by normalized input. The ingredients
// table is small (hundreds of rows) so the per-token seq scan is negligible.
async function fuzzyMatch(inputs) {
  if (inputs.length === 0) return new Map();
  const { rows } = await pool.query(
    `select q.input,
            m.inci_name, m.comedogenic_rating, m.pore_clogging,
            m.fungal_acne_risk, m.source, m.sim
     from unnest($1::text[]) as q(input)
     cross join lateral (
       select i.inci_name, i.comedogenic_rating, i.pore_clogging,
              i.fungal_acne_risk, i.source,
              greatest(
                similarity(lower(i.inci_name), lower(q.input)),
                coalesce(
                  (select max(similarity(lower(a), lower(q.input)))
                   from unnest(i.aliases) a),
                  0
                )
              ) as sim
       from ingredients i
       order by sim desc
       limit 1
     ) m
     where m.sim >= $2`,
    [inputs, FUZZY_THRESHOLD]
  );

  const map = new Map();
  for (const row of rows) map.set(normalize(row.input), row);
  return map;
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

    // Second pass: try to rescue still-unknown tokens with fuzzy DB matching,
    // so OCR misreads of real ingredients aren't silently dropped as unknown.
    const unknownInputs = [
      ...new Set(results.filter((r) => r.status === "unknown").map((r) => r.input)),
    ];
    const fuzzy = await fuzzyMatch(unknownInputs);

    const resolved = results.map((r) => {
      if (r.status !== "unknown") return r;
      const f = fuzzy.get(normalize(r.input));
      if (!f) return r;
      return {
        input: r.input,
        status: "fuzzy_match",
        inci_name: f.inci_name,
        comedogenic_rating: f.comedogenic_rating,
        pore_clogging: f.pore_clogging,
        fungal_acne_risk: f.fungal_acne_risk,
        source: f.source,
        similarity: Number(f.sim),
      };
    });

    const summary = resolved.reduce(
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

    res.json({ results: resolved, summary });
  } catch (err) {
    next(err);
  }
});

export default router;
