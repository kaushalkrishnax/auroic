/**
 * Lightweight token estimator.
 * ~4 characters per token heuristic. No external dependencies.
 */

const CHARS_PER_TOKEN = 4;
const PER_MESSAGE_OVERHEAD = 4;

export interface ChatMessage {
  role: string;
  content: string;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content) + PER_MESSAGE_OVERHEAD;
  }
  total += 3; // reply priming overhead
  return total;
}
