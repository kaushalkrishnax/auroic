import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

// We'll store the old runtime.json values in a single row (id=1)
// as top-level JSON blobs to keep queries simple but structured
export const settingsTable = sqliteTable("settings", {
  id: integer("id").primaryKey(), // 1 for singleton
  triggers: text("triggers", { mode: "json" }),
  llm: text("llm", { mode: "json" }),
  router: text("router", { mode: "json" }),
  debug: text("debug", { mode: "json" }),
  instagram: text("instagram", { mode: "json" }),
  commands: text("commands", { mode: "json" }),
  updatedAt: text("updated_at"),
});

export const commandsTable = sqliteTable("commands", {
  command: text("command").primaryKey(),
  aliases: text("aliases", { mode: "json" }), // array of strings
  filterKeywords: text("filter_keywords", { mode: "json" }), // array of strings
  handlerName: text("handler_name"),
  isEnabled: integer("is_enabled", { mode: "boolean" }), // boolean
  updatedAt: text("updated_at"),
});

export type SettingsRows = typeof settingsTable.$inferSelect;
export type InsertSettingsRows = typeof settingsTable.$inferInsert;

export type CommandRow = typeof commandsTable.$inferSelect;
export type InsertCommandRow = typeof commandsTable.$inferInsert;
