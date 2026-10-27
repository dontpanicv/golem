import CoreML
import FluidAudio
import Foundation

/// Parakeet Ultra (CC-BY-4.0), the dictation model: Moondream's post-training of NVIDIA's Parakeet TDT 0.6B v3, in 25
/// European languages, Czech and English among them, which it tells apart by itself. FluidInference's Core ML package,
/// run by FluidAudio (Apache-2.0) on the Neural Engine. The model (~630 MB) is in the app bundle
/// (ios/scripts/fetch-parakeet.sh); it loads when the app starts and stays loaded.
actor Parakeet {
    static let shared = Parakeet()

    /// Audio it takes: 16 kHz mono.
    nonisolated static let sampleRate = 16_000.0
    nonisolated static let directory = Bundle.main.url(forResource: "Parakeet", withExtension: nil)
    nonisolated static var isBundled: Bool { directory != nil }

    private var manager: AsrManager?
    private var loading: Task<AsrManager, Error>?

    /// Loads the model. The first load after an install takes longer, while Core ML prepares it for the Neural Engine.
    @discardableResult
    func load() async throws -> AsrManager {
        if let manager { return manager }
        if let loading { return try await loading.value }
        guard let directory = Self.directory else {
            throw VoiceError(
                "This build of Golem doesn't include Parakeet (run ios/scripts/fetch-parakeet.sh).")
        }
        let task = Task {
            let models = try AsrModels.loadLocal(from: directory, version: .ultra)
            return AsrManager(models: models)
        }
        loading = task
        defer { loading = nil }
        let manager = try await task.value
        self.manager = manager
        return manager
    }

    /// The text of 16 kHz mono samples, with punctuation and capitals.
    func transcribe(_ samples: [Float]) async throws -> String {
        // Under a quarter second is nothing to transcribe (and the model wants at least a second, padded).
        guard samples.count > Int(Self.sampleRate / 4) else { return "" }
        let manager = try await load()
        let second = Int(Self.sampleRate)
        let padded = samples.count < second ? samples + [Float](repeating: 0, count: second - samples.count) : samples
        var state = try TdtDecoderState()
        let result = try await manager.transcribe(padded, decoderState: &state)
        return result.text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
