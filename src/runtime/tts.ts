import { KokoroTTS } from "kokoro-js";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import getConfig from "@/runtime/index.js";

let tts: KokoroTTS | null = null;
let loadedDtype: KokoroDtype | null = null;

const KOKORO_MODEL_DIR = path.join(process.cwd(), "models/kokoro-tts");
const KOKORO_ONNX_DIR = path.join(KOKORO_MODEL_DIR, "onnx");
const KOKORO_VOICES_DIR = path.join(KOKORO_MODEL_DIR, "voices");

/**
 * ✅ Your controlled types
 */
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

/**
 * Detect dtype from ONNX filename
 */
function detectDtypeFromOnnxFile(fileName: string): KokoroDtype | null {
  const lower = fileName.toLowerCase();

  if (!lower.endsWith(".onnx")) return null;
  if (lower.includes("quantized")) return "q8";

  const fpMatch = lower.match(/(?:^|[_\-.])(fp\d+)(?:[_\-.]|$)/);
  if (fpMatch?.[1]) return fpMatch[1] as KokoroDtype;

  const qMatch = lower.match(/(?:^|[_\-.])(q\d+)(?:[_\-.]|$)/);
  if (qMatch?.[1]) return qMatch[1] as KokoroDtype;

  return null;
}

/**
 * Normalize voice filename
 */
function normalizeVoiceName(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  if (!lower.endsWith(".bin")) return null;
  return fileName.slice(0, -4);
}

/**
 * Utils
 */
function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
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

/**
 * Discover models + voices (validated)
 */
export async function getKokoroTtsOptions(): Promise<KokoroTtsOptions> {
  const [onnxEntries, voiceEntries] = await Promise.all([
    fs.readdir(KOKORO_ONNX_DIR).catch(() => []),
    fs.readdir(KOKORO_VOICES_DIR).catch(() => []),
  ]);

  const validVoicesSet = getValidKokoroVoices();

  const discoveredDtypes = uniqueSorted(
    onnxEntries
      .map((entry) => detectDtypeFromOnnxFile(entry))
      .filter((v): v is KokoroDtype => Boolean(v)),
  );

  const discoveredVoices = uniqueSorted(
    voiceEntries
      .map((entry) => normalizeVoiceName(entry))
      .filter((v): v is string => Boolean(v))
      .filter((v) => validVoicesSet.has(v)),
  );

  const dtypes: KokoroDtype[] = discoveredDtypes.length
    ? (discoveredDtypes as KokoroDtype[])
    : ["q8"];

  const voices: KokoroVoice[] = discoveredVoices.length
    ? discoveredVoices
    : ["af_nicole"];

  return {
    dtypes,
    voices,
    defaultDtype: pickValueOrFallback("q8", dtypes, "q8"),
    defaultVoice: pickValueOrFallback("af_nicole", voices, "af_nicole"),
  };
}

/**
 * Initialize model
 */
export async function initKokoro(): Promise<void> {
  const options = await getKokoroTtsOptions();
  const config = getConfig();

  const desiredDtype = pickValueOrFallback(
    config.tts?.dtype,
    options.dtypes,
    options.defaultDtype,
  );

  if (tts && loadedDtype === desiredDtype) return;

  tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_DIR, {
    dtype: desiredDtype,
    device: "cpu",
  });

  loadedDtype = desiredDtype;
}

/**
 * Generate speech buffer (fully validated)
 */
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

  // ✅ fail fast instead of silent bugs
  if (!validVoicesSet.has(selectedVoice)) {
    throw new Error(`Invalid Kokoro voice: ${selectedVoice}`);
  }

  const audio = await tts.generate(text, {
    voice: selectedVoice as KokoroInternalVoice, // ✅ safe now
  });

  const blob = audio.toBlob();
  const arrayBuffer = await blob.arrayBuffer();

  return Buffer.from(arrayBuffer);
}

/**
 * Play audio
 */
export function playAudio(filePath: string) {
  const proc = spawn("pw-play", ["--target=tts_sink", filePath], {
    stdio: "ignore",
  });

  proc.on("error", (err) => {
    console.error("Audio playback failed:", err);
  });

  return proc;
}
