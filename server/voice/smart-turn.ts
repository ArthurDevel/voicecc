/**
 * Smart Turn ONNX inference wrapper for end-of-turn detection.
 *
 * Uses the Smart Turn v3.2 model to determine whether a user has finished
 * speaking based on mel spectrogram features extracted from raw audio.
 *
 * Responsibilities:
 * - Load the Smart Turn ONNX model and Whisper feature extractor
 * - Extract mel spectrogram features from raw audio using WhisperFeatureExtractor
 * - Run ONNX inference and return a completion probability
 * - Manage model lifecycle (create/destroy)
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { SmartTurnConfig } from "./types.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Audio sample rate expected by the model */
const SAMPLE_RATE = 16000;

/** Maximum audio duration in seconds (model input window) */
const MAX_AUDIO_SECONDS = 8;

/** Maximum number of samples (8s at 16kHz) */
const MAX_SAMPLES = SAMPLE_RATE * MAX_AUDIO_SECONDS;

/** Number of mel spectrogram frames the model expects (8s at 100 frames/s) */
const MODEL_MEL_FRAMES = 800;

/** Whisper feature extractor model ID for mel spectrogram extraction */
const WHISPER_FEATURE_EXTRACTOR_MODEL = "openai/whisper-tiny";

/** Hugging Face download URL for the Smart Turn v3.2 CPU model */
const MODEL_DOWNLOAD_URL = "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx";

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Result from a Smart Turn inference prediction.
 */
export interface SmartTurnResult {
  /** Whether the turn is considered complete (probability > threshold) */
  isComplete: boolean;
  /** Raw sigmoid output probability (0.0-1.0) */
  probability: number;
  /** Inference duration in milliseconds (including feature extraction) */
  inferenceMs: number;
}

/**
 * Smart Turn predictor instance for ML-based end-of-turn detection.
 */
export interface SmartTurnPredictor {
  /**
   * Predict whether the user has finished speaking based on raw audio.
   * @param audioBuffer - Raw audio samples (16kHz, normalized -1.0 to 1.0)
   * @returns Prediction result with completion probability
   */
  predict(audioBuffer: Float32Array): Promise<SmartTurnResult>;

  /** Release ONNX session resources. */
  destroy(): void;
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Create a Smart Turn predictor by loading the ONNX model and Whisper feature extractor.
 *
 * IMPORTANT: This must be called BEFORE avr-vad is initialized.
 * @huggingface/transformers bundles onnxruntime-node@1.21.0 which conflicts
 * with avr-vad's top-level onnxruntime-node@1.24.3. Loading transformers first
 * ensures its native bindings initialize without conflict.
 *
 * @param config - Smart Turn configuration (model path, threshold, enabled flag)
 * @returns A configured SmartTurnPredictor instance
 * @throws Error if the model file cannot be loaded
 */
export async function createSmartTurnPredictor(config: SmartTurnConfig): Promise<SmartTurnPredictor> {
  const startMs = Date.now();

  // Step 1: Import @huggingface/transformers and disable its ONNX backend
  const transformers = await import("@huggingface/transformers");
  (transformers.env.backends.onnx as unknown) = false;

  // Step 2: Import onnxruntime-node after disabling transformers ONNX backend
  const ort = await import("onnxruntime-node");

  // Step 3: Download the model if it doesn't exist locally
  await ensureModelDownloaded(config.modelPath);

  // Step 4: Load the Whisper feature extractor for mel spectrogram extraction
  const featureExtractor = await transformers.AutoFeatureExtractor.from_pretrained(
    WHISPER_FEATURE_EXTRACTOR_MODEL,
  );

  // Step 5: Load the Smart Turn ONNX model
  const session = await ort.InferenceSession.create(config.modelPath, {
    executionProviders: ["cpu"],
  });

  const loadMs = Date.now() - startMs;
  console.log(`Smart Turn model loaded in ${loadMs}ms`);

  return {
    async predict(audioBuffer: Float32Array): Promise<SmartTurnResult> {
      return await runInference(audioBuffer, session, featureExtractor, config.threshold, ort);
    },

    destroy(): void {
      session.release();
      console.log("Smart Turn model released");
    },
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Download the Smart Turn ONNX model from Hugging Face if it doesn't exist locally.
 *
 * @param modelPath - Local path where the model should be stored
 * @throws Error if the download fails
 */
async function ensureModelDownloaded(modelPath: string): Promise<void> {
  if (existsSync(modelPath)) return;

  console.log(`Smart Turn model not found at ${modelPath}, downloading from Hugging Face...`);

  const dir = dirname(modelPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const response = await fetch(MODEL_DOWNLOAD_URL);
  if (!response.ok) {
    throw new Error(`Failed to download Smart Turn model: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(modelPath, buffer);

  console.log(`Smart Turn model downloaded (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
}

/**
 * Run Smart Turn inference on an audio buffer.
 *
 * Truncates or pads audio to 8s (128000 samples), extracts mel features
 * using WhisperFeatureExtractor, runs ONNX inference, and applies sigmoid.
 *
 * @param audioBuffer - Raw audio samples (16kHz)
 * @param session - ONNX inference session
 * @param featureExtractor - Whisper feature extractor instance
 * @param threshold - Confidence threshold for completion
 * @param ort - onnxruntime-node module (for Tensor construction)
 * @returns Smart Turn prediction result
 */
async function runInference(
  audioBuffer: Float32Array,
  session: import("onnxruntime-node").InferenceSession,
  featureExtractor: import("@huggingface/transformers").FeatureExtractor,
  threshold: number,
  ort: typeof import("onnxruntime-node"),
): Promise<SmartTurnResult> {
  const inferenceStart = Date.now();

  // Truncate or pad audio to MAX_SAMPLES (8s at 16kHz), right-aligned with zero-padding at start
  const paddedAudio = padOrTruncateAudio(audioBuffer);

  // Extract mel spectrogram features using Whisper feature extractor
  // Output shape: [1, 80, 3000] (30s padded window, 80 mel bins)
  const features = await (featureExtractor as unknown as (audio: Float32Array) => Promise<{ input_features: { data: Float32Array; dims: number[] } }>)(paddedAudio);
  const melData = features.input_features.data;

  // Whisper pads to 3000 frames (30s), but the Smart Turn model expects 800 frames (8s).
  // Truncate to the first 800 frames. The audio is right-aligned in the 8s window,
  // so the mel content sits at the start of the spectrogram.
  const melBins = 80;
  const truncatedMel = new Float32Array(melBins * MODEL_MEL_FRAMES);
  for (let bin = 0; bin < melBins; bin++) {
    truncatedMel.set(
      melData.subarray(bin * 3000, bin * 3000 + MODEL_MEL_FRAMES),
      bin * MODEL_MEL_FRAMES,
    );
  }

  // Create ONNX tensor from truncated mel features
  const inputTensor = new ort.Tensor("float32", truncatedMel, [1, melBins, MODEL_MEL_FRAMES]);

  // Run inference
  const results = await session.run({ input_features: inputTensor });

  // Extract logit from model output and apply sigmoid
  const outputNames = Object.keys(results);
  const outputTensor = results[outputNames[0]];
  const logit = (outputTensor.data as Float32Array)[0];
  const probability = sigmoid(logit);

  const inferenceMs = Date.now() - inferenceStart;
  const isComplete = probability > threshold;

  console.log(`Smart Turn: probability=${probability.toFixed(3)}, complete=${isComplete}, ${inferenceMs}ms`);

  return { isComplete, probability, inferenceMs };
}

/**
 * Pad or truncate audio to exactly MAX_SAMPLES.
 * If shorter than MAX_SAMPLES, zero-pad at the start (right-align the audio).
 * If longer, take the last MAX_SAMPLES.
 *
 * @param audio - Input audio samples
 * @returns Float32Array of exactly MAX_SAMPLES length
 */
function padOrTruncateAudio(audio: Float32Array): Float32Array {
  if (audio.length === MAX_SAMPLES) {
    return audio;
  }

  if (audio.length > MAX_SAMPLES) {
    // Take the last MAX_SAMPLES (most recent audio)
    return audio.slice(audio.length - MAX_SAMPLES);
  }

  // Zero-pad at the start (right-align the actual audio)
  const padded = new Float32Array(MAX_SAMPLES);
  padded.set(audio, MAX_SAMPLES - audio.length);
  return padded;
}

/**
 * Apply sigmoid function to convert a logit to a probability.
 *
 * @param x - Raw logit value
 * @returns Probability between 0.0 and 1.0
 */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
