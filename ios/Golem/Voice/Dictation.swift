import AppIntents
import Observation

/// A request to dictate a message to the open workspace's Golem thread, from the Action button, Siri, or Shortcuts.
/// The shell takes it once the Golem thread is loaded and opens the thread, and its composer starts listening.
@Observable
final class Dictation {
    static let shared = Dictation()

    var requested = false
    /// The thread whose composer starts listening, until it does.
    var thread: String?

    /// Takes the request for the Golem thread `orchestrator`; true when there was one.
    func take(for orchestrator: String?) -> Bool {
        guard requested, let orchestrator else { return false }
        requested = false
        thread = orchestrator
        return true
    }
}

/// Opens Golem and dictates to the Golem thread. Set the Action button to Shortcut › Golem › Dictate to Golem.
struct DictateIntent: AppIntent {
    static let title: LocalizedStringResource = "Dictate to Golem"
    static let description = IntentDescription("Opens the Golem thread and listens.")
    static let supportedModes: IntentModes = .foreground

    @MainActor func perform() async throws -> some IntentResult {
        Dictation.shared.requested = true
        return .result()
    }
}

struct GolemShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: DictateIntent(),
            phrases: ["Dictate to \(.applicationName)", "Message \(.applicationName)"],
            shortTitle: "Dictate to Golem",
            systemImageName: "mic"
        )
    }
}
