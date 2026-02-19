"""
Persistent Python TTS subprocess for the voice sidecar.

Loads a Kokoro (or other mlx-audio) model once on the Apple Silicon GPU,
then accepts JSON commands on stdin and writes length-prefixed raw PCM
audio to stdout.

Responsibilities:
- Load the TTS model on startup via mlx-audio
- Accept generate/interrupt/quit commands on stdin (JSON lines)
- Stream raw 16-bit signed PCM audio chunks to stdout (length-prefixed)
- Support interruption of in-progress generation

Protocol:
  stdin  (JSON lines):
    {"cmd": "generate", "text": "Hello world"}
    {"cmd": "interrupt"}
    {"cmd": "quit"}

  stdout (binary, length-prefixed):
    [4 bytes uint32 BE = chunk length] [N bytes raw int16 PCM at 24kHz mono]
    [4 bytes 0x00000000] = end of generation

  stderr (text lines):
    READY
    ERROR: <message>
    (plus any log output)
"""

import sys
import json
import struct
import signal
import threading
import queue
import numpy as np

# ============================================================================
# CONSTANTS
# ============================================================================

SAMPLE_RATE = 24000
DEFAULT_MODEL = "prince-canuma/Kokoro-82M"
DEFAULT_VOICE = "af_heart"

# ============================================================================
# MAIN HANDLERS
# ============================================================================

def main():
    """Load model and enter the command loop."""
    model_id = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_MODEL
    voice = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_VOICE

    # Load model
    log(f"Loading model: {model_id}")
    try:
        from mlx_audio.tts.utils import load_model
        model = load_model(model_id)
    except Exception as e:
        log(f"ERROR: Failed to load model: {e}")
        sys.exit(1)

    log(f"Model loaded (sample_rate={model.sample_rate})")

    # Warm-up: run one short generation to prime the GPU pipeline
    log("Warming up...")
    try:
        for _ in model.generate(text="Hello.", voice=voice):
            pass
        log("Warm-up done")
    except Exception as e:
        log(f"WARNING: Warm-up failed: {e}")

    # Signal readiness
    sys.stderr.write("READY\n")
    sys.stderr.flush()

    # State shared between stdin reader thread and main thread
    interrupted = threading.Event()
    command_queue = queue.Queue()

    # Ignore SIGINT — let the parent Node.js process handle it
    signal.signal(signal.SIGINT, signal.SIG_IGN)

    # Read stdin on a background thread so interrupt commands are processed
    # immediately, even while handle_generate is running on the main thread.
    def stdin_reader():
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                cmd = json.loads(line)
            except json.JSONDecodeError as e:
                log(f"ERROR: Invalid JSON: {e}")
                continue

            if cmd.get("cmd") == "interrupt":
                interrupted.set()
            else:
                command_queue.put(cmd)

    reader = threading.Thread(target=stdin_reader, daemon=True)
    reader.start()

    # Main thread: process generate/quit commands from the queue
    while True:
        cmd = command_queue.get()

        if cmd.get("cmd") == "generate":
            interrupted.clear()
            handle_generate(model, cmd.get("text", ""), voice, interrupted)
        elif cmd.get("cmd") == "quit":
            break
        else:
            log(f"ERROR: Unknown command: {cmd.get('cmd')}")

    log("Shutting down")


def handle_generate(model, text: str, voice: str, interrupted: threading.Event):
    """
    Generate audio for the given text and write PCM chunks to stdout.

    @param model - The loaded mlx-audio TTS model
    @param text - Text to synthesize
    @param voice - Voice ID (e.g. "af_heart")
    @param interrupted - Event flag set when generation should stop
    """
    if not text.strip():
        write_end_marker()
        return

    try:
        results = model.generate(text=text, voice=voice, stream=True)

        for result in results:
            if interrupted.is_set():
                break

            audio = np.array(result.audio, copy=False)
            pcm = float32_to_int16_pcm(audio)
            write_audio_chunk(pcm)

    except Exception as e:
        log(f"ERROR: Generation failed: {e}")

    write_end_marker()


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


def write_audio_chunk(pcm_bytes: bytes):
    """
    Write a length-prefixed audio chunk to stdout.

    @param pcm_bytes - Raw PCM bytes to write
    """
    header = struct.pack(">I", len(pcm_bytes))
    sys.stdout.buffer.write(header)
    sys.stdout.buffer.write(pcm_bytes)
    sys.stdout.buffer.flush()


def write_end_marker():
    """Write a 0-length frame to signal end of generation."""
    sys.stdout.buffer.write(struct.pack(">I", 0))
    sys.stdout.buffer.flush()


def log(msg: str):
    """Write a log message to stderr."""
    sys.stderr.write(f"[tts-server] {msg}\n")
    sys.stderr.flush()


if __name__ == "__main__":
    main()
