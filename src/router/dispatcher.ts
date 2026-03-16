/**
 * Action dispatcher — maps RouterDecision types to handler modules.
 * Contains no action logic itself.
 */

import logger from "@/utils/logger.js";
import type { ActionContext } from "@/types/index.js";
import { executeIgnore } from "@/router/actions/ignore.js";
import { executeReact } from "@/router/actions/react.js";
import { executeText } from "@/router/actions/text.js";
import { executeMedia } from "@/router/actions/media.js";
import { executeCommand } from "@/command/command.js";
import { navigateToChat } from "@/automation/navigation.js";
import { initInstagramSession, getPage } from "@/automation/session.js";

export async function executeAction(
  context: ActionContext,
): Promise<string | null> {
  const { decision, classifiedCommand } = context;
  logger.info(`Dispatching action: ${decision.type}`);

  if (decision.type === "ignore") {
    logger.info("Action is ignore — skipping processing");
    await executeIgnore(context);
    return null;
  }

  await initInstagramSession();
  await navigateToChat(context.chatId);

  // If this is a classified command, execute the command handler
  if (classifiedCommand) {
    logger.info("Executing classified command", {
      commandName: classifiedCommand.commandName,
      actionType: classifiedCommand.actionType,
    });

    const page = getPage();
    await executeCommand(classifiedCommand, page, context.chatId);

    // Command handlers don't return text, so return a placeholder
    return `[Command: ${classifiedCommand.commandName}]`;
  }

  // Otherwise, use the default action handlers
  switch (decision.type) {
    case "react":
      return await executeReact(context);

    case "text":
      return await executeText(context);

    case "media":
      return await executeMedia(context);

    default:
      logger.warn(`Unknown action type: ${decision.type}`);
      return null;
  }
}
