"""
FrameProcessor that detects "stop listening" in transcriptions and ends the pipeline.

Listens for TranscriptionFrame events. If the transcribed text contains
"stop listening" (case-insensitive), pushes an EndFrame to terminate the session.
Otherwise, passes the frame through unchanged.

Responsibilities:
- Detect "stop listening" phrase in user transcriptions
- Push EndFrame to cleanly shut down the pipeline
- Pass all other frames through unchanged
"""

import logging

from pipecat.frames.frames import EndFrame, Frame, TranscriptionFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

logger = logging.getLogger(__name__)

STOP_PHRASE = "stop listening"


# ============================================================================
# MAIN HANDLERS
# ============================================================================

class StopPhraseProcessor(FrameProcessor):
    """Detects 'stop listening' in transcriptions and ends the pipeline."""

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        """Check transcription frames for the stop phrase.

        If detected, pushes an EndFrame to terminate the pipeline.
        Otherwise, passes the frame through.

        Args:
            frame: The incoming frame
            direction: Frame direction
        """
        await super().process_frame(frame, direction)

        if isinstance(frame, TranscriptionFrame):
            text = frame.text.lower().strip()
            if STOP_PHRASE in text:
                logger.info("[stop-phrase] 'stop listening' detected, ending pipeline")
                await self.push_frame(EndFrame())
                return

        await self.push_frame(frame, direction)
