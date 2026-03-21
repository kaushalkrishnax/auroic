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

// ── Vocab cache ───────────────────────────────────────────────────────────────
let _vocabSet: Set<string> | null = null;

// ── CMU dict cache ────────────────────────────────────────────────────────────
let _cmuDict: Record<string, string> | null = null;

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

// Common Hinglish / Indian slang phonetic map
// These are approximate IPA representations good enough for Kokoro
const HINGLISH_PHONETIC: Record<string, string> = {
  // greetings / common
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
  // expressions
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

// Ordinal suffixes
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

// Common abbreviations
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

function arpabetToIpa(phoneme: string): string {
  const stress = phoneme.match(/[012]$/)?.[0] ?? "";
  const base = phoneme.replace(/[012]$/, "");
  const ipa = ARPABET_TO_IPA[base];
  if (!ipa) return "";
  return (stress === "1" ? "ˈ" : stress === "2" ? "ˌ" : "") + ipa;
}

/**
 * Letter-by-letter IPA fallback for truly unknown words.
 * Better than silence — at least it pronounces every character.
 */
function spelledOutIpa(word: string): string {
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
  return word
    .toLowerCase()
    .split("")
    .map((c) => LETTER_IPA[c] ?? c)
    .join(" ");
}

/**
 * Naive grapheme-to-phoneme for unknown alphabetic words.
 * Handles common English patterns. Not perfect but WAY better than silence.
 */
function naiveG2P(word: string): string {
  const w = word.toLowerCase();

  // Common suffix patterns -> approximate IPA
  const suffixMap: Array<[RegExp, string]> = [
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

  for (const [pattern, ipa] of suffixMap) {
    if (pattern.test(w)) {
      // Pronounce the stem naively + known suffix
      const stem = w.replace(pattern, "");
      if (stem.length > 0) return stem + ipa;
    }
  }

  // Last resort: spell it out character by character
  return spelledOutIpa(w);
}

function expandNumber(num: string): string {
  const n = parseInt(num, 10);
  if (isNaN(n)) return num;
  if (n === 0) return "zero";

  const ones = [
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
  const tens = [
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
    if (x < 20) return ones[x];
    if (x < 100)
      return tens[Math.floor(x / 10)] + (x % 10 ? " " + ones[x % 10] : "");
    return (
      ones[Math.floor(x / 100)] +
      " hundred" +
      (x % 100 ? " " + below1000(x % 100) : "")
    );
  }

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

function preprocess(text: string): string {
  return (
    text
      // URLs: just say "link"
      .replace(/https?:\/\/\S+/g, "link")
      // Emails
      .replace(/\S+@\S+\.\S+/g, "email")
      // Ordinals before number expansion
      .replace(
        /\b(1st|2nd|3rd|\d+th)\b/gi,
        (m) => ORDINALS[m.toLowerCase()] ?? m,
      )
      // Currencies
      .replace(
        /₹\s?(\d[\d,]*)/g,
        (_, n) => expandNumber(n.replace(/,/g, "")) + " rupees",
      )
      .replace(
        /\$\s?(\d[\d,]*)/g,
        (_, n) => expandNumber(n.replace(/,/g, "")) + " dollars",
      )
      // Percentages
      .replace(/(\d+)%/g, (_, n) => expandNumber(n) + " percent")
      // Pure numbers
      .replace(/\b\d[\d,]*\b/g, (m) => expandNumber(m.replace(/,/g, "")))
      // Punctuation normalization
      .replace(/[—–]/g, ", ")
      .replace(/\.\.\./g, ", ")
      .replace(/[""]/g, '"')
      .replace(/['']/g, "'")
      .replace(/\s+/g, " ")
      .trim()
  );
}

async function getCmuDict(): Promise<Record<string, string>> {
  if (_cmuDict) return _cmuDict;
  const mod = await import("cmu-pronouncing-dictionary");
  _cmuDict = mod.dictionary as Record<string, string>;
  return _cmuDict;
}

/**
 * Core text -> IPA conversion.
 * Priority order per token:
 * 1. Hinglish/slang phonetic map (fastest, no dict lookup)
 * 2. Abbreviations expansion (recurse)
 * 3. CMU pronouncing dictionary (best for standard English)
 * 4. Naive G2P (unknown English words, names)
 * 5. Spelled out (absolute last resort)
 *
 * Nothing is ever silently dropped.
 */
async function textToIpa(text: string): Promise<string> {
  const dict = await getCmuDict();
  const cleaned = preprocess(text);
  const segments: string[] = [];

  for (const raw of cleaned.split(/\s+/)) {
    if (!raw) continue;

    // Split leading/trailing punctuation
    const m = raw.match(/^([^a-zA-Z0-9]*)([a-zA-Z0-9''-]*)([^a-zA-Z0-9]*)$/);
    const leadPunct = m?.[1] ?? "";
    const token = m?.[2] ?? "";
    const trailPunct = m?.[3] ?? "";

    if (leadPunct) segments.push(leadPunct);

    if (token) {
      const lower = token.toLowerCase();

      // 1. Hinglish/slang map
      if (HINGLISH_PHONETIC[lower]) {
        segments.push(HINGLISH_PHONETIC[lower]);
      }
      // 2. Abbreviations -> expand and re-process inline
      else if (ABBREVIATIONS[lower]) {
        const expanded = await textToIpa(ABBREVIATIONS[lower]);
        segments.push(expanded);
      }
      // 3. CMU dictionary
      else if (dict[lower]) {
        segments.push(dict[lower].split(" ").map(arpabetToIpa).join(""));
      }
      // 4. All-caps acronym -> spell out letters
      else if (/^[A-Z]{2,5}$/.test(token)) {
        segments.push(spelledOutIpa(token));
      }
      // 5. Pure alphabetic unknown word -> naive G2P (handles names, Hindi romanized)
      else if (/^[a-zA-Z]+$/.test(token)) {
        segments.push(naiveG2P(token));
      }
      // 6. Alphanumeric mixed (e.g. "4G", "MP3")
      else if (/^[a-zA-Z0-9]+$/.test(token)) {
        const parts = token.split(/(?<=\d)(?=[a-zA-Z])|(?<=[a-zA-Z])(?=\d)/);
        for (const part of parts) {
          if (/^\d+$/.test(part)) {
            segments.push(expandNumber(part));
          } else {
            segments.push(naiveG2P(part));
          }
        }
      }
      // 7. Anything else: keep as-is (punctuation chars etc)
      else {
        segments.push(token);
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
  _vocabSet = new Set(Object.keys(vocab));
  return vocab;
}

async function tokenize(ipaText: string): Promise<BigInt64Array> {
  const v = await loadVocab();
  const allowed = _vocabSet ?? new Set(Object.keys(v));
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
