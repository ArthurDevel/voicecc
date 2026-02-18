# Voice Pipeline Sequence Diagram

TTS runs as a persistent Python child process (`tts-server.py`) spawned once at startup. The Kokoro-82M model is loaded onto the Apple Silicon GPU via mlx-audio and stays in memory for the entire session. Node.js (`tts.ts`) communicates with it over stdio pipes — JSON commands on stdin, length-prefixed binary PCM on stdout. No HTTP server or network involved.

```mermaid
sequenceDiagram
    participant User
    participant Mic as sox (Microphone)
    participant Index as index.ts (Event Loop)
    participant VAD as avr-vad (Silero VAD v5)
    participant STT as sherpa-onnx (Whisper)
    participant EP as Endpointer
    participant Claude as Claude Session (SDK)
    participant API as Claude Code / Anthropic API
    participant Narrator as Narrator
    participant TTS as tts.ts (Node.js)
    participant Py as tts-server.py (MLX GPU)
    participant Speaker as Speaker (Audio Out)

    Note over Index: Initialization
    Index->>Claude: 1. createClaudeSession() — spawn persistent process
    Index->>TTS: 2. createTts() — spawn tts-server.py subprocess
    TTS->>Py: spawn(python3 tts-server.py model voice)
    Note over Py: Load Kokoro-82M via mlx-audio<br/>on Apple Silicon GPU
    Note over Py: Warm-up generation
    Py-->>TTS: stderr: "READY"
    Index->>VAD: 3. createVad() — dynamic import avr-vad
    Index->>STT: 4. createStt() — dynamic import sherpa-onnx-node
    Index->>EP: 5. createEndpointer()
    Index->>Narrator: 6. createNarrator()
    Index->>Mic: 7. startCapture(16kHz, mono, 16-bit PCM)
    Note over Index: State: LISTENING

    rect rgb(230, 245, 255)
        Note over User, Speaker: Voice Capture + VAD
        User->>Mic: Speaks
        loop Every audio chunk
            Mic->>Index: raw 16-bit PCM buffer (stdout pipe)
            Index->>Index: bufferToFloat32(buffer)
            Index->>VAD: processAudio(Float32Array)
        end

        VAD-->>Index: SPEECH_START callback
        Note over Index: accumulating = true

        loop While user speaks
            Mic->>Index: audio chunk
            Index->>Index: bufferToFloat32(buffer)
            Index->>STT: accumulate(Float32Array)
            Index->>VAD: processAudio(Float32Array)
        end

        VAD-->>Index: SPEECH_CONTINUE callback
        Note over VAD: Sustained speech confirmed

        User->>Mic: Stops speaking
        VAD-->>Index: SPEECH_END callback (after redemption debounce)
        Note over Index: accumulating = false
    end

    rect rgb(255, 245, 230)
        Note over User, Speaker: Transcription + Endpointing
        Index->>STT: transcribe()
        Note over STT: Concatenate accumulated chunks,<br/>create offline stream,<br/>decode via Whisper ONNX
        STT-->>Index: TranscriptionResult { text, isFinal: true }

        Index->>EP: onVadEvent(SPEECH_END, transcript)
        alt Word count >= 2 (fast path)
            EP-->>Index: { isComplete: true } (0ms)
        else Word count < 2, Haiku disabled (current default)
            EP-->>Index: { isComplete: true } (0ms)
        end
    end

    rect rgb(230, 255, 230)
        Note over User, Speaker: Claude Processing + Streaming Response
        Note over Index: Check for "stop listening" stop phrase
        Note over Index: State: PROCESSING

        Index->>Claude: sendMessage(transcript)
        Claude->>Claude: Push SDKUserMessage into AsyncQueue
        Claude->>API: Forward to persistent Claude Code process (stdio IPC)
        API-->>Claude: Streaming SDK events

        par Streaming response processing
            loop For each SDK event
                Claude-->>Index: ClaudeStreamEvent (text_delta / tool_start / tool_end / result)
                Index->>Narrator: processEvent(event)

                alt text_delta
                    Narrator-->>Index: stripMarkdown(content) — yield text immediately
                else tool_start
                    Narrator-->>Index: "Running {toolName}..."
                    Note over Narrator: Start 12s interval timer
                    loop Every 12s while tool runs
                        Narrator-->>Index: "Still working on {toolName}..."
                    end
                else tool_end
                    Narrator-->>Index: Drain pending summaries
                else result
                    Narrator-->>Index: Final flush
                end

                Index->>TTS: yield text chunk into textChunks() generator
            end
        and Sentence buffering + TTS generation + playback
            loop For each sentence from bufferSentences()
                Note over TTS: Buffer text deltas into sentences<br/>(split on .!? + whitespace, min 20 chars)
                TTS->>Py: stdin: {"cmd":"generate","text":"..."}
                Note over Py: model.generate(text, voice, stream=True)<br/>via MLX on Apple Silicon GPU (~8x realtime)
                loop For each audio chunk from model
                    Py->>TTS: stdout: [4-byte uint32 BE length][raw int16 PCM at 24kHz]
                end
                Py->>TTS: stdout: [4-byte 0x00000000] (end marker)
                TTS->>Speaker: write(PCM buffer)
                Note over Speaker: First chunk: cork/write/uncork<br/>to prevent CoreAudio race
                Speaker->>User: Audio playback
            end
        end

        Note over Index: State: SPEAKING (after first audio chunk)
    end

    rect rgb(255, 230, 230)
        Note over User, Speaker: Interruption Detection (during SPEAKING/PROCESSING)
        Note over Index: Mic stays active — VAD keeps processing

        User->>Mic: Speaks over assistant
        Mic->>Index: audio chunk
        Index->>VAD: processAudio(Float32Array)
        VAD-->>Index: SPEECH_START
        Note over Index: Record speechStartDuringSpeaking timestamp
        VAD-->>Index: SPEECH_CONTINUE
        Note over Index: Sustained > 800ms?

        alt Speech sustained >= 800ms
            Index->>TTS: interrupt()
            TTS->>Py: stdin: {"cmd":"interrupt"}
            TTS->>Speaker: destroy Speaker
            Index->>Claude: interrupt() — cancel token generation
            Index->>STT: clearBuffer()
            Note over Index: State: LISTENING (loop back)
        else Speech < 800ms
            Note over Index: False alarm — ignore
        end
    end

    Speaker-->>Index: Playback complete (if not interrupted)
    Note over Index: State: LISTENING
    Note over Index: Ready for next utterance
```
