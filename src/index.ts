import { AuroicCore } from "@/core/index.js";
import logger from "@/utils/logger.js";

async function main() {
  const core = new AuroicCore();
  await core.start();
}

main().catch((err: unknown) => {
  logger.error("Application startup failed", { error: (err as Error).message });
  process.exit(1);
});
