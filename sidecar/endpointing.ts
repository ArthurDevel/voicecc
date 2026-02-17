/**
 * Endpointing module -- determines when the user is done speaking.
 *
 * Uses a two-tier approach to decide turn completion:
 * - Fast path: VAD silence duration + sufficient word count (0ms latency)
 * - Slow path: Haiku semantic check for short/ambiguous utterances (~200ms)
 * - Timeout path: Forces completion after extended silence regardless of content
 *
 * Responsibilities:
 * - Track silence duration from VAD events
 * - Apply fast-path completion for longer utterances
 * - Call Haiku API for semantic turn-completion on short utterances
 * - Force timeout after extended silence
 * - Reset state between turns
 */

import Anthropic from "@anthropic-ai/sdk";
import type { EndpointDecision, EndpointingConfig, VadEvent } from "./types.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const HAIKU_MAX_TOKENS = 10;

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Endpointer that processes VAD events and decides when the user is done speaking.
 */
export interface Endpointer {
  /**
   * Process a VAD event and determine if the user's turn is complete.
   * @param event - The VAD event from the voice activity detector
   * @param currentTranscript - The accumulated transcript so far
   * @returns Decision on whether the user has finished speaking
   */
  onVadEvent(event: VadEvent, currentTranscript: string): Promise<EndpointDecision>;

  /**
   * Reset internal state for a new turn.
   */
  reset(): void;
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Create an endpointer instance with the given configuration.
 * @param config - Endpointing thresholds and feature flags
 * @returns A configured Endpointer
 */
export function createEndpointer(config: EndpointingConfig): Endpointer {
  const anthropicClient = config.enableHaikuFallback ? new Anthropic() : null;

  return {
    onVadEvent(event: VadEvent, currentTranscript: string): Promise<EndpointDecision> {
      return handleVadEvent(event, currentTranscript, config, anthropicClient);
    },

    reset(): void {
      // No internal state to reset -- completion is evaluated per SPEECH_END event.
    },
  };
}

// ============================================================================
// MAIN LOGIC
// ============================================================================

/**
 * Handle a single VAD event and produce an endpoint decision.
 * @param event - The VAD event to process
 * @param transcript - Current accumulated transcript
 * @param config - Endpointing configuration
 * @param client - Anthropic client for Haiku calls (null if disabled)
 * @returns The endpoint decision
 */
async function handleVadEvent(
  event: VadEvent,
  transcript: string,
  config: EndpointingConfig,
  client: Anthropic | null,
): Promise<EndpointDecision> {
  // Active speech -- not complete
  if (event.type === "SPEECH_START" || event.type === "SPEECH_CONTINUE") {
    return { isComplete: false, transcript, method: "vad_fast" };
  }

  // Speech ended -- evaluate completion immediately.
  // avr-vad's SPEECH_END fires after internal debouncing (redemptionFrames),
  // so silence has already been confirmed by the VAD. No need to wait for
  // separate SILENCE events (avr-vad doesn't emit them).
  if (event.type === "SPEECH_END") {
    const wordCount = countWords(transcript);

    // Fast path: sufficient words, complete immediately
    if (wordCount >= config.minWordCountForFastPath) {
      return { isComplete: true, transcript, method: "vad_fast" };
    }

    // Short utterance: ask Haiku for semantic turn-completion check
    if (config.enableHaikuFallback && client !== null) {
      const isComplete = await checkTurnCompletionWithHaiku(client, transcript);
      return { isComplete, transcript, method: "haiku_semantic" };
    }

    // Haiku disabled, treat as complete
    return { isComplete: true, transcript, method: "vad_fast" };
  }

  // Unknown event type -- not complete
  return { isComplete: false, transcript, method: "vad_fast" };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Count the number of words in a transcript string.
 * @param text - The transcript text
 * @returns Number of whitespace-separated words
 */
function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  return trimmed.split(/\s+/).length;
}

/**
 * Call Haiku to determine if a short transcript represents a complete user turn.
 * @param client - The Anthropic SDK client
 * @param transcript - The short transcript to evaluate
 * @returns True if Haiku considers the turn complete
 */
async function checkTurnCompletionWithHaiku(client: Anthropic, transcript: string): Promise<boolean> {
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: HAIKU_MAX_TOKENS,
    messages: [
      {
        role: "user",
        content: `Is this a complete user turn? Answer only "yes" or "no".\n\nTranscript: "${transcript}"`,
      },
    ],
  });

  const firstBlock = response.content[0];
  if (firstBlock.type !== "text") {
    throw new Error(`Unexpected Haiku response block type: ${firstBlock.type}`);
  }

  const answer = firstBlock.text.trim().toLowerCase();
  return answer.startsWith("yes");
}
