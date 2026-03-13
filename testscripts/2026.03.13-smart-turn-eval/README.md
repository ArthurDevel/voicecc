# Smart Turn v3.2 -- Live Evaluation

Real-time mic test for Pipecat Smart Turn end-of-turn detection.
Captures audio, runs Silero VAD for speech segmentation, then feeds
each speech segment to Smart Turn to predict "complete" vs "incomplete".

## Setup

```bash
cd testscripts/2026.03.13-smart-turn-eval
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python download_model.py
```

## Run

```bash
python test_smart_turn_live.py
```

Speak into your mic. After each pause, you'll see whether Smart Turn
thinks you're done or still mid-thought.

## What to test

- Pause mid-sentence ("I want to...") -- should predict Incomplete
- Finish a thought ("Tell me about the weather.") -- should predict Complete
- Short utterances ("yes", "okay") -- check what it predicts
- Long pauses between clauses ("So first we need to... and then...") -- should stay Incomplete
