import { pool } from "./pool.js";
import {
  PORE_CLOGGING_LIST,
  FUNGAL_ACNE_INGREDIENTS,
  FUNGAL_ACNE_SAFE_INGREDIENTS,
  KEYWORD_RISK_RULES,
} from "./seed-data.js";

function titleCase(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

const normalize = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();

function buildIngredientMap() {
  const map = new Map();

  for (const raw of PORE_CLOGGING_LIST) {
    const key = normalize(raw);
    const existing = map.get(key) || { name: raw, sources: [] };
    existing.poreClogging = true;
    existing.sources.push("Pore-Clogging Ingredient List");
    map.set(key, existing);
  }

  for (const { name, risk } of FUNGAL_ACNE_INGREDIENTS) {
    const key = normalize(name);
    const existing = map.get(key) || { name, sources: [] };
    existing.fungalAcneRisk = risk;
    existing.sources.push("Fungal Acne Trigger Reference Table");
    map.set(key, existing);
  }

  // Confirmed-safe ingredients with a none/low comedogenic grade. Doesn't
  // touch poreClogging/fungalAcneRisk — those only ever record a flagged
  // risk, so an entry here just adds the numeric grade and category note
  // without overriding a true flag this ingredient may already carry from
  // the lists above (e.g. Mineral Oil is on PORE_CLOGGING_LIST too).
  for (const { name, category, comedogenicRisk, aliases } of FUNGAL_ACNE_SAFE_INGREDIENTS) {
    const key = normalize(name);
    const existing = map.get(key) || { name, sources: [] };
    existing.comedogenicRating = comedogenicRisk === "low" ? 1 : 0;
    existing.notes = `Category: ${category}`;
    existing.sources.push("Fungal-Acne-Safe / Low-Comedogenicity Reference Table");
    if (aliases?.length) {
      existing.aliases = [...new Set([...(existing.aliases || []), ...aliases])];
    }
    map.set(key, existing);
  }

  return map;
}

async function seed() {
  const map = buildIngredientMap();
  let count = 0;

  for (const { name, aliases, poreClogging, fungalAcneRisk, comedogenicRating, notes, sources } of map.values()) {
    await pool.query(
      `insert into ingredients (inci_name, aliases, comedogenic_rating, pore_clogging, fungal_acne_risk, source, notes)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (lower(inci_name)) do update
         set aliases = excluded.aliases,
             comedogenic_rating = coalesce(excluded.comedogenic_rating, ingredients.comedogenic_rating),
             pore_clogging = coalesce(excluded.pore_clogging, ingredients.pore_clogging),
             fungal_acne_risk = coalesce(excluded.fungal_acne_risk, ingredients.fungal_acne_risk),
             source = excluded.source,
             notes = coalesce(excluded.notes, ingredients.notes),
             updated_at = now()`,
      [
        titleCase(name),
        [...new Set([name, ...(aliases || [])])],
        comedogenicRating ?? null,
        poreClogging ?? null,
        fungalAcneRisk ?? null,
        [...new Set(sources)].join("; "),
        notes ?? null,
      ]
    );
    count += 1;
  }
  console.log(`Seeded/updated ${count} ingredients.`);

  let ruleCount = 0;
  for (const { keyword, risk, notes } of KEYWORD_RISK_RULES) {
    await pool.query(
      `insert into keyword_risk_rules (keyword, fungal_acne_risk, notes)
       values ($1, $2, $3)
       on conflict (keyword) do update
         set fungal_acne_risk = excluded.fungal_acne_risk,
             notes = excluded.notes`,
      [keyword, risk, notes ?? null]
    );
    ruleCount += 1;
  }
  console.log(`Seeded/updated ${ruleCount} keyword risk rules.`);

  await pool.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
