import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./configSchema.js";
import fs from "fs";
import path from "path";
import logger from "@/utils/logger.js";

export type ConfigDrizzleDB = ReturnType<typeof drizzle<typeof schema>>;

let _db: ConfigDrizzleDB | null = null;
let _sqlite: InstanceType<typeof Database> | null = null;

const TABLE_BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY,
  triggers TEXT,
  llm TEXT,
  router TEXT,
  debug TEXT,
  instagram TEXT,
  commands TEXT,
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

export function initConfigDB(dbPath: string): ConfigDrizzleDB {
  if (_db) return _db;

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _sqlite = new Database(dbPath);
  _sqlite.pragma("journal_mode = WAL");
  _sqlite.pragma("foreign_keys = ON");
  _sqlite.exec(TABLE_BOOTSTRAP_SQL);

  _db = drizzle(_sqlite, { schema });
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
