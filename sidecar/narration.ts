/**
 * Processes Claude's streaming output into TTS-friendly text.
 *
 * Two modes of operation:
 * - Response mode: passes text_delta content through immediately for streaming
 *   TTS. Text is buffered into sentences downstream in the TTS module.
 * - Long-task mode: emits periodic template-based summaries during tool use
 *   (e.g. "Running Bash...", "Still working on Bash...").
 *
 * Responsibilities:
 * - Pass through streaming text deltas immediately for low-latency TTS
 * - Track tool execution and emit periodic spoken summaries
 * - Flush remaining text on result/error events
 */

import type { ClaudeStreamEvent, NarrationConfig } from "./types.js";

/** Strip markdown syntax so text reads naturally when spoken. */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*+/g, "")       // bold/italic asterisks
    .replace(/#+\s*/g, "")     // heading markers
    .replace(/`+/g, "")        // inline code / code fences
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) → text
    .replace(/^-\s+/gm, "")   // unordered list markers
    .replace(/^\d+\.\s+/gm, ""); // ordered list markers
}

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
    return [];
  }

  /**
   * Reset all state for a new conversation turn.
   */
  function reset(): void {
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
   * Handle a text_delta event: pass through immediately, exit long-task mode.
   * Text chunking for TTS is handled downstream by TextSplitterStream.
   * @param event - The text_delta event
   * @returns Array containing the delta text (plus any pending summaries)
   */
  function handleTextDelta(event: ClaudeStreamEvent): string[] {
    // Text arriving means Claude is responding directly -- leave long-task mode
    if (inLongTask) {
      clearSummaryTimer();
      inLongTask = false;
      currentToolName = null;
    }

    const results = drainPendingSummaries();
    if (event.content) {
      const clean = stripMarkdown(event.content);
      if (clean) results.push(clean);
    }
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
