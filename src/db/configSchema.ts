import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

export const settingsTable = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  triggers: text("triggers", { mode: "json" }),
  llm: text("llm", { mode: "json" }),
  router: text("router", { mode: "json" }),
  debug: text("debug", { mode: "json" }),
  instagram: text("instagram", { mode: "json" }),
  commands: text("commands", { mode: "json" }),
  tts: text("tts", { mode: "json" }),

  updatedAt: text("updated_at"),
});

export const commandsTable = sqliteTable("commands", {
  command: text("command").primaryKey(),
  aliases: text("aliases", { mode: "json" }),
  filterKeywords: text("filter_keywords", { mode: "json" }),
  handlerName: text("handler_name"),
  isEnabled: integer("is_enabled", { mode: "boolean" }),
  updatedAt: text("updated_at"),
});

export type SettingsRows = typeof settingsTable.$inferSelect;
export type InsertSettingsRows = typeof settingsTable.$inferInsert;
export type CommandRow = typeof commandsTable.$inferSelect;
export type InsertCommandRow = typeof commandsTable.$inferInsert;
