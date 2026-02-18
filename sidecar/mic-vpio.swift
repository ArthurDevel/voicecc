/**
 * macOS Voice Processing IO (VPIO) binary for echo-cancelled audio I/O.
 *
 * Uses macOS's built-in acoustic echo cancellation via the VoiceProcessingIO
 * AudioUnit. Routes TTS audio through the VPIO output element so the AEC has
 * a reference signal to subtract from the mic input.
 *
 * VPIO requires the same sample rate on both elements. Internally uses the
 * speaker rate for the AudioUnit, then resamples the mic output to the
 * requested mic rate using AudioConverter before writing to stdout.
 *
 * - stdin:    Raw 16-bit signed mono PCM at speakerRate (TTS audio for playback)
 * - stdout:   Raw 16-bit signed mono PCM at micRate (echo-cancelled mic audio)
 * - SIGUSR1:  Clear playback ring buffer (for interrupting TTS)
 * - SIGTERM:  Clean shutdown
 *
 * Usage: mic-vpio <micRate> <speakerRate>
 *   micRate:     Sample rate for mic output in Hz (e.g. 16000)
 *   speakerRate: Sample rate for speaker input in Hz (e.g. 24000)
 */

import AudioToolbox
import Foundation

// ============================================================================
// CONSTANTS
// ============================================================================

let CHANNELS: UInt32 = 1
let BITS_PER_CHANNEL: UInt32 = 16
let BYTES_PER_FRAME: Int = 2

/// Ring buffer capacity in bytes (~5 seconds at 48kHz mono 16-bit)
let RING_BUFFER_CAPACITY = 48000 * 2 * 5

// ============================================================================
// GLOBALS
// ============================================================================

/// The VPIO AudioUnit instance (global for use in C callbacks)
var gAudioUnit: AudioComponentInstance!

/// Ring buffer for stdin audio -> speaker output
var gRingBuffer: UnsafeMutablePointer<UInt8>!
var gRingCapacity: Int = RING_BUFFER_CAPACITY
var gRingWritePos: Int = 0
var gRingReadPos: Int = 0
var gRingLock = os_unfair_lock()

/// Flag set by SIGUSR1 handler, checked by render callback to clear ring buffer
var gClearRequested: Bool = false

/// Flag set by SIGUSR1, cleared by SIGUSR2. When true, stdin reader discards
/// data instead of writing to ring buffer. This prevents stale pipe data from
/// re-filling the ring buffer after an interrupt clears it.
var gDiscardStdin: Bool = false

/// AudioConverter for resampling mic from vpioRate to micRate (nil if rates match)
var gMicConverter: AudioConverterRef?

/// The requested mic output rate (stdout)
var gMicRate: Double = 16000

/// The VPIO internal rate (= speaker rate)
var gVpioRate: Double = 24000

/// Temporary buffer for resampled mic output
var gResampleBuffer: UnsafeMutablePointer<Int16>?
var gResampleBufferCapacity: Int = 0

/// Leftover samples from the converter that haven't been consumed yet
var gConverterInputBuffer: UnsafeMutablePointer<Int16>?
var gConverterInputFrames: UInt32 = 0

// ============================================================================
// RING BUFFER
// ============================================================================

func ringAvailable() -> Int {
    return (gRingWritePos - gRingReadPos + gRingCapacity) % gRingCapacity
}

func ringFreeSpace() -> Int {
    return gRingCapacity - 1 - ringAvailable()
}

func ringWrite(_ src: UnsafePointer<UInt8>, count: Int) -> Int {
    let space = ringFreeSpace()
    let toWrite = min(count, space)
    for i in 0..<toWrite {
        gRingBuffer[(gRingWritePos + i) % gRingCapacity] = src[i]
    }
    gRingWritePos = (gRingWritePos + toWrite) % gRingCapacity
    return toWrite
}

func ringRead(_ dst: UnsafeMutablePointer<UInt8>, count: Int) -> Int {
    let avail = ringAvailable()
    let toRead = min(count, avail)
    for i in 0..<toRead {
        dst[i] = gRingBuffer[(gRingReadPos + i) % gRingCapacity]
    }
    gRingReadPos = (gRingReadPos + toRead) % gRingCapacity
    return toRead
}

func ringClear() {
    gRingWritePos = 0
    gRingReadPos = 0
}

// ============================================================================
// ENTRY POINT
// ============================================================================

setbuf(stdout, nil)

let args = CommandLine.arguments
guard args.count == 3,
      let micRate = Double(args[1]),
      let speakerRate = Double(args[2]) else {
    fputs("Usage: mic-vpio <micRate> <speakerRate>\n", stderr)
    exit(1)
}

gMicRate = micRate
gVpioRate = speakerRate

// Allocate ring buffer
gRingBuffer = .allocate(capacity: gRingCapacity)
gRingBuffer.initialize(repeating: 0, count: gRingCapacity)

// ============================================================================
// MIC RESAMPLER (vpioRate -> micRate)
// ============================================================================

let needsResampling = (micRate != speakerRate)

if needsResampling {
    var srcFormat = AudioStreamBasicDescription(
        mSampleRate: speakerRate,
        mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
        mBytesPerPacket: UInt32(BYTES_PER_FRAME),
        mFramesPerPacket: 1,
        mBytesPerFrame: UInt32(BYTES_PER_FRAME),
        mChannelsPerFrame: CHANNELS,
        mBitsPerChannel: BITS_PER_CHANNEL,
        mReserved: 0
    )
    var dstFormat = AudioStreamBasicDescription(
        mSampleRate: micRate,
        mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
        mBytesPerPacket: UInt32(BYTES_PER_FRAME),
        mFramesPerPacket: 1,
        mBytesPerFrame: UInt32(BYTES_PER_FRAME),
        mChannelsPerFrame: CHANNELS,
        mBitsPerChannel: BITS_PER_CHANNEL,
        mReserved: 0
    )

    let converterStatus = AudioConverterNew(&srcFormat, &dstFormat, &gMicConverter)
    guard converterStatus == noErr else {
        fputs("ERROR: Failed to create mic resampler \(speakerRate)Hz -> \(micRate)Hz (status \(converterStatus))\n", stderr)
        exit(1)
    }

    // Pre-allocate resampling buffer (enough for 4096 output frames)
    gResampleBufferCapacity = 4096
    gResampleBuffer = .allocate(capacity: gResampleBufferCapacity)
}

// ============================================================================
// VPIO SETUP -- both elements use speakerRate
// ============================================================================

var desc = AudioComponentDescription(
    componentType: kAudioUnitType_Output,
    componentSubType: kAudioUnitSubType_VoiceProcessingIO,
    componentManufacturer: kAudioUnitManufacturer_Apple,
    componentFlags: 0,
    componentFlagsMask: 0
)

guard let component = AudioComponentFindNext(nil, &desc) else {
    fputs("ERROR: Voice Processing IO audio unit not found\n", stderr)
    exit(1)
}

var status = AudioComponentInstanceNew(component, &gAudioUnit)
guard status == noErr else {
    fputs("ERROR: Failed to create VPIO instance (status \(status))\n", stderr)
    exit(1)
}

// Enable input on element 1 (mic)
var enableIO: UInt32 = 1
status = AudioUnitSetProperty(
    gAudioUnit,
    kAudioOutputUnitProperty_EnableIO,
    kAudioUnitScope_Input, 1,
    &enableIO,
    UInt32(MemoryLayout<UInt32>.size)
)
guard status == noErr else {
    fputs("ERROR: Failed to enable mic input (status \(status))\n", stderr)
    exit(1)
}

// Single format used for both elements (VPIO requires same rate)
var vpioFormat = AudioStreamBasicDescription(
    mSampleRate: speakerRate,
    mFormatID: kAudioFormatLinearPCM,
    mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
    mBytesPerPacket: UInt32(BYTES_PER_FRAME),
    mFramesPerPacket: 1,
    mBytesPerFrame: UInt32(BYTES_PER_FRAME),
    mChannelsPerFrame: CHANNELS,
    mBitsPerChannel: BITS_PER_CHANNEL,
    mReserved: 0
)

// Set mic format (output scope of element 1 = what we receive)
status = AudioUnitSetProperty(
    gAudioUnit,
    kAudioUnitProperty_StreamFormat,
    kAudioUnitScope_Output, 1,
    &vpioFormat,
    UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
)
guard status == noErr else {
    fputs("ERROR: Failed to set mic format (status \(status))\n", stderr)
    exit(1)
}

// Set speaker format (input scope of element 0 = what we feed)
status = AudioUnitSetProperty(
    gAudioUnit,
    kAudioUnitProperty_StreamFormat,
    kAudioUnitScope_Input, 0,
    &vpioFormat,
    UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
)
guard status == noErr else {
    fputs("ERROR: Failed to set speaker format (status \(status))\n", stderr)
    exit(1)
}

// ============================================================================
// INPUT CALLBACK (echo-cancelled mic -> resample -> stdout)
// ============================================================================

/// AudioConverter data supplier callback for mic resampling.
/// Provides input samples from the VPIO mic capture buffer.
let converterInputProc: AudioConverterComplexInputDataProc = {
    (_, ioNumberDataPackets, ioData, _, _) -> OSStatus in

    let requestedFrames = ioNumberDataPackets.pointee
    let available = min(requestedFrames, gConverterInputFrames)

    if available == 0 {
        ioNumberDataPackets.pointee = 0
        ioData.pointee.mNumberBuffers = 0
        return 100 // End of data sentinel
    }

    ioData.pointee.mNumberBuffers = 1
    ioData.pointee.mBuffers.mNumberChannels = CHANNELS
    ioData.pointee.mBuffers.mDataByteSize = available * UInt32(BYTES_PER_FRAME)
    ioData.pointee.mBuffers.mData = UnsafeMutableRawPointer(gConverterInputBuffer!)

    ioNumberDataPackets.pointee = available
    gConverterInputFrames = 0 // Consumed all available input

    return noErr
}

var inputCallback = AURenderCallbackStruct(
    inputProc: { (_, ioActionFlags, inTimeStamp, _, inNumberFrames, _) -> OSStatus in
        let byteCount = Int(inNumberFrames) * BYTES_PER_FRAME
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: byteCount)
        defer { buffer.deallocate() }

        var bufferList = AudioBufferList(
            mNumberBuffers: 1,
            mBuffers: AudioBuffer(
                mNumberChannels: CHANNELS,
                mDataByteSize: UInt32(byteCount),
                mData: UnsafeMutableRawPointer(buffer)
            )
        )

        let renderStatus = AudioUnitRender(
            gAudioUnit, ioActionFlags, inTimeStamp, 1, inNumberFrames, &bufferList
        )
        if renderStatus != noErr { return renderStatus }

        // If no resampling needed, write directly to stdout
        if !needsResampling || gMicConverter == nil {
            fwrite(buffer, 1, byteCount, stdout)
            return noErr
        }

        // Resample from vpioRate to micRate
        let inputFrames = inNumberFrames
        let outputFrames = UInt32(Double(inputFrames) * gMicRate / gVpioRate) + 1

        // Ensure resample buffer is large enough
        if Int(outputFrames) > gResampleBufferCapacity {
            gResampleBuffer?.deallocate()
            gResampleBufferCapacity = Int(outputFrames) * 2
            gResampleBuffer = .allocate(capacity: gResampleBufferCapacity)
        }

        // Set up converter input
        gConverterInputBuffer = UnsafeMutableRawPointer(buffer).assumingMemoryBound(to: Int16.self)
        gConverterInputFrames = inputFrames

        var outFrameCount = outputFrames
        var outBufferList = AudioBufferList(
            mNumberBuffers: 1,
            mBuffers: AudioBuffer(
                mNumberChannels: CHANNELS,
                mDataByteSize: outFrameCount * UInt32(BYTES_PER_FRAME),
                mData: UnsafeMutableRawPointer(gResampleBuffer!)
            )
        )

        let convertStatus = AudioConverterFillComplexBuffer(
            gMicConverter!,
            converterInputProc,
            nil,
            &outFrameCount,
            &outBufferList,
            nil
        )

        // 100 = our "end of data" sentinel, not an error
        if convertStatus != noErr && convertStatus != 100 {
            return convertStatus
        }

        let outBytes = Int(outFrameCount) * BYTES_PER_FRAME
        if outBytes > 0 {
            fwrite(gResampleBuffer!, 1, outBytes, stdout)
        }

        return noErr
    },
    inputProcRefCon: nil
)

status = AudioUnitSetProperty(
    gAudioUnit,
    kAudioOutputUnitProperty_SetInputCallback,
    kAudioUnitScope_Global, 0,
    &inputCallback,
    UInt32(MemoryLayout<AURenderCallbackStruct>.size)
)
guard status == noErr else {
    fputs("ERROR: Failed to set input callback (status \(status))\n", stderr)
    exit(1)
}

// ============================================================================
// RENDER CALLBACK (ring buffer -> speakers)
// ============================================================================

var renderCallback = AURenderCallbackStruct(
    inputProc: { (_, _, _, _, inNumberFrames, ioData) -> OSStatus in
        guard let bufferList = ioData else { return noErr }
        let abl = UnsafeMutableAudioBufferListPointer(bufferList)

        for i in 0..<abl.count {
            let byteCount = Int(inNumberFrames) * BYTES_PER_FRAME
            let dest = abl[i].mData!.assumingMemoryBound(to: UInt8.self)

            os_unfair_lock_lock(&gRingLock)

            if gClearRequested {
                ringClear()
                gClearRequested = false
            }

            let bytesRead = ringRead(dest, count: byteCount)
            os_unfair_lock_unlock(&gRingLock)

            // Fill remainder with silence
            if bytesRead < byteCount {
                memset(dest.advanced(by: bytesRead), 0, byteCount - bytesRead)
            }
            abl[i].mDataByteSize = UInt32(byteCount)
        }

        return noErr
    },
    inputProcRefCon: nil
)

status = AudioUnitSetProperty(
    gAudioUnit,
    kAudioUnitProperty_SetRenderCallback,
    kAudioUnitScope_Input, 0,
    &renderCallback,
    UInt32(MemoryLayout<AURenderCallbackStruct>.size)
)
guard status == noErr else {
    fputs("ERROR: Failed to set render callback (status \(status))\n", stderr)
    exit(1)
}

// ============================================================================
// START
// ============================================================================

status = AudioUnitInitialize(gAudioUnit)
guard status == noErr else {
    fputs("ERROR: Failed to initialize VPIO (status \(status))\n", stderr)
    fputs("  This may mean: no microphone is available, mic access was denied,\n", stderr)
    fputs("  or the audio device doesn't support \(speakerRate)Hz.\n", stderr)
    exit(1)
}

status = AudioOutputUnitStart(gAudioUnit)
guard status == noErr else {
    fputs("ERROR: Failed to start VPIO (status \(status))\n", stderr)
    exit(1)
}

fputs("READY\n", stderr)

// ============================================================================
// STDIN READER THREAD (TTS audio -> ring buffer)
// ============================================================================

let stdinThread = Thread {
    let chunkSize = 4096
    let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: chunkSize)
    defer { buf.deallocate() }

    while true {
        let bytesRead = fread(buf, 1, chunkSize, stdin)
        if bytesRead == 0 { break }

        // After SIGUSR1 (interrupt), discard stale pipe data until SIGUSR2 (resume)
        if gDiscardStdin { continue }

        var offset = 0
        while offset < bytesRead {
            // Re-check discard flag inside the write loop in case SIGUSR1 arrives
            // while we're draining a large read into the ring buffer
            if gDiscardStdin { break }

            os_unfair_lock_lock(&gRingLock)
            let written = ringWrite(buf.advanced(by: offset), count: bytesRead - offset)
            os_unfair_lock_unlock(&gRingLock)

            offset += written
            if written == 0 {
                Thread.sleep(forTimeInterval: 0.001)
            }
        }
    }
}
stdinThread.start()

// ============================================================================
// SIGNAL HANDLERS
// ============================================================================

signal(SIGUSR1) { _ in
    gClearRequested = true
    gDiscardStdin = true
}

signal(SIGUSR2) { _ in
    gDiscardStdin = false
}

signal(SIGINT) { _ in exit(0) }
signal(SIGTERM) { _ in exit(0) }

dispatchMain()
