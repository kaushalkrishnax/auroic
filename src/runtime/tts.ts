import { KokoroTTS } from "kokoro-js";
import { spawn } from "child_process";
import path from "path";

let tts: KokoroTTS | null = null;

type KokoroVoice = Exclude<
  NonNullable<Parameters<KokoroTTS["generate"]>[1]>["voice"],
  undefined
>;

export async function initKokoro(): Promise<void> {
  if (tts) return;

  const modelPath = path.join(process.cwd(), "models/kokoro-tts");

  tts = await KokoroTTS.from_pretrained(modelPath, {
    dtype: "q8",
    device: "cpu",
  });
}

export async function generateSpeechBuffer(
  text: string,
  voice: KokoroVoice = "af_bella",
): Promise<Buffer> {
  if (!tts) {
    throw new Error("Kokoro not initialized.");
  }

  const audio = await tts.generate(text, { voice });

  const arrayBuffer = audio.toBlob().arrayBuffer();
  return await arrayBuffer.then((buffer) => Buffer.from(buffer));
}

export function playAudio(filePath: string) {
  const proc = spawn("pw-play", ["--target=tts_sink", filePath], {
    stdio: "ignore",
  });

  return proc;
}
