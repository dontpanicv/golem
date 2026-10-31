import AuthenticationServices
import CryptoKit
import Foundation
import Observation
import SwiftUI
import Security
import UserNotifications

/// The signed-in user, their workspaces, and the open workspace with its channels.
@Observable
final class Session {
    let api = APIClient()
    var serverURL: String {
        didSet {
            Keychain.serverURL = serverURL
            api.baseURL = serverURL
        }
    }
    private(set) var signedIn: Bool
    private(set) var user: User?
    private(set) var workspaces: [Workspace] = []
    private(set) var workspace: Workspace?
    private(set) var channels: [Channel] = []
    /// The open workspace's thread that never ends, which channel lists leave out.
    private(set) var orchestrator: ThreadSummary?
    /// The threads of the open workspace whose agent works.
    private(set) var working: Set<String> = []
    /// The open workspace's notifications.
    private(set) var inbox: Inbox?
    /// The last failure of `load()`, shown with a retry button while no user is loaded.
    private(set) var loadError: String?
    /// The toast at the top of the screen: the last failure of an action, or a confirmation.
    var toast: Toast?
    /// Open dialogs, which show the toast above their dimmed backdrop.
    var dialogs = 0

    init() {
        let serverURL = Keychain.serverURL
            ?? Bundle.main.object(forInfoDictionaryKey: "GolemServerURL") as? String ?? ""
        let token = Keychain.token
        self.serverURL = serverURL
        signedIn = token != nil
        api.baseURL = serverURL
        api.token = token
        api.onUnauthorized = { [weak self] in self?.clear() }
    }

    // MARK: Session

    /// Signs in with Google in `browser`, a web authentication session. `RootView` then calls `load()`.
    ///
    /// The session ends on the server's https address, which only this app gets (associated domains), with a one-time
    /// code that gives the token only with this sign-in's verifier (PKCE).
    func signIn(_ browser: WebAuthenticationSession) async throws {
        let verifier = Self.newVerifier()
        let url = try api.googleSignInURL(challenge: Self.challenge(for: verifier))
        guard url.scheme == "https", let host = url.host() else {
            throw APIError(status: 0, message: "Sign-in needs the server's https address.")
        }
        let callback = try await browser.authenticate(
            using: url,
            callback: .https(host: host, path: "/api/v1/sign-in/google/signed-in"),
            preferredBrowserSession: .ephemeral,
            additionalHeaderFields: [:]
        )
        let query = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard let code = query.first(where: { $0.name == "code" })?.value else {
            throw APIError(status: 0, message: query.first(where: { $0.name == "error" })?.value ?? "Sign-in failed")
        }
        let token = try await api.signInToken(code: code, verifier: verifier)
        Keychain.token = token
        api.token = token
        signedIn = true
    }

    /// The base64url SHA-256 of a verifier, as RFC 7636 makes the challenge.
    static func challenge(for verifier: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    /// 32 random bytes, as base64url: the secret that only this sign-in knows.
    private static func newVerifier() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return base64URL(Data(bytes))
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    func signOut() async {
        if let token = Push.shared.token { try? await api.removeDevice(token: token) }
        try? await api.signOut()
        clear()
    }

    /// Sends this device's token to Golem, so the person's notifications come to it as pushes.
    func registerDevice() async {
        guard signedIn, let token = Push.shared.token else { return }
        try? await api.addDevice(token: token, environment: Push.environment)
    }

    /// Loads the user and the workspaces, then opens the last workspace.
    func load() async {
        do {
            let profile = try await api.me()
            user = profile.user
            workspaces = profile.workspaces
            loadError = nil
            let last = UserDefaults.standard.string(forKey: Keys.workspaceID)
            if let workspace = profile.workspaces.first(where: { $0.id == last }) ?? profile.workspaces.first {
                try await open(workspace)
            }
            await Push.register()
        } catch {
            guard signedIn else { return }
            if user == nil { loadError = error.localizedDescription } else { show(error.localizedDescription, .error) }
        }
    }

    // MARK: Workspaces

    func open(_ workspace: Workspace) async throws {
        // A conversation talks in a thread of the workspace that started it.
        if workspace.id != self.workspace?.id { VoiceSession.shared.talk.end() }
        let detail = try await api.workspace(workspace.id)
        let orchestrator = try await api.orchestrator(workspaceID: workspace.id)
        self.workspace = detail.workspace
        channels = detail.channels
        self.orchestrator = orchestrator
        UserDefaults.standard.set(workspace.id, forKey: Keys.workspaceID)
        try? await loadInbox()
    }

    // MARK: Notifications

    /// Loads the open workspace's notifications, and shows the unread ones of every workspace on the app icon.
    func loadInbox() async throws {
        guard let workspace else { return }
        update(try await api.inbox(workspaceID: workspace.id))
    }

    /// Marks one notification read, or all of the open workspace's for a nil `id`.
    func readNotifications(_ id: String?) async throws {
        guard let workspace else { return }
        update(try await api.readNotifications(workspaceID: workspace.id, id: id))
    }

    /// The screen of the push the person tapped, once its workspace is open; it opens that workspace first, and the
    /// change of workspace asks again.
    func takeTapped() -> Destination? {
        guard let tapped = Push.shared.tapped, let workspace else { return nil }
        if tapped.workspaceID == workspace.id {
            Push.shared.tapped = nil
            return tapped.destination
        }
        if let other = workspaces.first(where: { $0.id == tapped.workspaceID }) {
            Task { await run { try await open(other) } }
        } else {
            Push.shared.tapped = nil
        }
        return nil
    }

    private func update(_ inbox: Inbox) {
        self.inbox = inbox
        UNUserNotificationCenter.current().setBadgeCount(inbox.badge)
    }

    func renameWorkspace(name: String) async throws {
        guard let workspace else { return }
        let renamed = try await api.renameWorkspace(workspace.id, name: name)
        self.workspace = renamed
        workspaces = workspaces.map { $0.id == renamed.id ? renamed : $0 }
    }

    /// Follows which threads of the open workspace work, reading the stream again after each error, until cancelled.
    /// The channels and threads load again when work starts or ends.
    func followWorking() async {
        working = []
        guard let workspace else { return }
        while !Task.isCancelled {
            try? await api.workingEvents(workspaceID: workspace.id) { threadIds in
                // Agents start threads and channels as they work: the lists load again when work starts or ends.
                if !working.isEmpty || !threadIds.isEmpty { Task { try? await reloadWorkspace() } }
                working = Set(threadIds)
            }
            try? await Task.sleep(for: .seconds(2))
        }
    }

    func reloadWorkspace() async throws {
        if let workspace { try await open(workspace) }
    }

    /// Adds a channel; a private one only the person sees.
    func createChannel(name: String, isPrivate: Bool) async throws -> Channel? {
        guard let workspace else { return nil }
        let channel = try await api.createChannel(workspaceID: workspace.id, name: name, isPrivate: isPrivate)
        try await reloadWorkspace()
        return channel
    }

    /// Deletes a channel with its threads and routines; the server keeps them, hidden.
    func deleteChannel(channelID: String) async throws {
        guard let workspace else { return }
        try await api.deleteChannel(workspaceID: workspace.id, channelID: channelID)
        try await reloadWorkspace()
    }

    func createThread(channelID: String, text: String, files: [URL]) async throws -> ThreadSummary? {
        guard let workspace else { return nil }
        let thread = try await api.createThread(
            workspaceID: workspace.id, channelID: channelID, text: text, files: files
        )
        try await reloadWorkspace()
        return thread
    }

    func setThreadSettled(threadID: String, settled: Bool) async throws {
        guard let workspace else { return }
        try await api.setThreadSettled(workspaceID: workspace.id, threadID: threadID, settled: settled)
        try await reloadWorkspace()
    }

    /// Runs an action and shows its error in a toast.
    func run(_ action: () async throws -> Void) async {
        do { try await action() } catch is CancellationError {} catch URLError.cancelled {} catch {
            if (error as? APIError)?.status != 401 { show(error.localizedDescription, .error) }
        }
    }

    func show(_ message: String, _ tone: Toast.Tone = .neutral) {
        toast = Toast(message: message, tone: tone)
    }

    private func clear() {
        VoiceSession.shared.talk.end()
        Keychain.token = nil
        api.token = nil
        signedIn = false
        user = nil
        workspaces = []
        workspace = nil
        channels = []
        orchestrator = nil
        inbox = nil
        loadError = nil
        UNUserNotificationCenter.current().setBadgeCount(0)
    }

    enum Keys {
        static let workspaceID = "workspaceID"
    }
}
