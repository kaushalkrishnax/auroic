export type ResponseSegment =
  | { type: "text"; value: string }
  | { type: "sticker"; intent: string }
  | { type: "gif"; intent: string }
  | { type: "voice"; text: string }
  | { type: "music"; title: string };

export interface ParsedResponse {
  segments: ResponseSegment[];
  errors: string[];
}

const TOKEN_PATTERN = /\[(sticker|gif|voice|music)\s*[:=]\s*([\s\S]*?)\]/gi;

function pushText(segments: ResponseSegment[], value: string): void {
  if (!value) return;
  const previous = segments[segments.length - 1];
  if (previous?.type === "text") previous.value += value;
  else segments.push({ type: "text", value });
}

export function parseResponse(raw: string): ParsedResponse {
  const segments: ResponseSegment[] = [];
  const errors: string[] = [];
  const input = String(raw ?? "");
  let cursor = 0;

  for (const match of input.matchAll(TOKEN_PATTERN)) {
    const index = match.index ?? 0;
    const token = match[1]?.toLowerCase();
    const value = (match[2] ?? "").trim();
    pushText(segments, input.slice(cursor, index));

    if (!value) {
      errors.push("Empty " + token + " segment at offset " + index);
    } else if (token === "sticker" || token === "gif") {
      segments.push({ type: token, intent: value });
    } else if (token === "voice") {
      segments.push({ type: "voice", text: value });
    } else if (token === "music") {
      segments.push({ type: "music", title: value });
    }
    cursor = index + match[0].length;
  }

  pushText(segments, input.slice(cursor));
  return {
    segments: segments.filter((segment) => segment.type !== "text" || segment.value.trim().length > 0),
    errors,
  };
}

export function hasDeliverableSegments(parsed: ParsedResponse): boolean {
  return parsed.segments.length > 0 && parsed.errors.length === 0;
}
