# scripts/start.sh
#!/bin/bash
set -e

MODEL_PATH=/app/models/auroic-router/auroic-router-0.6b.q8_0.gguf
MODELFILE_PATH=/app/models/auroic-router/Modelfile
KOKORO_MODEL_PATH=/app/models/kokoro-tts/model_quantized.onnx
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

# if [ ! -f "$MODEL_PATH" ]; then
#   echo "Downloading router model..."
#   mkdir -p /app/models/auroic-router
#   curl -L "https://huggingface.co/kaushalkrishnax/auroic-router-0.6b/resolve/main/gguf/auroic-router-0.6b.q8_0.gguf" \
#     -o "$MODEL_PATH"
#   curl -L "https://huggingface.co/kaushalkrishnax/auroic-router-0.6b/resolve/main/gguf/Modelfile" \
#     -o "$MODELFILE_PATH"
# fi

if [ ! -f "$KOKORO_MODEL_PATH" ]; then
  echo "Downloading Kokoro TTS model..."
  mkdir -p /app/models/kokoro-tts
  curl -L "https://huggingface.co/onnx-community/Kokoro-82M-ONNX/resolve/main/model_quantized.onnx?download=true" \
    -o "$KOKORO_MODEL_PATH"
fi

# Loop through each voice and download it
for VOICE in "${VOICES[@]}"; do
  FILE_PATH="$VOICE_DIR/${VOICE}.bin"
  
  if [ ! -f "$FILE_PATH" ]; then
    echo "Downloading Kokoro TTS voice: ${VOICE}..."
    curl -L "https://huggingface.co/onnx-community/Kokoro-82M-ONNX/resolve/main/voices/${VOICE}.bin?download=true" \
      -o "$FILE_PATH"
  else
    echo "Voice ${VOICE} already exists. Skipping download."
  fi
done

exec node --enable-source-maps dist/index.js