/**
 * Processes Claude's streaming output into TTS-friendly text.
 *
 * Two modes of operation:
 * - Response mode: accumulates text_delta events, emits complete sentences at
 *   sentence boundaries (split on `.!?` followed by space or end-of-string).
 * - Long-task mode: emits periodic template-based summaries during tool use
 *   (e.g. "Running Bash...", "Still working on Bash...").
 *
 * Responsibilities:
 * - Accumulate streaming text deltas into a buffer
 * - Split buffered text into complete sentences for natural TTS output
 * - Track tool execution and emit periodic spoken summaries
 * - Flush remaining text on result/error events
 */

import type { ClaudeStreamEvent, NarrationConfig } from "./types.js";

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Narrator instance that processes Claude stream events into speakable text.
 */
export interface Narrator {
  /**
   * Process a single Claude stream event and return any text ready to be spoken.
   * @param event - The Claude stream event to process
   * @returns Array of strings to speak (often empty, sometimes 1-2 sentences)
   */
  processEvent(event: ClaudeStreamEvent): string[];

  /**
   * Flush any remaining buffered text that hasn't been emitted yet.
   * @returns Array of remaining text strings to speak
   */
  flush(): string[];

  /**
   * Reset all internal state for a new conversation turn.
   */
  reset(): void;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Regex to match sentence boundaries: `.`, `!`, or `?` followed by a space or end-of-string */
const SENTENCE_BOUNDARY = /([.!?])(?:\s|$)/;

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Create a new Narrator instance that converts Claude stream events into
 * TTS-friendly sentence chunks.
 * @param config - Narration configuration (summaryIntervalMs controls long-task summary frequency)
 * @returns A Narrator instance
 */
export function createNarrator(config: NarrationConfig): Narrator {
  // -- internal state --
  let textBuffer = "";
  let currentToolName: string | null = null;
  let summaryTimer: NodeJS.Timeout | null = null;
  let pendingSummaries: string[] = [];
  let inLongTask = false;

  /**
   * Process a single Claude stream event.
   * @param event - The streaming event from Claude
   * @returns Array of strings to speak
   */
  function processEvent(event: ClaudeStreamEvent): string[] {
    switch (event.type) {
      case "text_delta":
        return handleTextDelta(event);
      case "tool_start":
        return handleToolStart(event);
      case "tool_end":
        return handleToolEnd();
      case "result":
      case "error":
        return handleTerminal();
      default:
        return [];
    }
  }

  /**
   * Flush any remaining text in the buffer.
   * @returns Array of remaining text strings
   */
  function flush(): string[] {
    const remaining = textBuffer.trim();
    textBuffer = "";
    if (remaining.length > 0) {
      return [remaining];
    }
    return [];
  }

  /**
   * Reset all state for a new conversation turn.
   */
  function reset(): void {
    textBuffer = "";
    currentToolName = null;
    clearSummaryTimer();
    pendingSummaries = [];
    inLongTask = false;
  }

  return { processEvent, flush, reset };

  // ============================================================================
  // HELPER FUNCTIONS
  // ============================================================================

  /**
   * Handle a text_delta event: accumulate text, exit long-task mode,
   * and emit any complete sentences.
   * @param event - The text_delta event
   * @returns Array of complete sentences found in the buffer
   */
  function handleTextDelta(event: ClaudeStreamEvent): string[] {
    // Text arriving means Claude is responding directly -- leave long-task mode
    if (inLongTask) {
      clearSummaryTimer();
      inLongTask = false;
      currentToolName = null;
    }

    textBuffer += event.content;

    // Drain any pending summaries that accumulated from the timer,
    // then append any complete sentences from the text buffer
    const results = drainPendingSummaries();
    const sentences = extractCompleteSentences();
    results.push(...sentences);
    return results;
  }

  /**
   * Handle a tool_start event: enter long-task mode, start the summary timer,
   * and emit an initial "Running {toolName}..." message.
   * @param event - The tool_start event (must have toolName)
   * @returns Array containing the initial tool message
   */
  function handleToolStart(event: ClaudeStreamEvent): string[] {
    const toolName = event.toolName ?? "unknown tool";
    currentToolName = toolName;
    inLongTask = true;

    // Clear any existing timer before starting a new one
    clearSummaryTimer();
    startSummaryTimer();

    const results = drainPendingSummaries();
    results.push(`Running ${toolName}...`);
    return results;
  }

  /**
   * Handle a tool_end event: clear current tool context but stay in long-task
   * mode since more tools might follow.
   * @returns Array of any pending summaries
   */
  function handleToolEnd(): string[] {
    currentToolName = null;
    return drainPendingSummaries();
  }

  /**
   * Handle result or error events: flush all remaining text and reset state.
   * @returns Array of any remaining text and pending summaries
   */
  function handleTerminal(): string[] {
    const results = drainPendingSummaries();
    const remaining = flush();
    results.push(...remaining);

    // Full reset for next turn
    clearSummaryTimer();
    currentToolName = null;
    inLongTask = false;

    return results;
  }

  /**
   * Extract complete sentences from the text buffer.
   * Splits on `.`, `!`, or `?` followed by a space or end-of-string.
   * Keeps any incomplete trailing text in the buffer.
   * @returns Array of complete sentences
   */
  function extractCompleteSentences(): string[] {
    const sentences: string[] = [];

    let match = SENTENCE_BOUNDARY.exec(textBuffer);
    while (match !== null) {
      // Extract everything up to and including the punctuation mark
      const endIndex = match.index + 1;
      const sentence = textBuffer.slice(0, endIndex).trim();
      if (sentence.length > 0) {
        sentences.push(sentence);
      }

      // Keep the remainder (skip the space after punctuation if present)
      const remainderStart = match.index + match[0].length;
      textBuffer = textBuffer.slice(remainderStart);

      match = SENTENCE_BOUNDARY.exec(textBuffer);
    }

    return sentences;
  }

  /**
   * Start the periodic summary timer for long-task mode.
   * Emits "Still working on {toolName}..." at the configured interval.
   */
  function startSummaryTimer(): void {
    summaryTimer = setInterval(() => {
      const name = currentToolName ?? "the task";
      pendingSummaries.push(`Still working on ${name}...`);
    }, config.summaryIntervalMs);
  }

  /**
   * Clear the summary timer if one is active.
   */
  function clearSummaryTimer(): void {
    if (summaryTimer !== null) {
      clearInterval(summaryTimer);
      summaryTimer = null;
    }
  }

  /**
   * Drain all pending summaries from the queue and return them.
   * @returns Array of summary strings that were queued by the timer
   */
  function drainPendingSummaries(): string[] {
    if (pendingSummaries.length === 0) {
      return [];
    }
    const drained = [...pendingSummaries];
    pendingSummaries = [];
    return drained;
  }
}
