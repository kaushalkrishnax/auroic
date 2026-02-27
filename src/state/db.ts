/**
 * SQLite-backed state management.
 * Tracks which messages have been processed to prevent duplicate replies.
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import config from "../config/index.js";
import logger from "../utils/logger.js";

let _db: Database.Database | null = null;

export function initDB(): Database.Database {
  if (_db) return _db;

  const dir = path.dirname(config.db.path);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _db = new Database(config.db.path);
  _db.pragma("journal_mode = WAL");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      timestamp       INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pm_conversation
      ON processed_messages (conversation_id);
  `);

  logger.info("SQLite database initialised", { path: config.db.path });
  return _db;
}

export function isProcessed(messageId: string): boolean {
  const db = initDB();
  const row = db
    .prepare("SELECT 1 FROM processed_messages WHERE id = ?")
    .get(messageId);
  return !!row;
}

export function markProcessed(messageId: string, conversationId: string): void {
  const db = initDB();
  db.prepare(
    "INSERT OR IGNORE INTO processed_messages (id, conversation_id, timestamp) VALUES (?, ?, ?)",
  ).run(messageId, conversationId, Date.now());
}

export function pruneOldRecords(): void {
  const db = initDB();
  const threshold = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const result = db
    .prepare("DELETE FROM processed_messages WHERE timestamp < ?")
    .run(threshold);
  if (result.changes > 0) {
    logger.debug(`Pruned ${result.changes} old processed_messages records`);
  }
}

export function closeDB(): void {
  if (_db) {
    _db.close();
    _db = null;
    logger.info("SQLite database closed");
  }
}
