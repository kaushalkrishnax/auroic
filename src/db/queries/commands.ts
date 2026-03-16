import { readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMMANDS_FILE = resolve(__dirname, "../../command/commands.json");

export interface CommandRow {
  id: number;
  command: string;
  text: string;
  embedding: string;
  createdAt: string | null;
}

export type InsertCommandRow = Omit<CommandRow, "id" | "createdAt">;

function readCommands(): CommandRow[] {
  const raw = readFileSync(COMMANDS_FILE, "utf-8");
  return JSON.parse(raw) as CommandRow[];
}

function writeCommands(rows: CommandRow[]): void {
  writeFileSync(COMMANDS_FILE, JSON.stringify(rows, null, 2));
}

export function getEnabledCommandRows(): CommandRow[] {
  return readCommands();
}

export function getAllCommands(): CommandRow[] {
  return readCommands().sort((a, b) => {
    if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) {
      return b.createdAt.localeCompare(a.createdAt);
    }
    return b.id - a.id;
  });
}

export function getCommandById(id: number): CommandRow | null {
  return readCommands().find((r) => r.id === id) ?? null;
}

export function insertCommand(row: InsertCommandRow): number | null {
  const rows = readCommands();
  const newId = rows.length > 0 ? Math.max(...rows.map((r) => r.id)) + 1 : 1;
  rows.push({
    ...row,
    id: newId,
    createdAt: new Date().toISOString(),
  });
  writeCommands(rows);
  return newId;
}

export function updateCommand(
  id: number,
  updates: Partial<InsertCommandRow>,
): number {
  const rows = readCommands();
  const idx = rows.findIndex((r) => r.id === id);
  if (idx === -1) return 0;
  rows[idx] = { ...rows[idx], ...updates };
  writeCommands(rows);
  return 1;
}

export function deleteCommand(id: number): number {
  const rows = readCommands();
  const next = rows.filter((r) => r.id !== id);
  if (next.length === rows.length) return 0;
  writeCommands(next);
  return 1;
}
