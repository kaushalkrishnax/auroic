import getConfig from "@/runtime/index.js";
import {
  chatCompletion,
  ChatMessage,
  resolveModel as resolveLlmModel,
} from "@/llm/client.js";

const DEFAULT_BASE_URL = "http://localhost:8880";
const DEFAULT_MODEL = "tts-1";
const DEFAULT_VOICE = "hm_omega";
const TIMEOUT_MS = 5000;
const DEFAULT_LANG = "und";

const LANGUAGE_DEFAULT_VOICES: Record<string, string> = {
  en: "af_sarah",
  "en-us": "af_sarah",
  "en-gb": "bf_lily",
  es: "ef_dora",
  fr: "ff_siwis",
  hi: "hf_beta",
  ja: "jf_gongitsune",
  pt: "pf_dora",
  zh: "zf_xiaoxiao",
  "zh-cn": "zf_xiaoxiao",
};

export type TtsVoice = string;

export interface TtsOptions {
  voices?: string[];
  models?: string[];
  defaultVoice: string;
  defaultModel: string;
}

function getEndpoint(path: string): string {
  const base =
    process.env.TTS_API_URL ||
    process.env.KOKORO_TTS_API_URL ||
    DEFAULT_BASE_URL;
  return new URL(path, base).toString();
}

// Fetch and simplify payload extraction in one place
async function fetchList(path: string): Promise<string[]> {
  try {
    const res = await fetch(getEndpoint(path), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) return [];

    const { data, voices } = (await res.json()) as {
      data?: any[];
      voices?: any[];
    };
    const rawList = data || voices || [];

    const extracted = rawList
      .map((item) => (typeof item === "string" ? item : item?.id || item?.name))
      .filter(Boolean)
      .map((s) => String(s).trim());

    return [...new Set(extracted)];
  } catch {
    return [];
  }
}

export async function getTtsOptions(): Promise<TtsOptions> {
  const config = getConfig();
  const defaultVoice = config.tts?.voice?.trim() || DEFAULT_VOICE;
  const defaultModel = config.tts?.model?.trim() || DEFAULT_MODEL;

  const [voices, models] = await Promise.all([
    fetchList("/v1/audio/voices"),
    fetchList("/v1/models"),
  ]);

  // Ensure default values exist in the lists if we retrieved anything
  if (voices.length > 0 && !voices.includes(defaultVoice))
    voices.unshift(defaultVoice);
  if (models.length > 0 && !models.includes(defaultModel))
    models.unshift(defaultModel);

  return {
    defaultVoice,
    defaultModel,
    voices: voices.length ? voices : undefined,
    models: models.length ? models : undefined,
  };
}

function resolveVoiceForLanguage(lang: string): string | null {
  const normalized = lang.trim().toLowerCase();
  if (!normalized) return null;
  if (LANGUAGE_DEFAULT_VOICES[normalized])
    return LANGUAGE_DEFAULT_VOICES[normalized];
  const base = normalized.split("-")[0];
  return LANGUAGE_DEFAULT_VOICES[base] ?? null;
}

async function detectLanguageAndNormalizeText(text: string): Promise<{
  lang: string;
  text: string;
}> {
  const model = resolveLlmModel("low");

  const systemPrompt = [
    "You are a language detector and transliterator.",
    "Return exactly two lines:",
    "lang: <bcp47 language code>",
    "text: <native-script text>",
    "Rules:",
    "- If input is already in native script, keep it.",
    "- If input is Latin transliteration for a non-Latin language, convert it.",
    "- If the language uses Latin script, keep original text.",
    "- No extra words, no quotes.",
  ].join("\n");

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: text },
  ] as ChatMessage[];

  try {
    const raw = await chatCompletion(messages, model);
    const langMatch = raw.match(/lang\s*:\s*([^\n\r]+)/i);
    const textMatch = raw.match(/text\s*:\s*([\s\S]+)/i);
    const lang = langMatch?.[1]?.trim() || DEFAULT_LANG;
    const normalizedText = textMatch?.[1]?.trim() || text.trim();
    return { lang, text: normalizedText || text.trim() };
  } catch {
    return { lang: DEFAULT_LANG, text: text.trim() };
  }
}

export async function generateSpeechBuffer(
  text: string,
  voice?: TtsVoice,
): Promise<Buffer> {
  if (!text?.trim()) throw new Error("Invalid text input for TTS");

  const config = getConfig();
  const normalized = await detectLanguageAndNormalizeText(text);
  const languageVoice = resolveVoiceForLanguage(normalized.lang);
  const configuredVoice = voice?.trim() || config.tts?.voice?.trim();
  const selectedVoice =
    (configuredVoice && configuredVoice.toLowerCase() !== "auto"
      ? configuredVoice
      : languageVoice) || DEFAULT_VOICE;
  const selectedModel =
    process.env.TTS_MODEL?.trim() || config.tts?.model?.trim() || DEFAULT_MODEL;

  try {
    const res = await fetch(getEndpoint("/v1/audio/speech"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: selectedModel,
        input: normalized.text,
        voice: selectedVoice,
        speed: 1,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) throw new Error(`TTS server error: ${res.status}`);

    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw new Error(
      `TTS request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
