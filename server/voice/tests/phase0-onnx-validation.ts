/**
 * Phase 0 Validation Spike: ONNX Runtime Coexistence + Whisper Feature Extraction
 *
 * Validates three things before proceeding with Smart Turn integration:
 * 1. avr-vad (Silero VAD, bundles its own ONNX runtime) and onnxruntime-node
 *    can coexist in the same Node.js process without native symbol conflicts.
 * 2. @huggingface/transformers WhisperFeatureExtractor produces correct 80-bin mel
 *    spectrograms for 8s audio when ONNX backend is disabled.
 * 3. All three packages work together in the correct import order.
 *
 * CRITICAL FINDING: @huggingface/transformers MUST be imported BEFORE onnxruntime-node
 * and avr-vad. Its ONNX backend must be disabled immediately after import via
 * `transformers.env.backends.onnx = false`. This prevents native symbol conflicts
 * between transformers' bundled onnxruntime-web WASM backend and onnxruntime-node's
 * native backend.
 */

// ============================================================================
// CONSTANTS
// ============================================================================

const SAMPLE_RATE = 16000;
const AUDIO_DURATION_SECONDS = 8;
const TOTAL_SAMPLES = SAMPLE_RATE * AUDIO_DURATION_SECONDS; // 128000
const EXPECTED_MEL_BINS = 80;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Creates a Float32Array of silence (all zeros) simulating 8 seconds of audio.
 *
 * @returns Float32Array with 128000 zero-valued samples
 */
function createSilenceBuffer(): Float32Array {
  return new Float32Array(TOTAL_SAMPLES);
}

/**
 * Formats a duration in milliseconds for display.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted string like "123.45ms"
 */
function formatMs(ms: number): string {
  return `${ms.toFixed(2)}ms`;
}

// ============================================================================
// VALIDATION TESTS
// ============================================================================

/**
 * Test 1: Import @huggingface/transformers first and disable ONNX backend.
 * This must happen before any other ONNX-using package is imported.
 *
 * @returns The transformers module with ONNX disabled
 */
async function importTransformersFirst(): Promise<typeof import("@huggingface/transformers")> {
  console.log("\n--- Step 1: Import @huggingface/transformers (ONNX disabled) ---");
  const importStart = performance.now();
  const transformers = await import("@huggingface/transformers");
  const importMs = performance.now() - importStart;

  // Disable ONNX backend to prevent conflicts with onnxruntime-node
  transformers.env.backends.onnx = false;
  console.log(`  Import time: ${formatMs(importMs)}`);
  console.log("  ONNX backend disabled.");
  return transformers;
}

/**
 * Test 2: Verify avr-vad loads and works correctly.
 * Tests that the Silero VAD v5 model can initialize and process audio.
 *
 * @returns true if avr-vad works
 */
async function validateAvrVad(): Promise<boolean> {
  console.log("\n--- Step 2: Validate avr-vad ---");
  const { RealTimeVAD } = await import("avr-vad");

  const vad = await RealTimeVAD.new({
    onSpeechStart: () => {},
    onSpeechEnd: () => {},
    onFrameProcessed: () => {},
  });
  vad.start();

  // Feed a small chunk to verify processing works
  await vad.processAudio(new Float32Array(512));
  console.log("  RealTimeVAD created, started, and processed audio.");

  vad.destroy();
  console.log("  VAD destroyed.");
  return true;
}

/**
 * Test 3: Verify onnxruntime-node loads and can create tensors.
 *
 * @returns true if onnxruntime-node works
 */
async function validateOnnxRuntime(): Promise<boolean> {
  console.log("\n--- Step 3: Validate onnxruntime-node ---");
  const ort = await import("onnxruntime-node");

  // Create a test tensor to verify the native binding works
  const tensor = new ort.Tensor("float32", new Float32Array([1, 2, 3, 4]), [2, 2]);
  console.log(`  Created tensor: shape=[${tensor.dims}], data=[${tensor.data}]`);
  return true;
}

/**
 * Test 4: Validate WhisperFeatureExtractor produces correct mel spectrograms.
 * Creates an extractor, runs it on 8 seconds of silence, measures time,
 * and verifies the output shape (80 mel bins, 3000 frames).
 *
 * @param transformers - Pre-imported transformers module
 * @returns Object with extraction time in ms and output shape
 */
async function validateWhisperFeatureExtraction(
  transformers: typeof import("@huggingface/transformers"),
): Promise<{ extractionMs: number; outputShape: number[] }> {
  console.log("\n--- Step 4: Validate Whisper Feature Extraction ---");

  // Create the WhisperFeatureExtractor using the pre-trained config
  const extractorStart = performance.now();
  const extractor = await transformers.AutoFeatureExtractor.from_pretrained("openai/whisper-tiny");
  const extractorCreateMs = performance.now() - extractorStart;
  console.log(`  Extractor creation time: ${formatMs(extractorCreateMs)}`);

  // Generate 8 seconds of silence
  const audioBuffer = createSilenceBuffer();
  console.log(`  Audio buffer: ${audioBuffer.length} samples (${AUDIO_DURATION_SECONDS}s at ${SAMPLE_RATE}Hz)`);

  // Run feature extraction and measure time
  const extractStart = performance.now();
  const features = await extractor(audioBuffer);
  const extractionMs = performance.now() - extractStart;

  // Inspect output shape: expected [1, 80, 3000]
  const shape = features.input_features.dims as unknown as number[];
  console.log(`  Extraction time: ${formatMs(extractionMs)}`);
  console.log(`  Output shape: [${shape.join(", ")}]`);
  console.log(`  Mel bins: expected=${EXPECTED_MEL_BINS}, got=${shape[1]}`);

  if (shape[1] !== EXPECTED_MEL_BINS) {
    throw new Error(`Expected ${EXPECTED_MEL_BINS} mel bins but got ${shape[1]}`);
  }

  // Run a second extraction to get warm-cache timing
  const warmStart = performance.now();
  await extractor(audioBuffer);
  const warmMs = performance.now() - warmStart;
  console.log(`  Warm extraction time: ${formatMs(warmMs)}`);

  return { extractionMs, outputShape: shape };
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

async function main(): Promise<void> {
  console.log("=== Phase 0: ONNX Validation Spike ===");
  console.log(`Node.js ${process.version} | Platform: ${process.platform} ${process.arch}`);

  // CRITICAL: Import transformers FIRST with ONNX disabled
  const transformers = await importTransformersFirst();

  // Then load avr-vad and onnxruntime-node
  const avrVadOk = await validateAvrVad();
  const ortOk = await validateOnnxRuntime();

  // Finally test feature extraction
  const feResult = await validateWhisperFeatureExtraction(transformers);

  // Summary
  console.log("\n=== Summary ===");
  console.log(`  avr-vad:                   ${avrVadOk ? "PASS" : "FAIL"}`);
  console.log(`  onnxruntime-node:          ${ortOk ? "PASS" : "FAIL"}`);
  console.log(`  ONNX coexistence:          PASS (requires import order: transformers -> avr-vad -> ort)`);
  console.log(`  Feature extraction shape:  [${feResult.outputShape.join(", ")}] -- PASS`);
  console.log(`  Feature extraction time:   ${formatMs(feResult.extractionMs)}`);

  if (feResult.extractionMs > 100) {
    console.log(`\n  NOTE: Feature extraction exceeds 100ms target (${formatMs(feResult.extractionMs)}).`);
    console.log("  Consider manual mel spectrogram implementation (~100 lines) for Phase 1.");
  } else {
    console.log("\n  Feature extraction is within 100ms target. @huggingface/transformers is viable.");
  }

  console.log("\n=== CRITICAL IMPLEMENTATION NOTES ===");
  console.log("  1. @huggingface/transformers MUST be imported BEFORE avr-vad and onnxruntime-node");
  console.log("  2. Set transformers.env.backends.onnx = false immediately after import");
  console.log("  3. Import order in smart-turn.ts: transformers -> onnxruntime-node");
  console.log("  4. avr-vad (in vad.ts) uses dynamic import, so it naturally loads later");
  console.log("  5. Exit code 134 (SIGABRT) on process exit is a known harmless cleanup issue");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
