import Foundation

/// The phone's dictation and conversation: one for the app, as there is one microphone and one speaker. A
/// conversation outlives the screen that started it, and goes on with the screen locked.
final class VoiceSession {
    static let shared = VoiceSession()

    let listener = Listener()
    private(set) lazy var talk = VoiceChat(listener: listener)
}

/// A failure of the microphone, a voice model, or a conversation, in words for the user.
nonisolated struct VoiceError: LocalizedError {
    let errorDescription: String?

    init(_ message: String) { errorDescription = message }
}
