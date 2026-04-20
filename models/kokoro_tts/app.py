import os
from fastapi import FastAPI
from pydantic import BaseModel
from misaki.espeak import EspeakG2P
from kokoro_onnx import Kokoro
from fastapi.responses import Response
import numpy as np
import soundfile as sf
import io

app = FastAPI()

MODEL_DIR = os.path.dirname(os.path.abspath(__file__))

VOICES = {
    "alpha": "hf_alpha",
    "beta": "hf_beta",
    "omega": "hm_omega",
    "psi": "hm_psi"
}

g2p = EspeakG2P(language="hi")

model_path = os.path.join(MODEL_DIR, "kokoro-v1.0.onnx")
voices_path = os.path.join(MODEL_DIR, "voices-v1.0.bin")

kokoro = Kokoro(model_path, voices_path)

class TTSRequest(BaseModel):
    text: str
    voice: str = "alpha"
    speed: float = 1.0

@app.post("/tts")
def tts(req: TTSRequest):
    voice = VOICES.get(req.voice, "hf_alpha")
    result = g2p(req.text)
    phonemes = result[0] if isinstance(result, tuple) else result
    samples, sr = kokoro.create(phonemes, voice, req.speed, is_phonemes=True)

    audio = np.array(samples, dtype=np.float32)
    buffer = io.BytesIO()
    sf.write(buffer, audio, sr, format="WAV")
    buffer.seek(0)

    return Response(buffer.read(), media_type="audio/wav")