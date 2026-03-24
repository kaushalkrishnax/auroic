/**
 * Action dispatcher — maps RouterDecision types to handler modules.
 * Contains no action logic itself.
 */

import logger from "@/utils/logger.js";
import type { ActionContext, ActionType } from "@/types/index.js";
import { executeIgnore } from "@/router/actions/ignore.js";
import { executeReact } from "@/router/actions/react.js";
import { executeText } from "@/router/actions/text.js";
import { executeMedia } from "@/router/actions/media.js";
import { executeCommand } from "@/command/command.js";
import { navigateToChat } from "@/automation/navigation.js";
import { initInstagramSession } from "@/automation/session.js";
import { runWithAutomationLock } from "@/automation/executionLock.js";

type ActionHandler = (context: ActionContext) => Promise<string | null>;

const ACTION_HANDLERS: Partial<Record<ActionType, ActionHandler>> = {
  react: executeReact,
  text: executeText,
  media: executeMedia,
};

async function prepareActionExecution(chatId: string): Promise<void> {
  await initInstagramSession();
  await navigateToChat(chatId);
}

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

  return runWithAutomationLock("execute-action", context.chatId, async () => {
    await prepareActionExecution(context.chatId);

    if (classifiedCommand) {
      logger.info("Executing classified command", {
        commandName: classifiedCommand.commandName,
        actionType: classifiedCommand.actionType,
      });

      try {
        await executeCommand(context);
        logger.info("Command execution complete", {
          commandName: classifiedCommand.commandName,
        });
        return `[Command: ${classifiedCommand.commandName}]`;
      } catch (err) {
        logger.error("Command execution failed", {
          commandName: classifiedCommand.commandName,
          error: (err as Error).message,
        });
        throw err;
      }
    }

    const handler = ACTION_HANDLERS[decision.type];
    if (!handler) {
      logger.warn(`Unknown action type: ${decision.type}`);
      return null;
    }

    return handler(context);
  });
}
