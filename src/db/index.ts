/**
 * Drizzle client — singleton lifecycle.
 * Call initDB() once at startup, then use getDB() everywhere.
 *
 * Schema is managed via drizzle-kit migrations (npm run db:generate).
 * Run `npm run db:migrate` to apply pending migrations manually,
 * or let initDB() apply them automatically at startup.
 */

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import logger from "@/utils/logger.js";

export type DrizzleDB = BetterSQLite3Database<typeof schema>;

type SQLiteConnection = {
  exec(sql: string): unknown;
  close(): void;
};

const require = createRequire(import.meta.url);
const isBunRuntime =
  typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

let _db: DrizzleDB | null = null;
let _sqlite: SQLiteConnection | null = null;

// Lifecycle

export function initDB(dbPath: string): DrizzleDB {
  if (_db) return _db;

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (isBunRuntime) {
    const { Database } = require("bun:sqlite") as {
      Database: new (filename: string) => SQLiteConnection;
    };

    _sqlite = new Database(dbPath);
  } else {
    const BetterSQLite3 = require("better-sqlite3") as new (
      filename: string,
    ) => SQLiteConnection;

    _sqlite = new BetterSQLite3(dbPath);
  }

  _sqlite.exec("PRAGMA journal_mode = WAL;");
  _sqlite.exec("PRAGMA foreign_keys = ON;");

  if (isBunRuntime) {
    const { drizzle } = require("drizzle-orm/bun-sqlite") as {
      drizzle: (
        sqlite: SQLiteConnection,
        options: { schema: typeof schema },
      ) => DrizzleDB;
    };
    const { migrate } = require("drizzle-orm/bun-sqlite/migrator") as {
      migrate: (db: DrizzleDB, options: { migrationsFolder: string }) => void;
    };

    _db = drizzle(_sqlite, { schema });
    migrate(_db, { migrationsFolder: "./drizzle" });
  } else {
    const { drizzle } = require("drizzle-orm/better-sqlite3") as {
      drizzle: (
        sqlite: SQLiteConnection,
        options: { schema: typeof schema },
      ) => DrizzleDB;
    };
    const { migrate } = require("drizzle-orm/better-sqlite3/migrator") as {
      migrate: (db: DrizzleDB, options: { migrationsFolder: string }) => void;
    };

    _db = drizzle(_sqlite, { schema });
    migrate(_db, { migrationsFolder: "./drizzle" });
  }

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
