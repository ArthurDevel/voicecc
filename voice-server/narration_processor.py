"""
FrameProcessor that emits spoken updates during tool use and strips markdown from text.

Watches for tool_start markers in TextFrames (emitted by ClaudeLLMService as
"__tool_start:<name>") and announces them as "Running <tool>..." messages.
Emits periodic "Still working..." messages for long-running tools. Strips
markdown syntax from regular text so it reads naturally when spoken.

Responsibilities:
- Detect tool_start markers and emit spoken announcements
- Emit periodic "Still working..." for long-running tools (12s interval)
- Strip markdown syntax (bold, headings, code blocks, links) from text
- Pass all non-text frames through unchanged
"""

import asyncio
import logging
import re

from pipecat.frames.frames import Frame, LLMTextFrame, TextFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

logger = logging.getLogger(__name__)

# ============================================================================
# CONSTANTS
# ============================================================================

TOOL_START_PREFIX = "__tool_start:"
SUMMARY_INTERVAL_SECONDS = 12.0


# ============================================================================
# MAIN HANDLERS
# ============================================================================

class NarrationProcessor(FrameProcessor):
    """Emits spoken updates during tool use and cleans markdown from text."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._current_tool_name: str | None = None
        self._summary_task: asyncio.Task | None = None
        self._in_long_task = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        """Process text frames for tool markers and markdown stripping.

        Args:
            frame: The incoming frame
            direction: Frame direction
        """
        await super().process_frame(frame, direction)

        # Check for tool_start markers from ClaudeLLMService
        if isinstance(frame, TextFrame) and isinstance(frame.text, str):
            if frame.text.startswith(TOOL_START_PREFIX):
                tool_name = frame.text[len(TOOL_START_PREFIX):]
                await self._handle_tool_start(tool_name)
                return

        # Strip markdown from LLM text frames
        if isinstance(frame, LLMTextFrame):
            # Text arriving means Claude is responding -- exit long-task mode
            if self._in_long_task:
                self._cancel_summary_timer()
                self._in_long_task = False
                self._current_tool_name = None

            clean = strip_markdown(frame.text)
            if clean:
                await self.push_frame(LLMTextFrame(clean))
            return

        await self.push_frame(frame, direction)

    async def cleanup(self):
        """Cancel any running summary timer on cleanup."""
        self._cancel_summary_timer()
        await super().cleanup()

    # ============================================================================
    # HELPER FUNCTIONS
    # ============================================================================

    async def _handle_tool_start(self, tool_name: str) -> None:
        """Handle a tool_start event: announce it and start the summary timer.

        Args:
            tool_name: Name of the tool being executed
        """
        self._current_tool_name = tool_name
        self._in_long_task = True

        self._cancel_summary_timer()
        self._start_summary_timer()

        # Emit spoken announcement
        await self.push_frame(LLMTextFrame(f"Running {tool_name}..."))
        logger.info(f"[narration] Tool started: {tool_name}")

    def _start_summary_timer(self) -> None:
        """Start periodic 'Still working...' announcements."""
        async def _emit_summaries():
            while True:
                await asyncio.sleep(SUMMARY_INTERVAL_SECONDS)
                name = self._current_tool_name or "the task"
                try:
                    await self.push_frame(LLMTextFrame(f"Still working on {name}..."))
                except Exception:
                    break

        self._summary_task = asyncio.create_task(_emit_summaries())

    def _cancel_summary_timer(self) -> None:
        """Cancel the summary timer if active."""
        if self._summary_task and not self._summary_task.done():
            self._summary_task.cancel()
            self._summary_task = None


def strip_markdown(text: str) -> str:
    """Strip markdown syntax so text reads naturally when spoken.

    Removes bold/italic asterisks, heading markers, code fences,
    inline code backticks, markdown links, and list markers.

    Args:
        text: Raw markdown text

    Returns:
        Cleaned text suitable for TTS
    """
    text = re.sub(r"\*+", "", text)                         # bold/italic asterisks
    text = re.sub(r"#+\s*", "", text)                       # heading markers
    text = re.sub(r"`+", "", text)                          # inline code / code fences
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)   # [text](url) -> text
    text = re.sub(r"^-\s+", "", text, flags=re.MULTILINE)  # unordered list markers
    text = re.sub(r"^\d+\.\s+", "", text, flags=re.MULTILINE)  # ordered list markers
    return text
