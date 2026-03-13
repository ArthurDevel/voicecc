"""
Download the Smart Turn v3.2 ONNX model + Silero VAD model.

Usage:
    python download_model.py
"""

import os
import urllib.request

MODELS_DIR = os.path.dirname(os.path.abspath(__file__))

MODELS = {
    "smart-turn-v3.2-cpu.onnx": (
        "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx"
    ),
    "silero_vad.onnx": (
        "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx"
    ),
}


def main():
    for filename, url in MODELS.items():
        path = os.path.join(MODELS_DIR, filename)
        if os.path.exists(path):
            print(f"Already exists: {filename}")
            continue
        print(f"Downloading {filename}...")
        urllib.request.urlretrieve(url, path)
        size_mb = os.path.getsize(path) / (1024 * 1024)
        print(f"  Saved {filename} ({size_mb:.1f} MB)")

    print("Done.")


if __name__ == "__main__":
    main()
