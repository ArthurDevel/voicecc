/**
 * Shared types for the Claude Code voice sidecar.
 *
 * Defines all DTOs and interfaces used across the voice pipeline modules:
 * - Voice loop configuration and state
 * - Audio frame representation
 * - VAD (voice activity detection) events
 * - STT (speech-to-text) results
 * - Endpointing decisions for turn detection
 * - Claude session streaming events
 * - TTS (text-to-speech) configuration
 * - Narration configuration
 */

// ============================================================================
// CONFIGURATION INTERFACES
// ============================================================================

/**
 * Top-level configuration for the voice loop.
 * Passed to `startVoiceLoop` to initialize all modules.
 */
export interface VoiceLoopConfig {
  /** Path to the sherpa-onnx Whisper ONNX model directory */
  sttModelPath: string;
  /** mlx-audio model ID for TTS (e.g. "prince-canuma/Kokoro-82M") */
  ttsModel: string;
  /** TTS voice ID (e.g. "af_heart" for Kokoro) */
  ttsVoice: string;
  /** Directory for cached model files */
  modelCacheDir: string;
  /** Audio sample rate in Hz (must match mic and VAD/STT expectations) */
  sampleRate: number;
  /** Endpointing configuration for turn detection */
  endpointing: EndpointingConfig;
  /** Narration configuration for Claude response processing */
  narration: NarrationConfig;
  /** Claude Agent SDK session configuration */
  claudeSession: ClaudeSessionConfig;
  /** Phrase that stops the voice loop when spoken */
  stopPhrase: string;
}

/**
 * Configuration for the endpointing module.
 * Controls how the system decides when the user is done speaking.
 */
export interface EndpointingConfig {
  /** Silence duration (ms) before considering speech complete */
  silenceThresholdMs: number;
  /** Maximum silence duration (ms) before forcing completion regardless */
  maxSilenceBeforeTimeoutMs: number;
  /** Minimum word count for the VAD fast path (skips Haiku check) */
  minWordCountForFastPath: number;
  /** Whether to use Haiku API for ambiguous short utterances */
  enableHaikuFallback: boolean;
}

/**
 * Configuration for the Claude Agent SDK session.
 */
export interface ClaudeSessionConfig {
  /** List of allowed tool names (empty array means all tools allowed) */
  allowedTools: string[];
  /** Permission mode -- must be "bypassPermissions" for voice loop */
  permissionMode: string;
  /** System prompt instructing Claude to respond concisely for voice output */
  systemPrompt: string;
}

/**
 * Configuration for the narration module.
 * Controls how Claude's streaming output is processed into speakable text.
 */
export interface NarrationConfig {
  /** Interval (ms) between "still working..." summaries during long tool runs */
  summaryIntervalMs: number;
}

/**
 * Configuration for the TTS (text-to-speech) module.
 */
export interface TtsConfig {
  /** mlx-audio model ID (e.g. "prince-canuma/Kokoro-82M") */
  model: string;
  /** Voice ID (e.g. "af_heart" for Kokoro) */
  voice: string;
}

// ============================================================================
// AUDIO TYPES
// ============================================================================

/**
 * A single frame of audio data from the microphone.
 */
export interface AudioFrame {
  /** PCM audio samples normalized to -1.0 to 1.0 range */
  pcm: Float32Array;
  /** Sample rate in Hz */
  sampleRate: number;
  /** Timestamp in milliseconds when this frame was captured */
  timestamp: number;
}

// ============================================================================
// VAD TYPES
// ============================================================================

/** Possible VAD event types indicating speech activity state */
export type VadEventType = "SPEECH_START" | "SPEECH_CONTINUE" | "SPEECH_END" | "SILENCE";

/**
 * Event emitted by the VAD processor after analyzing an audio frame.
 */
export interface VadEvent {
  /** The detected speech activity state */
  type: VadEventType;
  /** Speech probability from the VAD model (0.0 to 1.0) */
  probability: number;
  /** Timestamp in milliseconds */
  timestamp: number;
}

// ============================================================================
// STT TYPES
// ============================================================================

/**
 * Result from the speech-to-text transcription.
 */
export interface TranscriptionResult {
  /** The transcribed text */
  text: string;
  /** Whether this is a final transcription (always true for batch/offline mode) */
  isFinal: boolean;
  /** Timestamp in milliseconds when transcription completed */
  timestamp: number;
}

// ============================================================================
// ENDPOINTING TYPES
// ============================================================================

/** Method used to determine that the user finished speaking */
export type EndpointMethod = "vad_fast" | "haiku_semantic" | "timeout";

/**
 * Decision from the endpointing module on whether the user has finished speaking.
 */
export interface EndpointDecision {
  /** Whether the user's turn is considered complete */
  isComplete: boolean;
  /** The current accumulated transcript */
  transcript: string;
  /** Which method was used to make the decision */
  method: EndpointMethod;
}

// ============================================================================
// CLAUDE SESSION TYPES
// ============================================================================

/** Possible event types from the Claude streaming response */
export type ClaudeStreamEventType = "text_delta" | "tool_start" | "tool_end" | "result" | "error";

/**
 * Simplified streaming event from the Claude Agent SDK session.
 * Mapped from the raw SDKMessage types for downstream consumption.
 */
export interface ClaudeStreamEvent {
  /** The type of streaming event */
  type: ClaudeStreamEventType;
  /** Text content (for text_delta events) or error message (for error events) */
  content: string;
  /** Tool name (only present for tool_start events) */
  toolName?: string;
}

// ============================================================================
// TTS TEXT CHUNK TYPES
// ============================================================================

/** A text chunk for TTS. Plain string = streaming fragment (buffer it).
 * Object with flush = complete sentence (speak immediately). */
export type TextChunk = string | { text: string; flush: true };

// ============================================================================
// VOICE LOOP STATE
// ============================================================================

/** Possible states of the voice loop state machine */
export type VoiceLoopStatus = "idle" | "listening" | "processing" | "speaking";

/**
 * Current state of the voice loop.
 * Used by the state machine in index.ts.
 */
export interface VoiceLoopState {
  /** Current state of the voice loop */
  status: VoiceLoopStatus;
  /** Active Claude session ID, or null if no session is active */
  sessionId: string | null;
}
