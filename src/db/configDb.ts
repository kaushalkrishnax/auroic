import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./configSchema.js";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import logger from "@/utils/logger.js";

export type ConfigDrizzleDB = BetterSQLite3Database<typeof schema>;

type SQLiteQueryResult = { all(): unknown[] };

type SQLiteConnection = {
  exec(sql: string): unknown;
  close(): void;
  query?: (sql: string) => SQLiteQueryResult;
  prepare?: (sql: string) => SQLiteQueryResult;
};

const require = createRequire(import.meta.url);
const isBunRuntime =
  typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

let _db: ConfigDrizzleDB | null = null;
let _sqlite: SQLiteConnection | null = null;

const TABLE_BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY,
  triggers TEXT,
  llm TEXT,
  router TEXT,
  debug TEXT,
  instagram TEXT,
  discord TEXT,
  commands TEXT,
  tts TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS commands (
  command TEXT PRIMARY KEY,
  aliases TEXT,
  filter_keywords TEXT,
  handler_name TEXT,
  is_enabled INTEGER,
  updated_at TEXT
);

-- Enforce global alias uniqueness: an alias may not appear in more than one command row
CREATE TRIGGER IF NOT EXISTS enforce_unique_aliases_insert
BEFORE INSERT ON commands
FOR EACH ROW
WHEN NEW.aliases IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'duplicate alias: alias already assigned to another command')
  WHERE EXISTS (
    SELECT 1
    FROM commands c, json_each(c.aliases) ja
    WHERE ja.value IN (SELECT value FROM json_each(NEW.aliases))
  );
END;

CREATE TRIGGER IF NOT EXISTS enforce_unique_aliases_update
BEFORE UPDATE OF aliases ON commands
FOR EACH ROW
WHEN NEW.aliases IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'duplicate alias: alias already assigned to another command')
  WHERE EXISTS (
    SELECT 1
    FROM commands c, json_each(c.aliases) ja
    WHERE c.command <> NEW.command
    AND ja.value IN (SELECT value FROM json_each(NEW.aliases))
  );
END;
`;

function ensureSettingsColumns(sqlite: SQLiteConnection): void {
  const pragmaQuery = sqlite.query?.("PRAGMA table_info(settings)");
  const pragmaStmt = sqlite.prepare?.("PRAGMA table_info(settings)");
  const columns = (pragmaQuery?.all() ?? pragmaStmt?.all() ?? []) as Array<{
    name: string;
  }>;
  const columnSet = new Set(columns.map((col) => String(col.name)));

  if (!columnSet.has("tts")) {
    sqlite.exec("ALTER TABLE settings ADD COLUMN tts TEXT");
  }
  if (!columnSet.has("discord")) {
    sqlite.exec("ALTER TABLE settings ADD COLUMN discord TEXT");
  }
}

export function initConfigDB(dbPath: string): ConfigDrizzleDB {
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
  _sqlite.exec(TABLE_BOOTSTRAP_SQL);
  ensureSettingsColumns(_sqlite);

  if (isBunRuntime) {
    const { drizzle } = require("drizzle-orm/bun-sqlite") as {
      drizzle: (
        sqlite: SQLiteConnection,
        options: { schema: typeof schema },
      ) => ConfigDrizzleDB;
    };
    _db = drizzle(_sqlite, { schema });
  } else {
    const { drizzle } = require("drizzle-orm/better-sqlite3") as {
      drizzle: (
        sqlite: SQLiteConnection,
        options: { schema: typeof schema },
      ) => ConfigDrizzleDB;
    };
    _db = drizzle(_sqlite, { schema });
  }

  logger.info("Config database initialised (Drizzle + SQLite)", {
    path: dbPath,
  });
  return _db;
}

export function getConfigDB(): ConfigDrizzleDB {
  if (!_db) {
    throw new Error(
      "Config database not initialised — call initConfigDB() first",
    );
  }
  return _db;
}

export function closeConfigDB(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
    logger.info("Config database closed");
  }
}
