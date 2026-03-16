import { AutoModel, AutoTokenizer, env, mean_pooling } from "@huggingface/transformers";
import logger from "@/utils/logger.js";

env.allowLocalModels = true;
env.localModelPath = process.cwd();

const MODEL_FILE = "model.onnx";

type EmbeddingModel = Awaited<ReturnType<typeof AutoModel.from_pretrained>>;
type EmbeddingTokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;

let model: EmbeddingModel | null = null;
let tokenizer: EmbeddingTokenizer | null = null;
let fixedTokenLength: number | null = null;

type TensorLike = {
  dims: number[];
  data: Float32Array | number[];
  normalize: (p?: number, dim?: number) => TensorLike;
};

function isTensorLike(value: unknown): value is TensorLike {
  if (!value || typeof value !== "object") return false;
  const maybe = value as Partial<TensorLike>;
  return (
    Array.isArray(maybe.dims) &&
    maybe.data !== undefined &&
    typeof maybe.normalize === "function"
  );
}

function pickOutputTensor(outputs: Record<string, unknown>): TensorLike | null {
  const preferredKeys = [
    "sentence_embedding",
    "last_hidden_state",
    "logits",
    "token_embeddings",
    "output",
  ];

  for (const key of preferredKeys) {
    const candidate = outputs[key];
    if (isTensorLike(candidate)) return candidate;
  }

  for (const candidate of Object.values(outputs)) {
    if (isTensorLike(candidate)) return candidate;
  }

  return null;
}

function parseExpectedTokenLength(errorMessage: string): number | null {
  const match = errorMessage.match(/Expected:\s*(\d+)/i);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

async function runExtraction(text: string, maxLength: number | null): Promise<number[]> {
  if (!model || !tokenizer) {
    throw new Error("Embedding model is not loaded");
  }

  const inputs = tokenizer(text, {
    padding: maxLength ? "max_length" : true,
    truncation: true,
    max_length: maxLength ?? undefined,
  });

  const outputs = (await model(inputs)) as unknown as Record<string, unknown>;
  let embeddingTensor = pickOutputTensor(outputs);

  if (!embeddingTensor) {
    throw new Error("Embedding model returned no usable output tensor");
  }

  if (embeddingTensor.dims.length === 3 && inputs.attention_mask) {
    embeddingTensor = mean_pooling(
      embeddingTensor as unknown as Parameters<typeof mean_pooling>[0],
      inputs.attention_mask,
    ) as unknown as TensorLike;
  }

  embeddingTensor = embeddingTensor.normalize(2, -1);
  return Array.from(embeddingTensor.data as Float32Array | number[]);
}

async function ensureEmbeddingModelLoaded(): Promise<void> {
  if (model && tokenizer) return;

  logger.info("Loading command embedding model", { modelFile: MODEL_FILE, dtype: "fp32" });

  const [loadedModel, loadedTokenizer] = await Promise.all([
    AutoModel.from_pretrained("indic-sbert-onnx", {
      local_files_only: true,
      dtype: "fp32",
    }),
    AutoTokenizer.from_pretrained("indic-sbert-onnx", {
      local_files_only: true,
    }),
  ]);

  model = loadedModel;
  tokenizer = loadedTokenizer;
}

export async function generateTextEmbedding(text: string): Promise<number[]> {
  const normalizedText = text.trim();
  if (!normalizedText) return [];

  await ensureEmbeddingModelLoaded();

  try {
    return await runExtraction(normalizedText, fixedTokenLength);
  } catch (err) {
    const error = err as Error;
    const detectedLength = parseExpectedTokenLength(error.message);

    // Some ONNX exports are locked to a fixed sequence length (e.g. 6).
    // When detected, retry with tokenizer padding/truncation to that size.
    if (!fixedTokenLength && detectedLength) {
      fixedTokenLength = detectedLength;
      logger.warn("Embedding model uses fixed token length; retrying with padding", {
        maxLength: fixedTokenLength,
      });

      return await runExtraction(normalizedText, fixedTokenLength);
    }

    throw err;
  }
}
