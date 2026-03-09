/**
 * Drizzle client — singleton lifecycle.
 * Call initDB() once at startup, then use getDB() everywhere.
 *
 * Schema is managed via drizzle-kit migrations (npm run db:generate).
 * Run `npm run db:migrate` to apply pending migrations manually,
 * or let initDB() apply them automatically at startup.
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";
import fs from "fs";
import path from "path";
import logger from "@/utils/logger.js";

export type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>;

let _db: DrizzleDB | null = null;
let _sqlite: InstanceType<typeof Database> | null = null;

// Lifecycle

export function initDB(dbPath: string): DrizzleDB {
  if (_db) return _db;

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _sqlite = new Database(dbPath);
  _sqlite.pragma("journal_mode = WAL");
  _sqlite.pragma("foreign_keys = ON");

  _db = drizzle(_sqlite, { schema });

  migrate(_db, { migrationsFolder: "./drizzle" });

  logger.info("Database initialised (Drizzle + SQLite)", { path: dbPath });
  return _db;
}

export function getDB(): DrizzleDB {
  if (!_db) throw new Error("Database not initialised — call initDB() first");
  return _db;
}

export function closeDB(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
    logger.info("Database closed");
  }
}
