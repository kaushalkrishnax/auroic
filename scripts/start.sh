#!/bin/bash
set -e

export DB_PATH=/data/app/state.db
export CONFIG_DB_PATH=/data/app/config.db
export CHROMIUM_PROFILE_DIR=/data/app/chrome-auroic
export PORT=7860

MODEL_PATH=/app/models/auroic-router/auroic-router-0.6b.q8_0.gguf
MODELFILE_PATH=/app/models/auroic-router/Modelfile
KOKORO_MODEL_DIR=/app/models/kokoro_tts

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
mkdir -p "$KOKORO_MODEL_DIR"

if [ ! -f "$KOKORO_MODEL_DIR/kokoro-v1.0.onnx" ]; then
  echo "Downloading Kokoro TTS model and voices..."

  curl -L "https://huggingface.co/leonelhs/kokoro-thewh1teagle/resolve/main/kokoro-v1.0.onnx?download=true" \
    -o "$KOKORO_MODEL_DIR/kokoro-v1.0.onnx"

  curl -L "https://huggingface.co/leonelhs/kokoro-thewh1teagle/resolve/main/voices-v1.0.bin?download=true" \
    -o "$KOKORO_MODEL_DIR/voices-v1.0.bin"
fi

if [ -f "$MODEL_PATH" ]; then
  # START OLLAMA
  echo "Starting Ollama..."
  ollama serve > /tmp/ollama.log 2>&1 &

  # Wait for Ollama to be ready before creating the model
  echo "Waiting for Ollama to be ready..."
  for i in $(seq 1 30); do
    if ollama list > /dev/null 2>&1; then
      echo "Ollama is ready."
      break
    fi
    echo "  Attempt $i/30 - not ready yet, retrying in 1s..."
    sleep 1
  done

  echo "Creating Ollama model..."
  ollama create auroic-router -f "$MODELFILE_PATH"
fi

# START KOKORO TTS SERVICE
echo "Starting Kokoro TTS Python service..."
uvicorn models.kokoro_tts.app:app --host 0.0.0.0 --port 8000 &

# START APP
echo "Starting Node app..."
exec node --enable-source-maps dist/index.js