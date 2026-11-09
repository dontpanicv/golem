import AuthenticationServices
import CryptoKit
import Foundation
import Observation
import SwiftUI
import Security
import UserNotifications

/// The signed-in user, their workspaces, and the open workspace with its topics.
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
    /// Whether the person is the server's owner, who reads the agents' feedback.
    private(set) var owner = false
    private(set) var workspace: Workspace?
    private(set) var topics: [Topic] = []
    /// The path of each member's profile picture in the open workspace, by person.
    private(set) var pictures: [String: String] = [:]
    /// The open workspace's chat that never ends, which topic lists leave out.
    private(set) var orchestrator: ChatSummary?
    /// The chats of the open workspace whose agent works.
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
        await PlaceWatcher.shared.stop()
        if let token = Push.shared.token { try? await api.removeDevice(token: token) }
        try? await api.signOut()
        clear()
    }

    /// Sends this device's token to Golem, so the person's notifications come to it as pushes.
    func registerDevice() async {
        guard signedIn, let token = Push.shared.token else { return }
        try? await api.addDevice(token: token, environment: Push.environment)
    }

    /// Watches the places of the person's pending reminders and routines at a place in the open workspace
    /// (`PlaceWatcher`).
    func watchPlaces() async {
        guard let workspace, let places = try? await api.watchedPlaces(workspaceID: workspace.id) else { return }
        await PlaceWatcher.shared.watch(places, workspaceID: workspace.id)
    }

    /// Loads the user and the workspaces, then opens the last workspace.
    func load() async {
        do {
            let profile = try await api.me()
            user = profile.user
            workspaces = profile.workspaces
            owner = profile.owner
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
        // A conversation talks in a chat of the workspace that started it.
        if workspace.id != self.workspace?.id { VoiceSession.shared.talk.end() }
        let detail = try await api.workspace(workspace.id)
        let orchestrator = try await api.orchestrator(workspaceID: workspace.id)
        let members = try await api.members(workspaceID: workspace.id)
        self.workspace = detail.workspace
        pictures = Dictionary(uniqueKeysWithValues: members.compactMap { member in
            member.picture.map { (member.userId, $0) }
        })
        topics = detail.topics
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

    /// Follows which chats of the open workspace work, reading the stream again after each error, until cancelled.
    /// The topics and chats load again when work starts or ends, or a chat settles.
    func followWorking() async {
        working = []
        guard let workspace else { return }
        while !Task.isCancelled {
            try? await api.workingEvents(workspaceID: workspace.id) { chatIds in
                Task { try? await reloadWorkspace() }
                working = Set(chatIds)
            }
            try? await Task.sleep(for: .seconds(2))
        }
    }

    /// Makes a JPEG file the person's profile picture, or removes it for nil.
    func setPicture(_ file: URL?) async throws {
        if let file { try await api.uploadPicture(file) } else { try await api.removePicture() }
        user = try await api.me().user
        try await reloadWorkspace()
    }

    func reloadWorkspace() async throws {
        if let workspace { try await open(workspace) }
    }

    /// Adds a topic; a private one only the person sees.
    func createTopic(name: String, isPrivate: Bool) async throws -> Topic? {
        guard let workspace else { return nil }
        let topic = try await api.createTopic(workspaceID: workspace.id, name: name, isPrivate: isPrivate)
        try await reloadWorkspace()
        return topic
    }

    func renameTopic(topicID: String, name: String) async throws {
        guard let workspace else { return }
        _ = try await api.renameTopic(workspaceID: workspace.id, topicID: topicID, name: name)
        try await reloadWorkspace()
    }

    /// Merges a topic into another: its chats, files, artifacts, and routines move there, and the empty topic
    /// goes. Topics are never deleted.
    func mergeTopic(topicID: String, into: String) async throws {
        guard let workspace else { return }
        try await api.mergeTopic(workspaceID: workspace.id, topicID: topicID, into: into)
        try await reloadWorkspace()
    }

    func createChat(topicID: String, text: String, files: [URL]) async throws -> ChatSummary? {
        guard let workspace else { return nil }
        let chat = try await api.createChat(
            workspaceID: workspace.id, topicID: topicID, text: text, files: files
        )
        try await reloadWorkspace()
        return chat
    }

    func setChatSettled(chatID: String, settled: Bool) async throws {
        guard let workspace else { return }
        try await api.setChatSettled(workspaceID: workspace.id, chatID: chatID, settled: settled)
        try await reloadWorkspace()
    }

    /// Moves a chat to another topic, with its artifacts and the files that only it mentions.
    func moveChat(chatID: String, topicID: String) async throws {
        guard let workspace else { return }
        try await api.moveChat(workspaceID: workspace.id, chatID: chatID, topicID: topicID)
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
        topics = []
        pictures = [:]
        orchestrator = nil
        inbox = nil
        loadError = nil
        UNUserNotificationCenter.current().setBadgeCount(0)
    }

    enum Keys {
        static let workspaceID = "workspaceID"
    }
}
