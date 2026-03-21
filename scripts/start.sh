# scripts/start.sh
#!/bin/bash
set -e

MODEL_PATH=/app/models/auroic-router/auroic-router-0.6b.q8_0.gguf
MODELFILE_PATH=/app/models/auroic-router/Modelfile
KOKORO_MODEL_PATH=/app/models/kokoro-tts/model_quantized.onnx
KOKORO_VOICE_PATH=/app/models/kokoro-tts/voices/af_nicole.bin

if [ ! -f "$MODEL_PATH" ]; then
  echo "Downloading router model..."
  mkdir -p /app/models/auroic-router
  curl -L "https://huggingface.co/kaushalkrishnax/auroic-router-0.6b/resolve/main/gguf/auroic-router-0.6b.q8_0.gguf" \
    -o "$MODEL_PATH"
  curl -L "https://huggingface.co/kaushalkrishnax/auroic-router-0.6b/resolve/main/gguf/Modelfile" \
    -o "$MODELFILE_PATH"
fi

if [ ! -f "$KOKORO_MODEL_PATH" ]; then
  echo "Downloading Kokoro TTS model..."
  mkdir -p /app/models/kokoro-tts
  curl -L "https://huggingface.co/onnx-community/Kokoro-82M-ONNX/resolve/main/model_quantized.onnx?download=true" \
    -o "$KOKORO_MODEL_PATH"
fi

if [ ! -f "$KOKORO_VOICE_PATH" ]; then
  echo "Downloading Kokoro TTS voice..."
  mkdir -p /app/models/kokoro-tts/voices
  curl -L "https://huggingface.co/onnx-community/Kokoro-82M-ONNX/resolve/main/voices/af_nicole.bin?download=true" \
    -o "$KOKORO_VOICE_PATH"
fi

exec node --enable-source-maps dist/index.js