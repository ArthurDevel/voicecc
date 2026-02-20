/**
 * Shared voice loop logic extracted from index.ts into a reusable session.
 *
 * Creates a voice session that wires all pipeline modules (VAD, STT, endpointing,
 * Claude session, narration, TTS) using an AudioAdapter for transport-agnostic I/O.
 * All state is closure-scoped inside createVoiceSession, allowing multiple independent
 * sessions across processes.
 *
 * Responsibilities:
 * - Initialize all voice pipeline modules from config
 * - Run the voice loop state machine (IDLE -> LISTENING -> PROCESSING -> SPEAKING)
 * - Route audio through VAD for speech detection and STT accumulation
 * - Handle turn completion via endpointing, then send transcript to Claude
 * - Stream Claude responses through narration into TTS playback
 * - Detect user interruption during SPEAKING/PROCESSING state
 * - Acquire a session lock at start, release on stop
 */

import { readFileSync } from "fs";
import { Writable } from "stream";

import { createVad } from "./vad.js";
import { createStt } from "./stt.js";
import { createEndpointer } from "./endpointing.js";
import { createClaudeSession } from "./claude-session.js";
import { createNarrator } from "./narration.js";
import { createTts } from "./tts.js";
import { acquireSessionLock } from "./session-lock.js";

import { dirname, join } from "path";
import { fileURLToPath } from "url";

import type { AudioAdapter } from "./audio-adapter.js";
import type { SessionLock } from "./session-lock.js";
import type { VadProcessor } from "./vad.js";
import type { SttProcessor } from "./stt.js";
import type { Endpointer } from "./endpointing.js";
import type { ClaudeSession } from "./claude-session.js";
import type { Narrator } from "./narration.js";
import type { TtsPlayer } from "./tts.js";
import type { VadEvent, VoiceLoopState, VoiceLoopStatus, TextChunk, EndpointingConfig, NarrationConfig, ClaudeSessionConfig } from "./types.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default max concurrent sessions (overridden by .env) */
const DEFAULT_MAX_SESSIONS = 2;

/** Pre-recorded startup greeting (24kHz 16-bit mono PCM). Null if file is missing. */
const __dirname = dirname(fileURLToPath(import.meta.url));
const STARTUP_PCM: Buffer | null = (() => {
  try {
    return readFileSync(join(__dirname, "assets", "startup.pcm"));
  } catch {
    return null;
  }
})();

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Configuration for a voice session.
 * Like VoiceLoopConfig but without sampleRate (adapter concern),
 * and with onSessionEnd and interruptionThresholdMs added.
 */
export interface VoiceSessionConfig {
  /** Path to the sherpa-onnx Whisper ONNX model directory */
  sttModelPath: string;
  /** mlx-audio model ID for TTS (e.g. "prince-canuma/Kokoro-82M") */
  ttsModel: string;
  /** TTS voice ID (e.g. "af_heart" for Kokoro) */
  ttsVoice: string;
  /** Directory for cached model files */
  modelCacheDir: string;
  /** Phrase that stops the voice session when spoken */
  stopPhrase: string;
  /** Minimum sustained speech duration (ms) before interrupting TTS playback */
  interruptionThresholdMs: number;
  /** Endpointing configuration for turn detection */
  endpointing: EndpointingConfig;
  /** Narration configuration for Claude response processing */
  narration: NarrationConfig;
  /** Claude Agent SDK session configuration */
  claudeSession: ClaudeSessionConfig;
  /** Called when the stop phrase is detected. Local path: process.exit(). Twilio: ws.close(). */
  onSessionEnd: () => void;
}

/**
 * Handle to a running voice session. Call stop() to tear down.
 */
export interface VoiceSession {
  /** Gracefully shut down the session and release the session lock */
  stop: () => Promise<void>;
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Create and start a voice session using the given audio adapter and config.
 *
 * Acquires a session lock (throws if limit reached), initializes all pipeline
 * modules (VAD, STT, endpointer, Claude session, narrator, TTS), subscribes
 * to adapter audio, and starts the state machine.
 *
 * @param adapter - Audio I/O adapter (local mic or Twilio)
 * @param config - Voice session configuration
 * @returns A VoiceSession handle with stop()
 * @throws Error if session limit reached or initialization fails
 */
export async function createVoiceSession(
  adapter: AudioAdapter,
  config: VoiceSessionConfig,
): Promise<VoiceSession> {
  // Acquire session lock (throws if limit reached)
  const maxSessions = parseInt(process.env.MAX_CONCURRENT_SESSIONS ?? "", 10) || DEFAULT_MAX_SESSIONS;
  const lock: SessionLock = acquireSessionLock(maxSessions);

  // ---- Closure-scoped state ----
  let state: VoiceLoopState = { status: "idle", sessionId: null };
  let accumulating = false;
  let interruptionTimer: ReturnType<typeof setTimeout> | null = null;
  let interrupted = false;
  let stopping = false;

  // Module instances
  let vadProcessor: VadProcessor | null = null;
  let sttProcessor: SttProcessor | null = null;
  let endpointer: Endpointer | null = null;
  let claudeSession: ClaudeSession | null = null;
  let narrator: Narrator | null = null;
  let ttsPlayer: TtsPlayer | null = null;

  // ---- Helper functions (closure-scoped) ----

  /** Clear the interruption detection timer if active. */
  function clearInterruptionTimer(): void {
    if (interruptionTimer !== null) {
      clearTimeout(interruptionTimer);
      interruptionTimer = null;
    }
  }

  /**
   * Pure function that computes the next voice loop state from the current
   * state and an event. Prints state changes to stdout.
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

  // ---- Main logic functions (closure-scoped) ----

  /**
   * Handle a Float32Array audio chunk from the adapter.
   * Feeds audio to VAD and accumulates for STT during speech.
   *
   * @param samples - Float32Array of normalized audio samples
   */
  async function handleAudioChunk(samples: Float32Array): Promise<void> {
    if (!vadProcessor) return;

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
    if (!sttProcessor || !endpointer) return;

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
      await handleCompleteTurn(result.text);
    }
    // If not complete, keep listening for more speech
  }

  /**
   * Handle a completed user turn: check for stop phrase, then send to Claude.
   *
   * @param transcript - The finalized transcript text
   */
  async function handleCompleteTurn(transcript: string): Promise<void> {
    // Check for stop phrase
    if (transcript.toLowerCase().includes(config.stopPhrase.toLowerCase())) {
      config.onSessionEnd();
      return;
    }

    console.log(`Transcript: "${transcript}"`);

    // Transition to PROCESSING
    state = handleStateTransition(state, "transcript_complete");

    // Start processing Claude response (runs concurrently with audio events)
    processClaudeResponse(transcript).catch((err) => {
      console.error(`Error processing Claude response: ${err}`);
      state = handleStateTransition(state, "error");
    });
  }

  /**
   * Send transcript to Claude, stream the response through narration and TTS.
   *
   * @param transcript - The user's transcribed speech
   */
  async function processClaudeResponse(transcript: string): Promise<void> {
    if (!claudeSession || !narrator || !ttsPlayer) {
      throw new Error("Modules not initialized");
    }

    interrupted = false;
    narrator.reset();

    // Async generator that yields text chunks from Claude -> narrator
    const session = claudeSession;
    const narr = narrator;
    const player = ttsPlayer;
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
    adapter.playChime();

    // Transition back to LISTENING
    state = handleStateTransition(state, "response_complete");

    // Reset VAD and endpointer for the next turn
    if (vadProcessor) vadProcessor.reset();
    if (endpointer) endpointer.reset();
    accumulating = false;
    clearInterruptionTimer();
  }

  /**
   * Detect sustained speech during SPEAKING/PROCESSING state for interruption.
   *
   * @param event - The VAD event to evaluate
   */
  function handleInterruptionDetection(event: VadEvent): void {
    if (event.type === "SPEECH_START") {
      if (interruptionTimer === null) {
        // Start capturing audio immediately so we have the full utterance if this
        // turns out to be an interruption
        if (sttProcessor) sttProcessor.clearBuffer();
        accumulating = true;

        interruptionTimer = setTimeout(() => {
          interruptionTimer = null;
          triggerInterruption();
        }, config.interruptionThresholdMs);
      }
      return;
    }

    if (event.type === "SPEECH_END") {
      // Speech ended before threshold -- not an interruption, discard audio
      clearInterruptionTimer();
      accumulating = false;
      if (sttProcessor) sttProcessor.clearBuffer();
    }
  }

  /**
   * Interrupt TTS playback and Claude session, transition back to LISTENING.
   */
  function triggerInterruption(): void {
    console.log("User interruption detected");

    interrupted = true;
    if (ttsPlayer) ttsPlayer.interrupt();
    if (claudeSession) claudeSession.interrupt();

    clearInterruptionTimer();
    // Keep accumulating -- user is still speaking. Buffer already has audio from
    // SPEECH_START onwards, so the full utterance will be transcribed on SPEECH_END.

    state = handleStateTransition(state, "user_interrupt");
  }

  /**
   * Gracefully shut down the voice session and release all resources.
   */
  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;

    adapter.destroy();

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
    accumulating = false;
    clearInterruptionTimer();

    state = { status: "idle", sessionId: null };

    lock.release();

    console.log("Voice session stopped");
  }

  // ---- Initialization ----

  // Fire-and-forget the startup greeting so it plays while modules initialize.
  // Short delay lets the audio device settle before playback.
  if (STARTUP_PCM) {
    setTimeout(() => {
      adapter.writeSpeaker(STARTUP_PCM).catch((err) => {
        console.error(`Failed to play startup audio: ${err}`);
      });
    }, 1000);
  }

  // Wrap adapter.writeSpeaker in a Node.js Writable stream for TTS config
  const speakerWritable = new Writable({
    write(chunk: Buffer, _encoding: string, callback: (err?: Error | null) => void) {
      adapter.writeSpeaker(chunk).then(() => callback(), callback);
    },
  });

  // Claude session and TTS are the slowest to initialize (process spawns + model
  // loading). Run them in parallel since they are independent.
  console.log("Initializing Claude session + TTS in parallel...");
  const [claudeResult, ttsResult] = await Promise.all([
    createClaudeSession(config.claudeSession),
    createTts({
      model: config.ttsModel,
      voice: config.ttsVoice,
      speakerInput: speakerWritable,
      interruptPlayback: () => adapter.interrupt(),
      resumePlayback: () => adapter.resume(),
    }),
  ]);
  claudeSession = claudeResult;
  ttsPlayer = ttsResult;

  // VAD and STT both load ONNX runtimes -- keep them sequential to avoid
  // native library conflicts within the same Node process.
  console.log("Initializing VAD...");
  vadProcessor = await createVad(handleVadEvent);

  console.log("Initializing STT...");
  sttProcessor = await createStt(config.sttModelPath);

  console.log("Initializing endpointer...");
  endpointer = createEndpointer(config.endpointing);

  console.log("Initializing narrator...");
  narrator = createNarrator(config.narration, async (summary: string) => {
    if (interrupted || !ttsPlayer) return;
    await ttsPlayer.speakStream((async function*() {
      yield { text: summary, flush: true };
    })());
  });

  console.log("Voice mode active");
  adapter.playChime();

  // Transition to LISTENING
  state = handleStateTransition(state, "init_complete");

  // Subscribe to audio from the adapter
  adapter.onAudio((samples: Float32Array) => {
    handleAudioChunk(samples).catch((err) => {
      console.error(`Error processing audio chunk: ${err}`);
    });
  });

  return { stop };
}
