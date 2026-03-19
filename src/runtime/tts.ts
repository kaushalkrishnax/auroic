import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import * as ort from "onnxruntime-node";

const KOKORO_MODEL_DIR = path.join(process.cwd(), "models/kokoro-tts");
const KOKORO_ONNX_DIR = path.join(KOKORO_MODEL_DIR, "onnx");
const KOKORO_VOICES_DIR = path.join(KOKORO_MODEL_DIR, "voices");
const KOKORO_TOKENIZER = path.join(KOKORO_MODEL_DIR, "tokenizer.json");
const SAMPLE_RATE = 24000;

export type KokoroDtype = "q8" | "fp16" | "fp32";
export type KokoroVoice = string;

export interface KokoroTtsOptions {
  dtypes: KokoroDtype[];
  voices: KokoroVoice[];
  defaultDtype: KokoroDtype;
  defaultVoice: KokoroVoice;
}

let session: ort.InferenceSession | null = null;
let loadedModelPath: string | null = null;
let loadedDtype: KokoroDtype | null = null;
let vocab: Record<string, number> | null = null;

const ARPABET_TO_IPA: Record<string, string> = {
  AA: "ɑ",
  AE: "æ",
  AH: "ʌ",
  AO: "ɔ",
  AW: "aʊ",
  AY: "aɪ",
  EH: "ɛ",
  ER: "ɝ",
  EY: "eɪ",
  IH: "ɪ",
  IY: "iː",
  OW: "oʊ",
  OY: "ɔɪ",
  UH: "ʊ",
  UW: "uː",
  B: "b",
  CH: "tʃ",
  D: "d",
  DH: "ð",
  F: "f",
  G: "ɡ",
  HH: "h",
  JH: "dʒ",
  K: "k",
  L: "l",
  M: "m",
  N: "n",
  NG: "ŋ",
  P: "p",
  R: "ɹ",
  S: "s",
  SH: "ʃ",
  T: "t",
  TH: "θ",
  V: "v",
  W: "w",
  Y: "j",
  Z: "z",
  ZH: "ʒ",
};

const DIGIT_NAMES = [
  "ZERO",
  "ONE",
  "TWO",
  "THREE",
  "FOUR",
  "FIVE",
  "SIX",
  "SEVEN",
  "EIGHT",
  "NINE",
];

function arpabetToIpa(phoneme: string): string {
  const stress = phoneme.match(/[012]$/)?.[0] ?? "";
  const base = phoneme.replace(/[012]$/, "");
  const ipa = ARPABET_TO_IPA[base];
  if (!ipa) return "";
  return (stress === "1" ? "ˈ" : stress === "2" ? "ˌ" : "") + ipa;
}

// Expand a token that contains digits or is alphanumeric into speakable chunks.
function expandToken(token: string): string {
  if (/^\d+$/.test(token)) {
    return token
      .split("")
      .map((d) => DIGIT_NAMES[parseInt(d)])
      .join(" ");
  }
  return token
    .split(/(?<=\d)(?=[a-zA-Z])|(?<=[a-zA-Z])(?=\d)/)
    .map((part) =>
      /^\d+$/.test(part) ? expandToken(part) : part.toUpperCase(),
    )
    .join(" ");
}

let _cmuDict: Record<string, string> | null = null;
async function getCmuDict(): Promise<Record<string, string>> {
  if (_cmuDict) return _cmuDict;
  const mod = await import("cmu-pronouncing-dictionary");
  _cmuDict = mod.dictionary as Record<string, string>;
  return _cmuDict;
}

async function textToIpa(text: string): Promise<string> {
  const dict = await getCmuDict();
  const cleaned = text
    .replace(/[^\w\s.,!?;:'"-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const segments: string[] = [];

  for (const raw of cleaned.split(/\s+/)) {
    const m = raw.match(/^([.,!?;:]*)([a-zA-Z0-9'-]*)([.,!?;:]*)$/);
    const leadPunct = m?.[1] ?? "";
    const token = m?.[2] ?? "";
    const trailPunct = m?.[3] ?? "";

    if (leadPunct) segments.push(leadPunct);

    if (token) {
      const lower = token.toLowerCase();
      if (dict[lower]) {
        segments.push(dict[lower].split(" ").map(arpabetToIpa).join(""));
      } else if (/^[a-zA-Z]+$/.test(token)) {
        segments.push(token.toUpperCase());
      } else {
        segments.push(expandToken(token));
      }
    }

    if (trailPunct) segments.push(trailPunct);
  }

  return segments.join(" ");
}

async function loadVocab(): Promise<Record<string, number>> {
  if (vocab) return vocab;
  const raw = await fs.readFile(KOKORO_TOKENIZER, "utf-8");
  vocab = JSON.parse(raw).model.vocab as Record<string, number>;
  return vocab;
}

async function tokenize(ipaText: string): Promise<BigInt64Array> {
  const v = await loadVocab();
  const allowed = new Set(Object.keys(v));
  const chars = ipaText.split("").filter((ch) => allowed.has(ch));
  const boundaryId = v["$"] ?? 0;
  const ids = [
    boundaryId,
    ...chars.map((ch) => v[ch]).filter((id) => id !== undefined),
    boundaryId,
  ];
  return new BigInt64Array(ids.map(BigInt));
}

async function loadVoiceStyle(voice: KokoroVoice): Promise<Float32Array> {
  const buf = await fs.readFile(path.join(KOKORO_VOICES_DIR, `${voice}.bin`));
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return all.slice(0, 256);
}

function getValidVoices(): Set<string> {
  return new Set([
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
  ]);
}

function pickModelPath(
  onnxEntries: string[],
  dtype: KokoroDtype,
): string | null {
  const files = onnxEntries.filter((f) => f.toLowerCase().endsWith(".onnx"));
  if (!files.length) return null;
  const match = files.find((f) => {
    const l = f.toLowerCase();
    if (dtype === "q8") return l.includes("quantized") || l.includes("q8");
    return l.includes(dtype);
  });
  return path.join(KOKORO_ONNX_DIR, match ?? files[0]);
}

function pickOrFallback<T extends string>(
  val: unknown,
  available: T[],
  fallback: T,
): T {
  if (typeof val === "string" && available.includes(val as T)) return val as T;
  return available.includes(fallback) ? fallback : (available[0] ?? fallback);
}

export async function getKokoroTtsOptions(): Promise<KokoroTtsOptions> {
  const [onnxEntries, voiceEntries] = await Promise.all([
    fs.readdir(KOKORO_ONNX_DIR).catch(() => [] as string[]),
    fs.readdir(KOKORO_VOICES_DIR).catch(() => [] as string[]),
  ]);

  const validVoices = getValidVoices();

  const dtypes = [
    ...new Set(
      onnxEntries
        .map((f) => {
          const l = f.toLowerCase();
          if (!l.endsWith(".onnx")) return null;
          if (l.includes("quantized") || l.includes("q8")) return "q8";
          return l.match(/(?:fp|q)\d+/)?.[0] ?? null;
        })
        .filter(Boolean) as KokoroDtype[],
    ),
  ].sort();

  const voices = [
    ...new Set(
      voiceEntries
        .filter((f) => f.endsWith(".bin"))
        .map((f) => f.slice(0, -4))
        .filter((v) => validVoices.has(v)),
    ),
  ].sort();

  const resolvedDtypes = dtypes.length ? dtypes : ["q8" as KokoroDtype];
  const resolvedVoices = voices.length ? voices : ["af_nicole"];

  return {
    dtypes: resolvedDtypes,
    voices: resolvedVoices,
    defaultDtype: pickOrFallback("q8", resolvedDtypes, "q8"),
    defaultVoice: pickOrFallback("af_nicole", resolvedVoices, "af_nicole"),
  };
}

export async function initKokoro(dtype: KokoroDtype = "q8"): Promise<void> {
  const onnxEntries = await fs
    .readdir(KOKORO_ONNX_DIR)
    .catch(() => [] as string[]);
  const modelPath = pickModelPath(onnxEntries, dtype);
  if (!modelPath) throw new Error(`No ONNX model found in ${KOKORO_ONNX_DIR}`);
  if (session && loadedDtype === dtype && loadedModelPath === modelPath) return;

  session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ["cpu"],
  });
  loadedModelPath = modelPath;
  loadedDtype = dtype;
}

export async function generateSpeechBuffer(
  text: string,
  voice: KokoroVoice = "af_nicole",
  speed = 1.0,
): Promise<Buffer> {
  await initKokoro();
  if (!session) throw new Error("Kokoro session not initialized.");
  if (!getValidVoices().has(voice))
    throw new Error(`Invalid voice: "${voice}"`);

  const ipaText = await textToIpa(text);
  const tokenIds = await tokenize(ipaText);
  if (tokenIds.length <= 2)
    throw new Error(`No tokens produced for: "${text}"`);

  const styleData = new Float32Array(256);
  styleData.set((await loadVoiceStyle(voice)).slice(0, 256));

  const results = await session.run({
    input_ids: new ort.Tensor("int64", tokenIds, [1, tokenIds.length]),
    style: new ort.Tensor("float32", styleData, [1, 256]),
    speed: new ort.Tensor("float32", new Float32Array([speed]), [1]),
  });

  const pcm = results[Object.keys(results)[0]].data as Float32Array;
  return encodeWav(pcm, SAMPLE_RATE);
}

function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const dataSize = samples.length * 2;
  const buf = Buffer.allocUnsafe(44 + dataSize);
  let o = 0;

  buf.write("RIFF", o);
  o += 4;
  buf.writeUInt32LE(36 + dataSize, o);
  o += 4;
  buf.write("WAVE", o);
  o += 4;
  buf.write("fmt ", o);
  o += 4;
  buf.writeUInt32LE(16, o);
  o += 4;
  buf.writeUInt16LE(1, o);
  o += 2;
  buf.writeUInt16LE(1, o);
  o += 2;
  buf.writeUInt32LE(sampleRate, o);
  o += 4;
  buf.writeUInt32LE(sampleRate * 2, o);
  o += 4;
  buf.writeUInt16LE(2, o);
  o += 2;
  buf.writeUInt16LE(16, o);
  o += 2;
  buf.write("data", o);
  o += 4;
  buf.writeUInt32LE(dataSize, o);
  o += 4;

  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(
      Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767),
      o,
    );
    o += 2;
  }

  return buf;
}

export async function playBuffer(wavBuffer: Buffer): Promise<void> {
  const tmpPath = path.join("/tmp", `kokoro_${Date.now()}.wav`);
  try {
    await fs.writeFile(tmpPath, wavBuffer);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("pw-play", ["--target=tts_sink", tmpPath], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      proc.stderr?.on("data", (c: Buffer) => {
        stderr += c.toString();
      });
      proc.on("error", (e) =>
        reject(new Error(`pw-play failed: ${e.message}`)),
      );
      proc.on("close", (code) => {
        code !== 0
          ? reject(
              new Error(
                `pw-play exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
              ),
            )
          : resolve();
      });
    });
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
}

export async function speak(
  text: string,
  voice?: KokoroVoice,
  speed = 1.0,
): Promise<void> {
  await playBuffer(await generateSpeechBuffer(text, voice, speed));
}
