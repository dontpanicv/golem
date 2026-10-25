import AuthenticationServices
import Foundation
import Observation
import SwiftUI
import Security

/// The signed-in user, their workspaces, and the open workspace with its channels.
@Observable
final class Session {
    let api = APIClient()
    var serverURL: String {
        didSet {
            UserDefaults.standard.set(serverURL, forKey: Keys.serverURL)
            api.baseURL = serverURL
        }
    }
    private(set) var signedIn: Bool
    private(set) var user: User?
    private(set) var workspaces: [Workspace] = []
    private(set) var workspace: Workspace?
    private(set) var channels: [Channel] = []
    /// The last failure of `load()`, shown with a retry button while no user is loaded.
    private(set) var loadError: String?
    /// The toast at the top of the screen: the last failure of an action, or a confirmation.
    var toast: Toast?
    /// Open dialogs, which show the toast above their dimmed backdrop.
    var dialogs = 0

    init() {
        let serverURL = UserDefaults.standard.string(forKey: Keys.serverURL)
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
    func signIn(_ browser: WebAuthenticationSession) async throws {
        let callback = try await browser.authenticate(
            using: api.googleSignInURL(), callbackURLScheme: "golem", preferredBrowserSession: .ephemeral
        )
        let query = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard let token = query.first(where: { $0.name == "token" })?.value else {
            throw APIError(status: 0, message: query.first(where: { $0.name == "error" })?.value ?? "Sign-in failed")
        }
        Keychain.token = token
        api.token = token
        signedIn = true
    }

    func signOut() async {
        try? await api.signOut()
        clear()
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
        } catch {
            guard signedIn else { return }
            if user == nil { loadError = error.localizedDescription } else { show(error.localizedDescription, .error) }
        }
    }

    // MARK: Workspaces

    func open(_ workspace: Workspace) async throws {
        let detail = try await api.workspace(workspace.id)
        self.workspace = detail.workspace
        channels = detail.channels
        UserDefaults.standard.set(workspace.id, forKey: Keys.workspaceID)
    }

    func createWorkspace(name: String) async throws {
        let workspace = try await api.createWorkspace(name: name)
        workspaces.append(workspace)
        try await open(workspace)
    }

    func reloadWorkspace() async throws {
        if let workspace { try await open(workspace) }
    }

    func createChannel(name: String) async throws -> Channel? {
        guard let workspace else { return nil }
        let channel = try await api.createChannel(workspaceID: workspace.id, name: name)
        try await reloadWorkspace()
        return channel
    }

    func createThread(channelID: String, text: String, files: [URL]) async throws -> ThreadSummary? {
        guard let workspace else { return nil }
        let thread = try await api.createThread(
            workspaceID: workspace.id, channelID: channelID, text: text, files: files
        )
        try await reloadWorkspace()
        return thread
    }

    /// Runs an action and shows its error in a toast.
    func run(_ action: () async throws -> Void) async {
        do { try await action() } catch is CancellationError {} catch {
            if (error as? APIError)?.status != 401 { show(error.localizedDescription, .error) }
        }
    }

    func show(_ message: String, _ tone: Toast.Tone = .neutral) {
        toast = Toast(message: message, tone: tone)
    }

    private func clear() {
        Keychain.token = nil
        api.token = nil
        signedIn = false
        user = nil
        workspaces = []
        workspace = nil
        channels = []
        loadError = nil
    }

    private enum Keys {
        static let serverURL = "serverURL"
        static let workspaceID = "workspaceID"
    }
}

/// The session token in the Keychain.
enum Keychain {
    private static let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: Bundle.main.bundleIdentifier ?? "Golem",
        kSecAttrAccount as String: "token"
    ]

    static var token: String? {
        get {
            var result: AnyObject?
            var search = query
            search[kSecReturnData as String] = true
            guard SecItemCopyMatching(search as CFDictionary, &result) == errSecSuccess,
                  let data = result as? Data else { return nil }
            return String(data: data, encoding: .utf8)
        }
        set {
            SecItemDelete(query as CFDictionary)
            guard let newValue else { return }
            var item = query
            item[kSecValueData as String] = Data(newValue.utf8)
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(item as CFDictionary, nil)
        }
    }
}
