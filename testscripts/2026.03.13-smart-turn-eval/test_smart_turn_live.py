"""
Live mic test for Smart Turn v3.2 end-of-turn detection.

Captures audio from the default mic, runs Silero VAD to detect speech
segments, then feeds each segment to Smart Turn to predict whether the
user's turn is complete or incomplete.

Usage:
    python test_smart_turn_live.py
"""

import os
import math
import time
import threading
from collections import deque

import numpy as np
import sounddevice as sd
import onnxruntime as ort
from transformers import WhisperFeatureExtractor

# ============================================================================
# CONSTANTS
# ============================================================================

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Audio capture
RATE = 16000
CHUNK = 512  # Silero VAD expects 512 samples at 16kHz

# VAD thresholds
VAD_THRESHOLD = 0.5
PRE_SPEECH_MS = 200   # audio to keep before speech trigger
STOP_MS = 1000        # silence duration to end a segment
MAX_DURATION_S = 8    # hard cap per segment (Smart Turn max input)

# Silero VAD internal state reset interval
VAD_RESET_INTERVAL_S = 5.0

# Input device (set to None for default, or device index e.g. 3 for MacBook Air Microphone)
INPUT_DEVICE = 3

# Model paths
SMART_TURN_MODEL = os.path.join(SCRIPT_DIR, "smart-turn-v3.2-cpu.onnx")
SILERO_VAD_MODEL = os.path.join(SCRIPT_DIR, "silero_vad.onnx")

# ============================================================================
# SILERO VAD
# ============================================================================

class SileroVAD:
    """Minimal Silero VAD ONNX wrapper for 16kHz mono, 512-sample chunks."""

    def __init__(self, model_path):
        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        self._session = ort.InferenceSession(
            model_path, providers=["CPUExecutionProvider"], sess_options=opts
        )
        self._context_size = 64
        self._state = None
        self._context = None
        self._last_reset = time.time()
        self._init_state()

    def _init_state(self):
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros((1, self._context_size), dtype=np.float32)

    def _maybe_reset(self):
        if (time.time() - self._last_reset) >= VAD_RESET_INTERVAL_S:
            self._init_state()
            self._last_reset = time.time()

    def probability(self, chunk_f32):
        """
        Compute speech probability for one 512-sample chunk.

        @param chunk_f32 - float32 numpy array, shape (512,)
        @return float between 0 and 1
        """
        x = np.reshape(chunk_f32, (1, -1))
        x = np.concatenate((self._context, x), axis=1)

        ort_inputs = {
            "input": x.astype(np.float32),
            "state": self._state,
            "sr": np.array(RATE, dtype=np.int64),
        }
        out, self._state = self._session.run(None, ort_inputs)
        self._context = x[:, -self._context_size:]
        self._maybe_reset()

        return float(out[0][0])


# ============================================================================
# SMART TURN INFERENCE
# ============================================================================

class SmartTurnPredictor:
    """Runs Smart Turn ONNX inference on audio segments."""

    def __init__(self, model_path):
        so = ort.SessionOptions()
        so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        so.inter_op_num_threads = 1
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self._session = ort.InferenceSession(model_path, sess_options=so)
        self._feature_extractor = WhisperFeatureExtractor(chunk_length=8)

    def predict(self, audio_f32):
        """
        Predict whether a speech segment is a complete turn.

        @param audio_f32 - float32 numpy array, 16kHz mono
        @return dict with "prediction" (0=incomplete, 1=complete) and "probability" (0-1)
        """
        # Truncate to last 8s or pad at the beginning
        max_samples = 8 * RATE
        if len(audio_f32) > max_samples:
            audio_f32 = audio_f32[-max_samples:]
        elif len(audio_f32) < max_samples:
            padding = max_samples - len(audio_f32)
            audio_f32 = np.pad(audio_f32, (padding, 0), mode="constant", constant_values=0)

        # Extract Whisper mel features
        inputs = self._feature_extractor(
            audio_f32,
            sampling_rate=RATE,
            return_tensors="np",
            padding="max_length",
            max_length=8 * RATE,
            truncation=True,
            do_normalize=True,
        )

        input_features = inputs.input_features.squeeze(0).astype(np.float32)
        input_features = np.expand_dims(input_features, axis=0)

        # ONNX inference
        outputs = self._session.run(None, {"input_features": input_features})
        probability = outputs[0][0].item()
        prediction = 1 if probability > 0.5 else 0

        return {"prediction": prediction, "probability": probability}


# ============================================================================
# MAIN LOGIC
# ============================================================================

def run():
    # Check models exist
    for path, name in [(SILERO_VAD_MODEL, "Silero VAD"), (SMART_TURN_MODEL, "Smart Turn")]:
        if not os.path.exists(path):
            print(f"Missing {name} model at {path}")
            print("Run: python download_model.py")
            return

    # Init models
    print("Loading Silero VAD...")
    vad = SileroVAD(SILERO_VAD_MODEL)

    print("Loading Smart Turn v3.2...")
    predictor = SmartTurnPredictor(SMART_TURN_MODEL)

    # Derived chunk counts
    chunk_ms = (CHUNK / RATE) * 1000.0
    pre_chunks = math.ceil(PRE_SPEECH_MS / chunk_ms)
    stop_chunks = math.ceil(STOP_MS / chunk_ms)
    max_chunks = math.ceil(MAX_DURATION_S / (CHUNK / RATE))

    # State (accessed from audio callback thread)
    lock = threading.Lock()
    pre_buffer = deque(maxlen=pre_chunks)
    segment = []
    state = {"speech_active": False, "trailing_silence": 0, "segment_chunks": 0}
    pending_segments = []  # completed segments waiting for inference

    def audio_callback(indata, frames, time_info, status):
        """Called by sounddevice for each audio chunk."""
        # indata is (frames, channels) float32, already normalized to [-1, 1]
        f32 = indata[:, 0].copy()  # mono

        # Process in 512-sample chunks (sounddevice may give us exactly CHUNK)
        with lock:
            is_speech = vad.probability(f32) > VAD_THRESHOLD

            if not state["speech_active"]:
                pre_buffer.append(f32)
                if is_speech:
                    segment.extend(list(pre_buffer))
                    segment.append(f32)
                    state["speech_active"] = True
                    state["trailing_silence"] = 0
                    state["segment_chunks"] = 1
                    print("\n  [speech detected]", end="", flush=True)
            else:
                segment.append(f32)
                state["segment_chunks"] += 1

                if is_speech:
                    state["trailing_silence"] = 0
                else:
                    state["trailing_silence"] += 1

                # End segment on silence or max duration
                if state["trailing_silence"] >= stop_chunks or state["segment_chunks"] >= max_chunks:
                    audio = np.concatenate(segment, dtype=np.float32)
                    pending_segments.append(audio)

                    # Reset state
                    segment.clear()
                    state["speech_active"] = False
                    state["trailing_silence"] = 0
                    state["segment_chunks"] = 0
                    pre_buffer.clear()

    print()
    print("=" * 60)
    print("  Smart Turn Live Test")
    print("  Speak into your mic. Ctrl+C to stop.")
    print("=" * 60)
    print()
    print("Listening...")

    # Start audio stream (non-blocking, callback-based)
    stream = sd.InputStream(
        device=INPUT_DEVICE,
        samplerate=RATE,
        blocksize=CHUNK,
        channels=1,
        dtype="float32",
        callback=audio_callback,
    )
    stream.start()

    try:
        while True:
            # Check for completed segments to process
            audio_to_process = None
            with lock:
                if pending_segments:
                    audio_to_process = pending_segments.pop(0)

            if audio_to_process is not None:
                duration = len(audio_to_process) / RATE
                print(f"  [silence, {duration:.2f}s captured]")

                t0 = time.perf_counter()
                result = predictor.predict(audio_to_process)
                inference_ms = (time.perf_counter() - t0) * 1000.0

                label = "COMPLETE" if result["prediction"] == 1 else "INCOMPLETE"
                prob = result["probability"]

                # Color output: green for complete, yellow for incomplete
                if result["prediction"] == 1:
                    color = "\033[92m"  # green
                else:
                    color = "\033[93m"  # yellow
                reset = "\033[0m"

                print(f"  {color}{label}{reset}  (confidence: {prob:.3f}, inference: {inference_ms:.1f}ms)")
                print()
                print("Listening...")
            else:
                time.sleep(0.01)

    except KeyboardInterrupt:
        print("\n\nStopping.")
    finally:
        stream.stop()
        stream.close()


if __name__ == "__main__":
    run()
