import Intents

/// Sends a reply that a person speaks to Siri, after Siri reads a message from Golem aloud on AirPods or in CarPlay, to
/// the chat of that message: its conversation (`NotificationService`).
nonisolated final class SiriReply: NSObject, INSendMessageIntentHandling {
    func resolveContent(for intent: INSendMessageIntent) async -> INStringResolutionResult {
        guard let text = intent.content, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .needsValue()
        }
        return .success(with: text)
    }

    func handle(intent: INSendMessageIntent) async -> INSendMessageIntentResponse {
        guard let chatID = intent.conversationIdentifier, let text = intent.content else {
            return INSendMessageIntentResponse(code: .failure, userActivity: nil)
        }
        do {
            try await Self.send(chatID: chatID, text: text)
            return INSendMessageIntentResponse(code: .success, userActivity: nil)
        } catch {
            return INSendMessageIntentResponse(code: .failureRequiringAppLaunch, userActivity: nil)
        }
    }

    @MainActor private static func send(chatID: String, text: String) async throws {
        try await APIClient.signedIn().sendMessage(chatID: chatID, text: text, files: [])
    }
}
