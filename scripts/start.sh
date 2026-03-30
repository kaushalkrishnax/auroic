#!/bin/bash
set -e

MODEL_PATH=/app/models/auroic-router/auroic-router-0.6b.q8_0.gguf
MODELFILE_PATH=/app/models/auroic-router/Modelfile
KOKORO_MODEL_PATH=/app/models/kokoro-tts/onnx/model_quantized.onnx
VOICE_DIR="/app/models/kokoro-tts/voices"

mkdir -p "$VOICE_DIR"

VOICES=(
  "af_bella"
  "af_nicole"
  "af_sarah"
  "af_sky"
  "am_adam"
  "am_michael"
  "bf_emma"
  "bf_isabella"
  "bm_george"
  "bm_lewis"
)

# Download Router Model
if [ ! -f "$MODEL_PATH" ]; then
  echo "Downloading router model..."
  mkdir -p /app/models/auroic-router

  curl -L "https://huggingface.co/kaushalkrishnax/auroic-router-0.6b/resolve/main/gguf/auroic-router-0.6b.q8_0.gguf" \
    -o "$MODEL_PATH"

  curl -L "https://huggingface.co/kaushalkrishnax/auroic-router-0.6b/resolve/main/gguf/Modelfile" \
    -o "$MODELFILE_PATH"
fi

# Download Kokoro TTS
if [ ! -f "$KOKORO_MODEL_PATH" ]; then
  echo "Downloading Kokoro TTS model..."
  mkdir -p /app/models/kokoro-tts/onnx

  curl -L "https://huggingface.co/onnx-community/Kokoro-82M-ONNX/resolve/main/onnx/model_quantized.onnx?download=true" \
    -o "$KOKORO_MODEL_PATH"
fi

# Voices
for VOICE in "${VOICES[@]}"; do
  FILE_PATH="$VOICE_DIR/${VOICE}.bin"

  if [ ! -f "$FILE_PATH" ]; then
    echo "Downloading voice: ${VOICE}"
    curl -L "https://huggingface.co/onnx-community/Kokoro-82M-ONNX/resolve/main/voices/${VOICE}.bin?download=true" \
      -o "$FILE_PATH"
  fi
done

# START OLLAMA
echo "Starting Ollama..."
ollama serve > /tmp/ollama.log 2>&1 &

# Wait for Ollama
echo "Waiting for Ollama to be ready..."
until curl -s http://127.0.0.1:11434 >/dev/null; do
  sleep 1
done

echo "Ollama is ready"

# REGISTER CUSTOM MODEL
if ! ollama list | grep -q "auroic-router"; then
  echo "Creating Ollama model..."
  ollama create auroic-router -f "$MODELFILE_PATH"
fi

# START APP
echo "Starting Node app..."
exec node --enable-source-maps dist/index.js