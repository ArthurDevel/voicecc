"""
One-time script to generate the startup audio greeting.

Uses mlx_audio's Kokoro model (same API as tts-server.py) to synthesize a short
spoken greeting and writes it as raw 24kHz 16-bit signed mono PCM to
sidecar/assets/startup.pcm.

Usage:
  cd sidecar
  .venv/bin/python3 scripts/generate-startup-audio.py
"""

import os
import sys
import numpy as np

# ============================================================================
# CONSTANTS
# ============================================================================

MODEL_ID = "prince-canuma/Kokoro-82M"
VOICE = "af_heart"
STARTUP_TEXT = "Hi there! I'm Voice CC. How can I help you today?"
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "assets")
OUTPUT_FILE = os.path.join(OUTPUT_DIR, "startup.pcm")

# ============================================================================
# MAIN ENTRYPOINT
# ============================================================================

def main():
    """Load the Kokoro model, generate startup audio, and save as raw PCM."""
    from mlx_audio.tts.utils import load_model

    print(f"Loading model: {MODEL_ID}")
    model = load_model(MODEL_ID)
    print(f"Model loaded (sample_rate={model.sample_rate})")

    print(f"Generating: \"{STARTUP_TEXT}\"")
    chunks = []
    try:
        for result in model.generate(text=STARTUP_TEXT, voice=VOICE, stream=True):
            audio = np.array(result.audio, copy=False)
            chunks.append(audio)
            print(f"  chunk {len(chunks)}: {audio.shape}")
    except Exception as e:
        print(f"ERROR during generation: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)

    combined = np.concatenate(chunks)
    pcm = float32_to_int16_pcm(combined)

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(OUTPUT_FILE, "wb") as f:
        f.write(pcm)

    duration_s = len(combined) / model.sample_rate
    print(f"Wrote {len(pcm)} bytes ({duration_s:.1f}s) to {OUTPUT_FILE}")

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def float32_to_int16_pcm(audio: np.ndarray) -> bytes:
    """
    Convert float32 audio samples (-1.0..1.0) to 16-bit signed PCM bytes.

    @param audio - numpy array of float32 samples
    @returns Raw bytes of int16 little-endian PCM
    """
    clamped = np.clip(audio, -1.0, 1.0)
    int16 = (clamped * 32767).astype(np.int16)
    return int16.tobytes()


if __name__ == "__main__":
    main()
