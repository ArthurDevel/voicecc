/**
 * Test: Can we use @huggingface/transformers feature extractor alongside avr-vad?
 *
 * The problem: avr-vad loads onnxruntime-node@1.24.3 (top-level).
 * @huggingface/transformers bundles onnxruntime-node@1.21.0 (nested).
 * Loading both native ONNX runtimes in the same process causes SIGSEGV.
 *
 * This script tests different approaches to make them coexist.
 */

import { join } from "path";
import { homedir } from "os";

const MODEL_PATH = join(homedir(), ".voicecc", "models", "smart-turn-v3.2-cpu.onnx");

// ============================================================================
// Test 1: Load transformers FIRST, then VAD
// ============================================================================
async function test1_transformersFirst() {
  console.log("\n=== Test 1: Load transformers FIRST, then VAD ===");
  try {
    const transformers = await import("@huggingface/transformers");
    (transformers.env.backends.onnx as unknown) = false;
    console.log("✓ Transformers loaded, ONNX backend disabled");

    const fe = await transformers.AutoFeatureExtractor.from_pretrained("openai/whisper-tiny");
    console.log("✓ Feature extractor loaded");

    // Test feature extraction before VAD
    const audio = new Float32Array(128000);
    const features = await (fe as any)(audio);
    console.log("✓ Feature extraction works, shape:", features.input_features.dims);

    // Now load VAD
    const { createVad } = await import("../vad.js");
    const vad = await createVad(() => {});
    console.log("✓ VAD loaded after transformers");

    // Test feature extraction again
    const features2 = await (fe as any)(audio);
    console.log("✓ Feature extraction still works after VAD load, shape:", features2.input_features.dims);

    // Now load ONNX for smart turn
    const ort = await import("onnxruntime-node");
    const session = await ort.InferenceSession.create(MODEL_PATH, { executionProviders: ["cpu"] });
    console.log("✓ ONNX session created");

    // Run inference with truncated mel
    const melData = features2.input_features.data as Float32Array;
    const truncated = new Float32Array(80 * 800);
    for (let bin = 0; bin < 80; bin++) {
      truncated.set(
        melData.subarray(bin * 3000, bin * 3000 + 800),
        bin * 800,
      );
    }
    const tensor = new ort.Tensor("float32", truncated, [1, 80, 800]);
    const result = await session.run({ input_features: tensor });
    const logit = (Object.values(result)[0].data as Float32Array)[0];
    console.log("✓ Inference works, logit:", logit.toFixed(4));

    session.release();
    vad.destroy();
    console.log("✓ Test 1 PASSED");
    return true;
  } catch (e) {
    console.error("✗ Test 1 FAILED:", e);
    return false;
  }
}

// ============================================================================
// Test 2: Load VAD first, then transformers with ONNX disabled
// ============================================================================
async function test2_vadFirst() {
  console.log("\n=== Test 2: Load VAD FIRST, then transformers ===");
  try {
    const { createVad } = await import("../vad.js");
    const vad = await createVad(() => {});
    console.log("✓ VAD loaded first");

    const transformers = await import("@huggingface/transformers");
    (transformers.env.backends.onnx as unknown) = false;
    console.log("✓ Transformers loaded, ONNX backend disabled");

    const fe = await transformers.AutoFeatureExtractor.from_pretrained("openai/whisper-tiny");
    console.log("✓ Feature extractor loaded");

    const audio = new Float32Array(128000);
    const features = await (fe as any)(audio);
    console.log("✓ Feature extraction works, shape:", features.input_features.dims);

    const ort = await import("onnxruntime-node");
    const session = await ort.InferenceSession.create(MODEL_PATH, { executionProviders: ["cpu"] });
    console.log("✓ ONNX session created");

    const melData = features.input_features.data as Float32Array;
    const truncated = new Float32Array(80 * 800);
    for (let bin = 0; bin < 80; bin++) {
      truncated.set(
        melData.subarray(bin * 3000, bin * 3000 + 800),
        bin * 800,
      );
    }
    const tensor = new ort.Tensor("float32", truncated, [1, 80, 800]);
    const result = await session.run({ input_features: tensor });
    const logit = (Object.values(result)[0].data as Float32Array)[0];
    console.log("✓ Inference works, logit:", logit.toFixed(4));

    session.release();
    vad.destroy();
    console.log("✓ Test 2 PASSED");
    return true;
  } catch (e) {
    console.error("✗ Test 2 FAILED:", e);
    return false;
  }
}

// ============================================================================
// Run tests
// ============================================================================
async function main() {
  console.log("Testing @huggingface/transformers + avr-vad compatibility");
  console.log("Model path:", MODEL_PATH);

  // Only run test matching CLI arg, or test 1 by default
  const testNum = process.argv[2] || "1";

  if (testNum === "1") {
    await test1_transformersFirst();
  } else if (testNum === "2") {
    await test2_vadFirst();
  } else {
    console.log("Usage: npx tsx phase1-transformers-compat.ts [1|2]");
  }
}

main().catch(console.error);
