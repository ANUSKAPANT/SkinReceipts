import { Pool } from "pg";
import "dotenv/config";

if (!process.env.DATABASE_URL) {
  console.warn("DATABASE_URL is not set — DB-backed routes will fail until it's configured in .env");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
});
