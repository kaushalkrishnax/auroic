# scripts/start.sh
#!/bin/bash
set -e

MODEL_PATH=/app/models/auroic-router/auroic-router-0.6b.q8_0.gguf
MODELFILE_PATH=/app/models/auroic-router/Modelfile

if [ ! -f "$MODEL_PATH" ]; then
  echo "Downloading router model..."
  mkdir -p /app/models/auroic-router
  curl -L "https://huggingface.co/kaushalkrishnax/auroic-router-0.6b/resolve/main/gguf/auroic-router-0.6b.q8_0.gguf" \
    -o "$MODEL_PATH"
  curl -L "https://huggingface.co/kaushalkrishnax/auroic-router-0.6b/resolve/main/gguf/Modelfile" \
    -o "$MODELFILE_PATH"
fi

exec node --enable-source-maps dist/index.js