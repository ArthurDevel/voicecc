/**
 * Entry point for the Claude Code voice sidecar.
 *
 * Starts the voice loop, wires all modules together (audio capture, VAD, STT,
 * endpointing, Claude session, narration, TTS), manages the state machine,
 * and handles shutdown via signal handlers.
 *
 * Responsibilities:
 * - Initialize all voice pipeline modules from config
 * - Run the voice loop state machine (IDLE -> LISTENING -> PROCESSING -> SPEAKING)
 * - Route mic audio through VAD for speech detection and STT accumulation
 * - Handle turn completion via endpointing, then send transcript to Claude
 * - Stream Claude responses through narration into TTS playback
 * - Detect user interruption during SPEAKING (300ms sustained speech filter)
 * - Stop on stop-phrase detection or SIGINT/SIGTERM
 */

import { homedir } from "os";
import { Readable } from "stream";
import { join } from "path";

import { startCapture, stopCapture, bufferToFloat32 } from "./audio-capture.js";
import { createVad } from "./vad.js";
import { createStt } from "./stt.js";
import { createEndpointer } from "./endpointing.js";
import { createClaudeSession } from "./claude-session.js";
import { createNarrator } from "./narration.js";
import { createTts } from "./tts.js";

import type { VadProcessor } from "./vad.js";
import type { SttProcessor } from "./stt.js";
import type { Endpointer } from "./endpointing.js";
import type { ClaudeSession } from "./claude-session.js";
import type { Narrator } from "./narration.js";
import type { TtsPlayer } from "./tts.js";
import type { VadEvent, VoiceLoopConfig, VoiceLoopState, VoiceLoopStatus, TextChunk } from "./types.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Minimum sustained speech duration (ms) before interrupting TTS playback.
 * Set high enough to avoid false triggers from speaker echo picked up by the mic. */
const INTERRUPTION_THRESHOLD_MS = 800;

/** Default configuration for the voice loop */
const DEFAULT_CONFIG: VoiceLoopConfig = {
  sampleRate: 16000,
  stopPhrase: "stop listening",
  sttModelPath: join(homedir(), ".claude-voice-models", "whisper-small"),
  ttsModel: "prince-canuma/Kokoro-82M",
  ttsVoice: "af_heart",
  modelCacheDir: join(homedir(), ".claude-voice-models"),
  endpointing: {
    silenceThresholdMs: 700,
    maxSilenceBeforeTimeoutMs: 1200,
    minWordCountForFastPath: 2,
    enableHaikuFallback: false,
  },
  narration: {
    summaryIntervalMs: 12000,
  },
  claudeSession: {
    allowedTools: [],
    permissionMode: "bypassPermissions",
    systemPrompt:
      "Respond concisely. You are in voice mode -- your responses will be spoken aloud. Keep answers conversational and brief.",
  },
};

// ============================================================================
// MODULE STATE
// ============================================================================

/** Current voice loop state */
let state: VoiceLoopState = { status: "idle", sessionId: null };

/** Whether STT is currently accumulating audio (between SPEECH_START and SPEECH_END) */
let accumulating = false;

/** Timestamp when speech started during SPEAKING state (for interruption filter) */
let speechStartDuringSpeaking: number | null = null;

/** Set to true when user interrupts -- checked by processClaudeResponse to bail out */
let interrupted = false;

/** Module instances (set during init, cleared during shutdown) */
let micStream: Readable | null = null;
let vadProcessor: VadProcessor | null = null;
let sttProcessor: SttProcessor | null = null;
let endpointer: Endpointer | null = null;
let claudeSession: ClaudeSession | null = null;
let narrator: Narrator | null = null;
let ttsPlayer: TtsPlayer | null = null;

/** Active config reference for use in VAD callbacks */
let activeConfig: VoiceLoopConfig | null = null;

/** Flag to prevent multiple concurrent shutdowns */
let stopping = false;

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Initialize all voice pipeline modules and start the main voice loop.
 *
 * Registers SIGINT/SIGTERM handlers for clean shutdown. Runs until
 * `stopVoiceLoop()` is called (via stop phrase or signal).
 *
 * @param config - Voice loop configuration
 * @returns Resolves when the voice loop stops
 */
async function startVoiceLoop(config: VoiceLoopConfig): Promise<void> {
  activeConfig = config;

  // Initialize Claude session first — spawns the persistent process so it's
  // ready by the time the user speaks (eliminates process startup from TTFT).
  console.log("Initializing Claude session...");
  claudeSession = await createClaudeSession(config.claudeSession);

  // TTS uses mlx-audio (Python subprocess on Apple Silicon GPU), no ONNX conflict.
  console.log("Initializing TTS (downloading model on first run, may take a minute)...");
  ttsPlayer = await createTts({
    model: config.ttsModel,
    voice: config.ttsVoice,
  });
  console.log("Initializing VAD...");
  vadProcessor = await createVad(handleVadEvent);
  console.log("Initializing STT...");
  sttProcessor = await createStt(config.sttModelPath);
  console.log("Initializing endpointer...");
  endpointer = createEndpointer(config.endpointing);
  console.log("Initializing narrator...");
  narrator = createNarrator(config.narration);

  // Register signal handlers for clean shutdown
  const signalHandler = () => {
    stopVoiceLoop();
  };
  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);

  console.log("Voice mode active");

  // Transition to LISTENING
  state = handleStateTransition(state, "init_complete");

  // Start mic capture -- returns a readable stream of raw PCM buffers
  micStream = startCapture(config.sampleRate);

  // Wrap the mic data loop in a promise that resolves on stream end or stop
  return new Promise<void>((resolve, reject) => {
    if (!micStream) {
      reject(new Error("Mic stream failed to initialize"));
      return;
    }

    micStream.on("data", (chunk: Buffer) => {
      handleMicChunk(chunk).catch((err) => {
        console.error(`Error processing audio chunk: ${err}`);
      });
    });

    micStream.on("error", (err: Error) => {
      console.error(`Mic stream error: ${err.message}`);
      stopVoiceLoop().then(resolve).catch(reject);
    });

    micStream.on("end", () => {
      resolve();
    });

    micStream.on("close", () => {
      resolve();
    });
  });
}

/**
 * Gracefully shut down the voice loop.
 *
 * Stops mic capture, destroys VAD/STT/TTS, closes Claude session,
 * and resets all state.
 *
 * @returns Resolves when all resources are freed
 */
async function stopVoiceLoop(): Promise<void> {
  if (stopping) return;
  stopping = true;

  stopCapture();
  micStream = null;

  if (vadProcessor) {
    vadProcessor.destroy();
    vadProcessor = null;
  }

  if (sttProcessor) {
    sttProcessor.destroy();
    sttProcessor = null;
  }

  if (ttsPlayer) {
    ttsPlayer.destroy();
    ttsPlayer = null;
  }

  if (claudeSession) {
    await claudeSession.close();
    claudeSession = null;
  }

  endpointer = null;
  narrator = null;
  activeConfig = null;
  accumulating = false;
  speechStartDuringSpeaking = null;

  state = { status: "idle", sessionId: null };
  stopping = false;

  console.log("Voice mode stopped");
}

// ============================================================================
// MAIN LOGIC
// ============================================================================

/**
 * Handle a raw PCM buffer chunk from the mic stream.
 * Converts to float32 and feeds to VAD (which handles its own framing).
 * Also accumulates audio for STT during speech.
 *
 * @param chunk - Raw 16-bit signed PCM buffer from the mic
 */
async function handleMicChunk(chunk: Buffer): Promise<void> {
  if (!vadProcessor) return;

  const samples = bufferToFloat32(chunk);

  // If we're in a speech segment, accumulate for STT
  if (accumulating && sttProcessor) {
    sttProcessor.accumulate(samples);
  }

  // Feed raw audio to VAD -- it handles framing internally (512 samples)
  // and fires events via the handleVadEvent callback
  await vadProcessor.processAudio(samples);
}

/**
 * Handle VAD events dispatched by avr-vad callbacks.
 * Routes to the appropriate handler based on current state.
 *
 * @param event - The VAD event (SPEECH_START, SPEECH_CONTINUE, SPEECH_END)
 */
function handleVadEvent(event: VadEvent): void {
  if (state.status === "listening") {
    handleListeningVadEvent(event);
  } else if (state.status === "speaking" || state.status === "processing") {
    handleInterruptionDetection(event);
  }
}

/**
 * Handle VAD events while in the LISTENING state.
 *
 * SPEECH_START: begin accumulating audio for STT.
 * SPEECH_CONTINUE: sustained speech confirmed (no-op, already accumulating).
 * SPEECH_END: transcribe accumulated audio, check endpointing.
 *
 * @param event - The VAD event
 */
function handleListeningVadEvent(event: VadEvent): void {
  if (event.type === "SPEECH_START") {
    console.log("Hearing speech...");
    accumulating = true;
    return;
  }

  if (event.type === "SPEECH_CONTINUE") {
    // Already accumulating, nothing to do
    return;
  }

  if (event.type === "SPEECH_END") {
    accumulating = false;
    handleSpeechEnd(event).catch((err) => {
      console.error(`Error handling speech end: ${err}`);
    });
  }
}

/**
 * Handle the end of a speech segment: transcribe and check endpointing.
 *
 * @param event - The SPEECH_END VAD event
 */
async function handleSpeechEnd(event: VadEvent): Promise<void> {
  if (!sttProcessor || !endpointer || !activeConfig) return;

  console.log("Transcribing...");
  const result = await sttProcessor.transcribe();

  if (!result.text.trim()) {
    console.log("(empty transcription, continuing)");
    endpointer.reset();
    return;
  }

  console.log(`Heard: "${result.text}"`);

  // Check endpointing decision
  const decision = await endpointer.onVadEvent(event, result.text);

  if (decision.isComplete) {
    endpointer.reset();
    await handleCompleteTurn(result.text, activeConfig);
  }
  // If not complete, keep listening for more speech
}

/**
 * Handle a completed user turn: check for stop phrase, then send to Claude.
 *
 * @param transcript - The finalized transcript text
 * @param config - Voice loop configuration
 */
async function handleCompleteTurn(transcript: string, config: VoiceLoopConfig): Promise<void> {
  // Check for stop phrase
  if (transcript.toLowerCase().includes(config.stopPhrase.toLowerCase())) {
    await stopVoiceLoop();
    return;
  }

  console.log(`Transcript: "${transcript}"`);

  // Transition to PROCESSING
  state = handleStateTransition(state, "transcript_complete");

  // Start processing Claude response (runs concurrently with mic data events)
  processClaudeResponse(transcript).catch((err) => {
    console.error(`Error processing Claude response: ${err}`);
    state = handleStateTransition(state, "error");
  });
}

/**
 * Send transcript to Claude, stream the response through narration and TTS.
 *
 * Uses speakStream() for pipelined TTS: audio for chunk N plays while chunk N+1
 * generates, and the narrator passes text deltas through immediately (kokoro-js's
 * TextSplitterStream handles chunking for TTS).
 *
 * @param transcript - The user's transcribed speech
 */
async function processClaudeResponse(transcript: string): Promise<void> {
  if (!claudeSession || !narrator || !ttsPlayer) {
    throw new Error("Modules not initialized");
  }

  interrupted = false;
  narrator.reset();

  // Async generator that yields text chunks from Claude → narrator
  const session = claudeSession;
  const narr = narrator;
  async function* textChunks(): AsyncGenerator<TextChunk> {
    const eventStream = session.sendMessage(transcript);

    for await (const event of eventStream) {
      if (interrupted) return;

      // Tool narration is a complete sentence -- tag it for immediate TTS
      const isToolEvent = event.type === "tool_start" || event.type === "tool_end";
      const chunks = narr.processEvent(event);
      for (const chunk of chunks) {
        if (interrupted) return;
        yield isToolEvent ? { text: chunk, flush: true } : chunk;
      }
    }

    if (interrupted) return;

    const remaining = narr.flush();
    for (const chunk of remaining) {
      if (interrupted) return;
      yield chunk;
    }
  }

  // Transition to SPEAKING before starting the stream
  state = handleStateTransition(state, "first_audio");

  await ttsPlayer.speakStream(textChunks());

  if (interrupted) {
    console.log("[debug] Response interrupted, bailing out");
    return;
  }

  console.log("[debug] Response processing complete");

  // Transition back to LISTENING
  state = handleStateTransition(state, "response_complete");

  // Reset VAD and endpointer for the next turn
  if (vadProcessor) vadProcessor.reset();
  if (endpointer) endpointer.reset();
  accumulating = false;
  speechStartDuringSpeaking = null;
}

/**
 * Detect sustained speech during SPEAKING/PROCESSING state for interruption.
 *
 * Tracks SPEECH_START timestamps and triggers interruption if speech
 * is sustained for longer than INTERRUPTION_THRESHOLD_MS (300ms).
 *
 * @param event - The VAD event to evaluate
 */
function handleInterruptionDetection(event: VadEvent): void {
  if (event.type === "SPEECH_START") {
    if (speechStartDuringSpeaking === null) {
      speechStartDuringSpeaking = Date.now();
    }
    return;
  }

  if (event.type === "SPEECH_CONTINUE") {
    if (speechStartDuringSpeaking !== null) {
      const duration = Date.now() - speechStartDuringSpeaking;
      if (duration >= INTERRUPTION_THRESHOLD_MS) {
        triggerInterruption();
      }
    }
    return;
  }

  // SPEECH_END -- speech stopped before threshold, reset tracking
  speechStartDuringSpeaking = null;
}

/**
 * Interrupt TTS playback and Claude session, transition back to LISTENING.
 */
function triggerInterruption(): void {
  console.log("User interruption detected");

  interrupted = true;
  if (ttsPlayer) ttsPlayer.interrupt();
  if (claudeSession) claudeSession.interrupt();
  if (sttProcessor) sttProcessor.clearBuffer();

  speechStartDuringSpeaking = null;
  accumulating = false;

  state = handleStateTransition(state, "user_interrupt");
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Pure function that computes the next voice loop state from the current state
 * and an event. Prints state changes to stdout.
 *
 * @param from - Current voice loop state
 * @param event - Event name triggering the transition
 * @returns The new voice loop state
 */
function handleStateTransition(from: VoiceLoopState, event: string): VoiceLoopState {
  let nextStatus: VoiceLoopStatus;

  switch (event) {
    case "init_complete":
      nextStatus = "listening";
      break;
    case "transcript_complete":
      nextStatus = "processing";
      break;
    case "first_audio":
      nextStatus = "speaking";
      break;
    case "response_complete":
      nextStatus = "listening";
      break;
    case "error":
      nextStatus = "listening";
      break;
    case "user_interrupt":
      nextStatus = "listening";
      break;
    default:
      nextStatus = from.status;
  }

  if (nextStatus !== from.status) {
    const label = nextStatus.charAt(0).toUpperCase() + nextStatus.slice(1);
    console.log(`${label}...`);
  }

  return { status: nextStatus, sessionId: from.sessionId };
}

// ============================================================================
// ENTRY POINT
// ============================================================================

startVoiceLoop(DEFAULT_CONFIG).catch((err) => {
  console.error(`Voice loop failed: ${err}`);
  process.exit(1);
});
