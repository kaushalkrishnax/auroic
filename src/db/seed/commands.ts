import { COMMAND_REGISTRY } from "@/command/commandRegistry.js";
import { generateTextEmbedding } from "@/command/embeddings.js";
import {
  getEnabledCommandRows,
  insertCommand,
  updateCommand,
} from "@/db/queries/commands.js";

/**
 * Seed commands.json with predefined commands from the registry.
 *
 * Each row is a command/example pair with its pre-computed embedding vector.
 */
export async function seedCommands(): Promise<void> {
  let embeddingAvailable = true;

  console.log("[Seed] Seeding commands...");

  for (const cmdDef of COMMAND_REGISTRY) {
    const exampleText = cmdDef.exampleText.trim();
    let embedding: number[] = [];

    if (embeddingAvailable) {
      try {
        embedding = await generateTextEmbedding(exampleText);
      } catch (err) {
        embeddingAvailable = false;
        console.warn(
          `[Seed] Embedding model unavailable; storing empty vectors for this run. Error: ${(err as Error).message}`,
        );
      }
    }

    const rows = getEnabledCommandRows();
    const existing = rows.find(
      (r) => r.command === cmdDef.name && r.text === exampleText,
    );

    if (existing) {
      updateCommand(existing.id, { embedding: JSON.stringify(embedding) });
      console.log(`[Seed] Updated command example: ${cmdDef.name}`);
    } else {
      insertCommand({
        command: cmdDef.name,
        text: exampleText,
        embedding: JSON.stringify(embedding),
      });
      console.log(`[Seed] Inserted command example: ${cmdDef.name}`);
    }
  }

  console.log(`[Seed] Completed seeding ${COMMAND_REGISTRY.length} commands`);
}

/**
 * Check if commands.json is empty or needs seeding.
 */
export function shouldSeedCommands(): boolean {
  return getEnabledCommandRows().length < COMMAND_REGISTRY.length;
}
