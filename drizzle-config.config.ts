import "dotenv/config";
import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/configSchema.ts",
  out: "./drizzle-config",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.CONFIG_DB_PATH ?? "./data/config.db",
  },
} satisfies Config;
