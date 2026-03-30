import { KokoroTTS } from "kokoro-js";
import { spawn } from "child_process";
import getConfig from "@/runtime/index.js";
import logger from "@/utils/logger.js";
import path from "path";

let tts: KokoroTTS | null = null;

const KOKORO_MODEL_ID = path.join(process.cwd(), "models", "kokoro-tts");
const SUPPORTED_DTYPES = ["q8", "fp16", "fp32"] as const;
const SUPPORTED_VOICES = [
  "af",
  "af_bella",
  "af_nicole",
  "af_sarah",
  "af_sky",
  "am_adam",
  "am_michael",
  "bf_emma",
  "bf_isabella",
  "bm_george",
  "bm_lewis",
] as const;

export type KokoroDtype = "q8" | "fp16" | "fp32";
export type KokoroVoice = string;

/**
 * Extract Kokoro's internal voice union (compile-time)
 */
type KokoroInternalVoice = Parameters<KokoroTTS["generate"]>[1] extends {
  voice?: infer V;
}
  ? Exclude<V, undefined>
  : never;

/**
 * Runtime list of valid voices (source of truth)
 */
function getValidKokoroVoices(): Set<string> {
  const voices = [
    "af",
    "af_bella",
    "af_nicole",
    "af_sarah",
    "af_sky",
    "am_adam",
    "am_michael",
    "bf_emma",
    "bf_isabella",
    "bm_george",
    "bm_lewis",
  ] as const;

  return new Set<string>(voices);
}

export interface KokoroTtsOptions {
  dtypes: KokoroDtype[];
  voices: KokoroVoice[];
  defaultDtype: KokoroDtype;
  defaultVoice: KokoroVoice;
}

function pickValueOrFallback<T extends string>(
  requested: unknown,
  available: T[],
  fallback: T,
): T {
  if (typeof requested === "string" && available.includes(requested as T)) {
    return requested as T;
  }

  if (available.includes(fallback)) return fallback;
  return available[0] ?? fallback;
}

export async function getKokoroTtsOptions(): Promise<KokoroTtsOptions> {
  const dtypes = [...SUPPORTED_DTYPES];
  const voices = [...SUPPORTED_VOICES];

  return {
    dtypes,
    voices,
    defaultDtype: pickValueOrFallback("q8", dtypes, "q8"),
    defaultVoice: pickValueOrFallback("af_nicole", voices, "af_nicole"),
  };
}

export async function initKokoro(): Promise<void> {
  if (tts) return;

  const { dtypes, defaultDtype } = await getKokoroTtsOptions();
  const config = getConfig();
  const desiredDtype = pickValueOrFallback(
    config.tts?.dtype,
    dtypes,
    defaultDtype,
  );

  tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
    dtype: desiredDtype as "q8" | "fp16" | "fp32",
    device: "cpu",
  });
}

export async function generateSpeechBuffer(
  text: string,
  voice?: KokoroVoice,
): Promise<Buffer> {
  const options = await getKokoroTtsOptions();
  const config = getConfig();

  await initKokoro();

  if (!tts) {
    throw new Error("Kokoro not initialized.");
  }

  const selectedVoice = pickValueOrFallback(
    voice ?? config.tts?.voice,
    options.voices,
    options.defaultVoice,
  );

  const validVoicesSet = getValidKokoroVoices();

  if (!validVoicesSet.has(selectedVoice)) {
    throw new Error(`Invalid Kokoro voice: ${selectedVoice}`);
  }

  const audio = await tts.generate(text, {
    voice: selectedVoice as KokoroInternalVoice,
  });

  const blob = audio.toBlob();
  const arrayBuffer = await blob.arrayBuffer();

  return Buffer.from(arrayBuffer);
}
