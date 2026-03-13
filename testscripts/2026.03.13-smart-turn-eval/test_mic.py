"""
Quick mic test -- prints audio level to verify the mic is working.

Usage:
    python test_mic.py
"""

import sounddevice as sd
import numpy as np
import time

RATE = 16000
CHUNK = 512

# Set to None to use default, or specify device index (e.g., 3 for MacBook Air Microphone)
INPUT_DEVICE = 3

print("Available input devices:")
print(sd.query_devices())
print()
print(f"Default input device: {sd.default.device[0]}")
print(f"Using device: {INPUT_DEVICE if INPUT_DEVICE is not None else 'default'}")
print()

# Use blocking read instead of callback to rule out callback issues
stream = sd.InputStream(
    device=INPUT_DEVICE,
    samplerate=RATE,
    blocksize=CHUNK,
    channels=1,
    dtype="float32",
)
stream.start()

print("Recording... speak into your mic (Ctrl+C to stop)")
print()

try:
    counter = 0
    while True:
        data, overflowed = stream.read(CHUNK)
        rms = np.sqrt(np.mean(data ** 2))
        bars = int(rms * 300)
        counter += 1

        # Print every ~100ms (roughly every 3 chunks at 16kHz/512)
        if counter % 3 == 0:
            bar_str = "#" * min(bars, 50)
            print(f"  rms={rms:.5f}  {bar_str}", flush=True)

except KeyboardInterrupt:
    print("\nDone.")
finally:
    stream.stop()
    stream.close()
