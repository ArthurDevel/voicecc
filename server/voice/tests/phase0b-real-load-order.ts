/**
 * Phase 0b: Validate Smart Turn works with real server load order.
 *
 * In the actual server, avr-vad loads FIRST (during vad.ts init), then
 * Smart Turn loads later. This test confirms that Smart Turn works
 * correctly with its own mel spectrogram extraction (no @huggingface/transformers).
 */

async function main(): Promise<void> {
  const { join } = await import("path");
  const { homedir } = await import("os");

  console.log("=== Phase 0b: Real Server Load Order ===\n");

  // Step 1: Load avr-vad FIRST (like the real server does)
  console.log("--- Step 1: Load avr-vad ---");
  const { RealTimeVAD } = await import("avr-vad");
  const vad = await RealTimeVAD.new({
    onSpeechStart: () => {},
    onSpeechEnd: () => {},
    onFrameProcessed: () => {},
  });
  vad.start();
  await vad.processAudio(new Float32Array(512));
  console.log("  VAD loaded and working.\n");

  // Step 2: Load Smart Turn (after VAD, like the real server)
  console.log("--- Step 2: Load Smart Turn ---");
  const { createSmartTurnPredictor } = await import("../smart-turn.js");
  const predictor = await createSmartTurnPredictor({
    enabled: true,
    modelPath: join(homedir(), ".voicecc", "models", "smart-turn-v3.2-cpu.onnx"),
    threshold: 0.5,
  });
  console.log("  Smart Turn loaded.\n");

  // Step 3: Test inference
  console.log("--- Step 3: Run inference ---");
  const silence = new Float32Array(128000);
  const r1 = await predictor.predict(silence);
  console.log(`  Silence: prob=${r1.probability.toFixed(3)}, ${r1.inferenceMs}ms`);

  const tone = new Float32Array(32000);
  for (let i = 0; i < tone.length; i++) {
    tone[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / 16000);
  }
  const r2 = await predictor.predict(tone);
  console.log(`  Tone: prob=${r2.probability.toFixed(3)}, ${r2.inferenceMs}ms`);

  // Stability: 5 more runs
  for (let i = 0; i < 5; i++) {
    const r = await predictor.predict(silence);
    if (r.inferenceMs > 200) {
      throw new Error(`Inference too slow: ${r.inferenceMs}ms (target: <200ms)`);
    }
  }
  console.log("  5 additional runs: all < 200ms -- PASS\n");

  predictor.destroy();
  vad.destroy();
  console.log("=== ALL PASS ===");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
