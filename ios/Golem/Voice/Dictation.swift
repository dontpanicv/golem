import AppIntents
import Observation
import UIKit

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

/// Sends a question, with a screenshot and the clipboard, to the Golem thread of the last open workspace, and does not
/// open Golem: the answer comes as a notification. A shortcut gives it the screen: Take Screenshot, Dictate Text,
/// Get Clipboard, then Ask Golem.
struct AskIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Golem"
    static let description = IntentDescription("Sends a question about the screen to the Golem thread.")
    static let supportedModes: IntentModes = .background

    @Parameter(title: "Question") var question: String
    @Parameter(title: "Screenshot", supportedContentTypes: [.image]) var screenshot: IntentFile?
    @Parameter(title: "Clipboard") var clipboard: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Ask Golem \(\.$question) about \(\.$screenshot)") { \.$clipboard }
    }

    @MainActor func perform() async throws -> some IntentResult {
        guard let workspaceID = UserDefaults.standard.string(forKey: Session.Keys.workspaceID) else {
            throw APIError(status: 0, message: "Open Golem and sign in first.")
        }
        let api = APIClient.signedIn()
        let thread = try await api.orchestrator(workspaceID: workspaceID)
        var text = question
        if let clipboard = clipboard?.trimmingCharacters(in: .whitespacesAndNewlines), !clipboard.isEmpty {
            text += "\n\nClipboard (it can be old):\n\(clipboard)"
        }
        var files: [URL] = []
        // A screenshot is a PNG of several megabytes; a JPEG of it is a tenth of that.
        if let screenshot, let jpeg = UIImage(data: screenshot.data)?.jpegData(compressionQuality: 0.8) {
            let url = FileManager.default.temporaryDirectory.appending(path: "Screen.jpg")
            try jpeg.write(to: url)
            files.append(url)
        }
        try await api.sendMessage(threadID: thread.id, text: text, files: files)
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
