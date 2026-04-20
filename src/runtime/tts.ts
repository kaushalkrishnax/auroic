import getConfig from "@/runtime/index.js";

const TTS_ENDPOINT = "http://localhost:8000/tts";

const VOICE_MAP = {
  alpha: "alpha",
  beta: "beta",
  omega: "omega",
  psi: "psi",
} as const;

export type KokoroVoice = keyof typeof VOICE_MAP;

interface KokoroTtsOptions {
  voices: string[];
  defaultVoice: string;
}

function resolveVoice(input?: string): string {
  if (!input) return VOICE_MAP.alpha;

  const key = input.toLowerCase() as KokoroVoice;

  if (key in VOICE_MAP) {
    return VOICE_MAP[key];
  }

  return VOICE_MAP.alpha;
}

export async function getKokoroTtsOptions(): Promise<KokoroTtsOptions> {
  const config = getConfig();
  const voices = Object.values(VOICE_MAP);
  const defaultVoice = resolveVoice(config.tts?.voice);

  return {
    voices,
    defaultVoice,
  };
}

export async function generateSpeechBuffer(
  text: string,
  voice?: KokoroVoice,
): Promise<Buffer> {
  if (!text || typeof text !== "string") {
    throw new Error("Invalid text input for TTS");
  }

  const config = getConfig();
  const selectedVoice = resolveVoice(voice ?? config.tts?.voice);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(TTS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        voice: selectedVoice,
        speed: 1.0,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`TTS server error: ${res.status}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    throw new Error(`TTS request failed: ${String(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}