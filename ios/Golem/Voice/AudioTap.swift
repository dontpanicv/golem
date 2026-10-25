import AVFoundation
import Foundation

/// Audio taps run on a real-time audio queue, and so does what they do with the audio. A closure written inside
/// main-actor code would inherit main-actor isolation and trap there ("dispatch_assert_queue"), so tap blocks are made
/// here, outside any actor.
nonisolated enum AudioTap {
    static func block(_ handle: @escaping @Sendable (AVAudioPCMBuffer) -> Void) -> AVAudioNodeTapBlock {
        { buffer, _ in handle(buffer) }
    }

    static func completion(_ handle: @escaping @Sendable () -> Void) -> AVAudioNodeCompletionHandler {
        { handle() }
    }

    static func played(
        _ handle: @escaping @Sendable () -> Void
    ) -> @Sendable (AVAudioPlayerNodeCompletionCallbackType) -> Void {
        { _ in handle() }
    }

    /// The samples of a microphone buffer in `format`, converted when the microphone records in another one.
    static func samples(
        of buffer: AVAudioPCMBuffer, in format: AVAudioFormat, converter: inout AVAudioConverter?
    ) -> [Float]? {
        var output = buffer
        if buffer.format != format {
            if converter?.inputFormat != buffer.format { converter = AVAudioConverter(from: buffer.format, to: format) }
            guard let converter else { return nil }
            let capacity = AVAudioFrameCount(
                Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate + 32)
            guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
            var fed = false
            var error: NSError?
            converter.convert(to: converted, error: &error) { _, status in
                if fed { status.pointee = .noDataNow; return nil }
                fed = true
                status.pointee = .haveData
                return buffer
            }
            guard error == nil else { return nil }
            output = converted
        }
        guard let channel = output.floatChannelData?[0] else { return nil }
        return Array(UnsafeBufferPointer(start: channel, count: Int(output.frameLength)))
    }

    static func rms(_ buffer: AVAudioPCMBuffer) -> Double {
        guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        var sum: Float = 0
        for index in 0..<Int(buffer.frameLength) { sum += channel[index] * channel[index] }
        return Double(sqrt(sum / Float(buffer.frameLength)))
    }

    /// A short, quiet cue at `frequency`: the microphone is on, or the words went to Golem.
    static func tone(frequency: Double, format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let count = Int(format.sampleRate * 0.06)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
            let samples = buffer.floatChannelData?[0]
        else { return nil }
        for frame in 0..<count {
            // A raised-cosine envelope: no clicks at either end.
            let envelope = 0.5 - 0.5 * cos(2 * Double.pi * Double(frame) / Double(count))
            samples[frame] = Float(sin(2 * Double.pi * frequency * Double(frame) / format.sampleRate) * envelope * 0.12)
        }
        buffer.frameLength = AVAudioFrameCount(count)
        return buffer
    }
}
