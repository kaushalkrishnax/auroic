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

// Singletons
let session: ort.InferenceSession | null = null;
let loadedModelPath: string | null = null;
let loadedDtype: KokoroDtype | null = null;

// Caches — loaded once, never reloaded
let _vocab: Record<string, number> | null = null;
let _vocabSet: Set<string> | null = null;
let _cmuDict: Record<string, string> | null = null;

// Voice style cache — file I/O is expensive, cache all loaded voices
const _voiceStyleCache = new Map<string, Float32Array>();

// WAV encode reuse buffer — avoids re-allocating on every TTS call
// Sized for ~30s of audio at 24kHz = 720000 samples = 1.44MB + 44 header
let _wavBuf: Buffer | null = null;

// Concurrent TTS guard — ONNX session is not thread-safe
let _ttsRunning = false;
const _ttsQueue: Array<() => void> = [];

// Static lookup tables (module-level, zero allocation cost)
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

const LETTER_IPA: Record<string, string> = {
  a: "eɪ",
  b: "biː",
  c: "siː",
  d: "diː",
  e: "iː",
  f: "ɛf",
  g: "dʒiː",
  h: "eɪtʃ",
  i: "aɪ",
  j: "dʒeɪ",
  k: "keɪ",
  l: "ɛl",
  m: "ɛm",
  n: "ɛn",
  o: "oʊ",
  p: "piː",
  q: "kjuː",
  r: "ɑːɹ",
  s: "ɛs",
  t: "tiː",
  u: "juː",
  v: "viː",
  w: "dʌbəljuː",
  x: "ɛks",
  y: "waɪ",
  z: "ziː",
};

const HINGLISH_PHONETIC: Record<string, string> = {
  haan: "hɑːn",
  nahi: "nəhɪ",
  nah: "nɑː",
  nahin: "nəhɪn",
  hai: "hɛː",
  ho: "hoː",
  kya: "kjɑː",
  kyun: "kjuːn",
  kyunki: "kjuːnkɪ",
  matlab: "mətlɛb",
  yaar: "jɑːɹ",
  yar: "jɑːɹ",
  bhai: "bʱɑɪ",
  bro: "bɹoʊ",
  dost: "doːst",
  arre: "əɹeː",
  arrey: "əɹeː",
  arey: "əɹeː",
  bas: "bʌs",
  bohot: "bəɦot",
  bahut: "bəɦʊt",
  bilkul: "bɪlkʊl",
  theek: "θiːk",
  thik: "θɪk",
  accha: "ətʃʰɑː",
  acha: "ətʃʰɑː",
  achha: "ətʃʰɑː",
  sahi: "sɑːɦɪ",
  chal: "tʃʌl",
  chalo: "tʃʌloː",
  chalte: "tʃʌlteː",
  abhi: "əbʱɪ",
  ab: "əb",
  toh: "toː",
  tou: "toː",
  woh: "woː",
  wo: "woː",
  wahi: "wəɦɪ",
  yeh: "jeː",
  ye: "jeː",
  mera: "meːɹɑː",
  tera: "teːɹɑː",
  apna: "əpnɑː",
  koi: "koɪ",
  kuch: "kʊtʃ",
  sab: "sʌb",
  sabko: "sʌbkoː",
  sirf: "sɪɹf",
  tum: "tʊm",
  aap: "ɑːp",
  main: "mɛːn",
  mujhe: "mʊdʒʰeː",
  tumhe: "tʊmʰeː",
  usse: "ʊsseː",
  isko: "ɪskoː",
  unko: "ʊnkoː",
  ugh: "ʌɡ",
  omg: "oʊ ɛm dʒiː",
  lol: "lɔl",
  lmao: "lɑːm aʊ",
  brb: "biː ɑːɹ biː",
  btw: "biː tiː dʌbəljuː",
  tbh: "tiː biː eɪtʃ",
  imo: "ɪn maɪ ɒpɪnjən",
  idk: "aɪ doʊnt noʊ",
  ngl: "nɑt ɡɔnə laɪ",
  fr: "fɔːɹ ɹiːəl",
  rn: "ɹaɪt naʊ",
  irl: "ɪn ɹiːəl laɪf",
  smh: "ʃeɪkɪŋ maɪ hɛd",
  istg: "aɪ sweɹ tuː ɡɑd",
  ong: "ɑn ɡɑd",
  nope: "noʊp",
  yep: "jɛp",
  yup: "jʌp",
  gonna: "ɡɔnə",
  wanna: "wɑnə",
  gotta: "ɡɑɾə",
  kinda: "kaɪndə",
  sorta: "sɔːɹɾə",
  dunno: "dənoʊ",
  lemme: "lɛmi",
  gimme: "ɡɪmi",
  tryna: "tɹaɪnə",
  // extra common Indian names / words
  didi: "diːdiː",
  nana: "nɑːnɑː",
  nani: "nɑːniː",
  dada: "dɑːdɑː",
  dadi: "dɑːdiː",
  chacha: "tʃɑːtʃɑː",
  chachi: "tʃɑːtʃiː",
  mama: "mɑːmɑː",
  mami: "mɑːmiː",
  beta: "beːtɑː",
  beti: "beːtiː",
  bhaiya: "bʱɛːjɑː",
  ji: "dʒiː",
  modiji: "moːdiː dʒiː",
  india: "ɪndiə",
  bharat: "bʱɑːɹət",
};

const ABBREVIATIONS: Record<string, string> = {
  mr: "mister",
  mrs: "missus",
  ms: "miss",
  dr: "doctor",
  prof: "professor",
  st: "saint",
  vs: "versus",
  etc: "et cetera",
  eg: "for example",
  ie: "that is",
  approx: "approximately",
  jan: "january",
  feb: "february",
  mar: "march",
  apr: "april",
  jun: "june",
  jul: "july",
  aug: "august",
  sep: "september",
  oct: "october",
  nov: "november",
  dec: "december",
  mon: "monday",
  tue: "tuesday",
  wed: "wednesday",
  thu: "thursday",
  fri: "friday",
  sat: "saturday",
  sun: "sunday",
  km: "kilometers",
  cm: "centimeters",
  mm: "millimeters",
  kg: "kilograms",
  mg: "milligrams",
  gb: "gigabytes",
  mb: "megabytes",
  kb: "kilobytes",
};

const ORDINALS: Record<string, string> = {
  "1st": "first",
  "2nd": "second",
  "3rd": "third",
  "4th": "fourth",
  "5th": "fifth",
  "6th": "sixth",
  "7th": "seventh",
  "8th": "eighth",
  "9th": "ninth",
  "10th": "tenth",
};

// Pre-compiled regexes — never recompile on every call
const RE_URL = /https?:\/\/\S+/g;
const RE_EMAIL = /\S+@\S+\.\S+/g;
const RE_ORDINAL = /\b(1st|2nd|3rd|\d+th)\b/gi;
const RE_RUPEE = /₹\s?(\d[\d,]*)/g;
const RE_DOLLAR = /\$\s?(\d[\d,]*)/g;
const RE_PERCENT = /(\d+)%/g;
const RE_NUMBER = /\b\d[\d,]*\b/g;
const RE_DASH = /[—–]/g;
const RE_ELLIPSIS = /\.\.\./g;
const RE_LQUOTE = /[""]/g;
const RE_APOS = /['']/g;
const RE_WHITESPACE = /\s+/g;
const RE_TOKEN_SPLIT = /^([^a-zA-Z0-9]*)([a-zA-Z0-9''-]*)([^a-zA-Z0-9]*)$/;
const RE_ALNUM_SPLIT = /(?<=\d)(?=[a-zA-Z])|(?<=[a-zA-Z])(?=\d)/;
const RE_ALL_CAPS = /^[A-Z]{2,5}$/;
const RE_ALPHA = /^[a-zA-Z]+$/;
const RE_ALNUM = /^[a-zA-Z0-9]+$/;
const RE_DIGITS = /^\d+$/;

// Suffix map compiled once
const SUFFIX_MAP: Array<[RegExp, string]> = [
  [/tion$/, "ʃən"],
  [/sion$/, "ʒən"],
  [/ous$/, "əs"],
  [/ious$/, "iəs"],
  [/ing$/, "ɪŋ"],
  [/ed$/, "d"],
  [/er$/, "ɚ"],
  [/est$/, "ɪst"],
  [/ly$/, "liː"],
  [/ness$/, "nɪs"],
  [/ment$/, "mənt"],
  [/ful$/, "fʊl"],
  [/less$/, "lɪs"],
  [/able$/, "əbəl"],
  [/ible$/, "ɪbəl"],
  [/ity$/, "ɪtiː"],
  [/ify$/, "ɪfaɪ"],
  [/ize$/, "aɪz"],
  [/ise$/, "aɪz"],
  [/ism$/, "ɪzəm"],
  [/ist$/, "ɪst"],
  [/al$/, "əl"],
  [/ic$/, "ɪk"],
];

const VALID_VOICES = new Set([
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

// Number expansion
const ONES = [
  "",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];

function below1000(x: number): string {
  if (x < 20) return ONES[x];
  if (x < 100)
    return TENS[Math.floor(x / 10)] + (x % 10 ? " " + ONES[x % 10] : "");
  return (
    ONES[Math.floor(x / 100)] +
    " hundred" +
    (x % 100 ? " " + below1000(x % 100) : "")
  );
}

function expandNumber(num: string): string {
  const n = parseInt(num, 10);
  if (isNaN(n) || n < 0) return num;
  if (n === 0) return "zero";
  if (n < 1000) return below1000(n);
  if (n < 1_000_000)
    return (
      below1000(Math.floor(n / 1000)) +
      " thousand" +
      (n % 1000 ? " " + below1000(n % 1000) : "")
    );
  if (n < 1_000_000_000)
    return (
      below1000(Math.floor(n / 1_000_000)) +
      " million" +
      (n % 1_000_000 ? " " + expandNumber(String(n % 1_000_000)) : "")
    );
  return (
    below1000(Math.floor(n / 1_000_000_000)) +
    " billion" +
    (n % 1_000_000_000 ? " " + expandNumber(String(n % 1_000_000_000)) : "")
  );
}

// Text preprocessing
function preprocess(text: string): string {
  return text
    .replace(RE_URL, "link")
    .replace(RE_EMAIL, "email")
    .replace(RE_ORDINAL, (m) => ORDINALS[m.toLowerCase()] ?? m)
    .replace(RE_RUPEE, (_, n) => expandNumber(n.replace(/,/g, "")) + " rupees")
    .replace(
      RE_DOLLAR,
      (_, n) => expandNumber(n.replace(/,/g, "")) + " dollars",
    )
    .replace(RE_PERCENT, (_, n) => expandNumber(n) + " percent")
    .replace(RE_NUMBER, (m) => expandNumber(m.replace(/,/g, "")))
    .replace(RE_DASH, ", ")
    .replace(RE_ELLIPSIS, ", ")
    .replace(RE_LQUOTE, '"')
    .replace(RE_APOS, "'")
    .replace(RE_WHITESPACE, " ")
    .trim();
}

// G2P helpers
function spelledOutIpa(word: string): string {
  return word
    .toLowerCase()
    .split("")
    .map((c) => LETTER_IPA[c] ?? c)
    .join(" ");
}

function naiveG2P(word: string): string {
  const w = word.toLowerCase();
  for (const [pattern, ipa] of SUFFIX_MAP) {
    if (pattern.test(w)) {
      const stem = w.replace(pattern, "");
      if (stem.length > 0) return stem + ipa;
    }
  }
  return spelledOutIpa(w);
}

function arpabetToIpa(phoneme: string): string {
  const stress = phoneme.match(/[012]$/)?.[0] ?? "";
  const base = phoneme.replace(/[012]$/, "");
  const ipa = ARPABET_TO_IPA[base];
  if (!ipa) return "";
  return (stress === "1" ? "ˈ" : stress === "2" ? "ˌ" : "") + ipa;
}

// CMU dic
async function getCmuDict(): Promise<Record<string, string>> {
  if (_cmuDict) return _cmuDict;
  const mod = await import("cmu-pronouncing-dictionary");
  _cmuDict = mod.dictionary as Record<string, string>;
  return _cmuDict;
}

// Core IPA conversion
async function textToIpa(text: string): Promise<string> {
  const dict = await getCmuDict();
  const cleaned = preprocess(text);
  const tokens = cleaned.split(RE_WHITESPACE);
  const segments: string[] = [];

  for (const raw of tokens) {
    if (!raw) continue;

    const m = raw.match(RE_TOKEN_SPLIT);
    const leadPunct = m?.[1] ?? "";
    const token = m?.[2] ?? "";
    const trailPunct = m?.[3] ?? "";

    if (leadPunct) segments.push(leadPunct);

    if (token) {
      const lower = token.toLowerCase();

      if (HINGLISH_PHONETIC[lower]) {
        // 1. Hinglish/slang — fastest path, direct map
        segments.push(HINGLISH_PHONETIC[lower]);
      } else if (ABBREVIATIONS[lower]) {
        // 2. Abbreviation — expand and recurse once
        segments.push(await textToIpa(ABBREVIATIONS[lower]));
      } else if (dict[lower]) {
        // 3. CMU dict — best quality for standard English
        segments.push(dict[lower].split(" ").map(arpabetToIpa).join(""));
      } else if (RE_ALL_CAPS.test(token)) {
        // 4. Acronym like NASA, GDP — spell out
        segments.push(spelledOutIpa(token));
      } else if (RE_ALPHA.test(token)) {
        // 5. Unknown word (names, Hindi romanized) — naive G2P
        segments.push(naiveG2P(token));
      } else if (RE_ALNUM.test(token)) {
        // 6. Mixed alphanumeric like 4G, MP3
        const parts = token.split(RE_ALNUM_SPLIT);
        for (const part of parts) {
          segments.push(
            RE_DIGITS.test(part) ? expandNumber(part) : naiveG2P(part),
          );
        }
      } else {
        // 7. Punctuation or anything else — pass through
        segments.push(token);
      }
    }

    if (trailPunct) segments.push(trailPunct);
  }

  return segments.join(" ");
}

// Voca
async function loadVocab(): Promise<Record<string, number>> {
  if (_vocab) return _vocab;
  const raw = await fs.readFile(KOKORO_TOKENIZER, "utf-8");
  _vocab = JSON.parse(raw).model.vocab as Record<string, number>;
  _vocabSet = new Set(Object.keys(_vocab));
  return _vocab;
}

async function tokenize(ipaText: string): Promise<BigInt64Array> {
  const v = await loadVocab();
  const allowed = _vocabSet!;
  const boundaryId = v["$"] ?? 0;
  // Filter and map in one pass, no intermediate array
  const raw = ipaText.split("");
  const ids: number[] = [boundaryId];
  for (const ch of raw) {
    if (allowed.has(ch)) {
      const id = v[ch];
      if (id !== undefined) ids.push(id);
    }
  }
  ids.push(boundaryId);
  return new BigInt64Array(ids.map(BigInt));
}

// Voice style — cached per voice name
async function loadVoiceStyle(voice: KokoroVoice): Promise<Float32Array> {
  const cached = _voiceStyleCache.get(voice);
  if (cached) return cached;
  const buf = await fs.readFile(path.join(KOKORO_VOICES_DIR, `${voice}.bin`));
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const style = all.slice(0, 256);
  _voiceStyleCache.set(voice, style);
  return style;
}

// ONNX model
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

export async function initKokoro(dtype: KokoroDtype = "q8"): Promise<void> {
  const onnxEntries = await fs
    .readdir(KOKORO_ONNX_DIR)
    .catch(() => [] as string[]);
  const modelPath = pickModelPath(onnxEntries, dtype);
  if (!modelPath) throw new Error(`No ONNX model found in ${KOKORO_ONNX_DIR}`);
  if (session && loadedDtype === dtype && loadedModelPath === modelPath) return;

  session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ["cpu"],
    // These are the ONNX runtime session options that actually matter on CPU
    graphOptimizationLevel: "all",
    executionMode: "sequential", // better for single-threaded CPU
    interOpNumThreads: 1,
    intraOpNumThreads: 2, // use both cores for ONNX ops
  });
  loadedModelPath = modelPath;
  loadedDtype = dtype;
}

// WAV encoding — reuses buffer to avoid GC pressure
function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const dataSize = samples.length * 2;
  const totalSize = 44 + dataSize;

  // Reuse buffer if large enough, otherwise allocate new
  if (!_wavBuf || _wavBuf.length < totalSize) {
    _wavBuf = Buffer.allocUnsafe(totalSize);
  }
  const buf = _wavBuf.slice(0, totalSize);
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
  o += 2; // PCM
  buf.writeUInt16LE(1, o);
  o += 2; // mono
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

  // Return a copy so the reuse buffer stays free for next call
  return Buffer.from(buf);
}

// Concurrency guard — queue TTS calls, ONNX is not re-entrant
function acquireTts(): Promise<void> {
  return new Promise((resolve) => {
    if (!_ttsRunning) {
      _ttsRunning = true;
      resolve();
    } else {
      _ttsQueue.push(resolve);
    }
  });
}

function releaseTts(): void {
  if (_ttsQueue.length > 0) {
    _ttsQueue.shift()!();
  } else {
    _ttsRunning = false;
  }
}

// Public API
export async function getKokoroTtsOptions(): Promise<KokoroTtsOptions> {
  const [onnxEntries, voiceEntries] = await Promise.all([
    fs.readdir(KOKORO_ONNX_DIR).catch(() => [] as string[]),
    fs.readdir(KOKORO_VOICES_DIR).catch(() => [] as string[]),
  ]);

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
        .filter((v) => VALID_VOICES.has(v)),
    ),
  ].sort();

  const resolvedDtypes = dtypes.length ? dtypes : ["q8" as KokoroDtype];
  const resolvedVoices = voices.length ? voices : ["af_nicole"];

  const pickOrFallback = <T extends string>(
    val: unknown,
    available: T[],
    fallback: T,
  ): T => {
    if (typeof val === "string" && available.includes(val as T))
      return val as T;
    return available.includes(fallback) ? fallback : (available[0] ?? fallback);
  };

  return {
    dtypes: resolvedDtypes,
    voices: resolvedVoices,
    defaultDtype: pickOrFallback("q8", resolvedDtypes, "q8"),
    defaultVoice: pickOrFallback("af_nicole", resolvedVoices, "af_nicole"),
  };
}

export async function generateSpeechBuffer(
  text: string,
  voice: KokoroVoice = "af_nicole",
  speed = 1.0,
): Promise<Buffer> {
  if (!VALID_VOICES.has(voice)) throw new Error(`Invalid voice: "${voice}"`);

  await initKokoro();
  if (!session) throw new Error("Kokoro session not initialized.");

  // Serialize concurrent TTS calls — ONNX session is not thread-safe
  await acquireTts();
  try {
    // Run IPA + tokenize in parallel with voice style load
    const [tokenIds, styleData] = await Promise.all([
      textToIpa(text).then(tokenize),
      loadVoiceStyle(voice),
    ]);

    if (tokenIds.length <= 2)
      throw new Error(`No tokens produced for: "${text}"`);

    const results = await session.run({
      input_ids: new ort.Tensor("int64", tokenIds, [1, tokenIds.length]),
      style: new ort.Tensor("float32", styleData, [1, 256]),
      speed: new ort.Tensor("float32", new Float32Array([speed]), [1]),
    });

    const pcm = results[Object.keys(results)[0]].data as Float32Array;
    return encodeWav(pcm, SAMPLE_RATE);
  } finally {
    releaseTts();
  }
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
