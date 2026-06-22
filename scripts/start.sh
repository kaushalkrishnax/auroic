#!/bin/bash
set -e
export DB_PATH=/data/app/state.db
export CONFIG_DB_PATH=/data/app/config.db
export PORT=7860

MODEL_PATH=/app/models/auroic-router/auroic-router-0.6b.q8_0.gguf
MODELFILE_PATH=/app/models/auroic-router/Modelfile

# Download Router Model
if [ ! -f "$MODEL_PATH" ]; then
  echo "Downloading router model..."
  mkdir -p /app/models/auroic-router

  curl -L "https://huggingface.co/kaushalkrishnax/auroic-router-0.6b/resolve/main/gguf/auroic-router-0.6b.q8_0.gguf" \
    -o "$MODEL_PATH"

  curl -L "https://huggingface.co/kaushalkrishnax/auroic-router-0.6b/resolve/main/gguf/Modelfile" \
    -o "$MODELFILE_PATH"
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

# START APP
echo "Starting Node app..."
exec node --enable-source-maps dist/index.js