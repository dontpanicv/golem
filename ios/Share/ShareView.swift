import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// What was shared, as a message to a workspace's Golem thread or as a new thread in one of its channels. Links and
/// text go in the message, to edit; anything else is a file. It remembers the last workspace and place.
struct ShareView: View {
    let providers: [NSItemProvider]
    let done: (_ sent: Bool) -> Void
    @State private var api = ShareView.signedInAPI()
    @State private var text = ""
    @State private var files: [URL] = []
    @State private var workspaces: [Workspace] = []
    @State private var channels: [Channel] = []
    @State private var orchestrator: ThreadSummary?
    @State private var failure: String?
    @State private var sending = false
    @AppStorage("workspaceID") private var workspaceID = ""
    /// A channel's id, or empty for the Golem thread.
    @AppStorage("channelID") private var channelID = ""

    private var canSend: Bool {
        !sending && (orchestrator != nil || !channelID.isEmpty)
            && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Message", text: $text, axis: .vertical)
                        .lineLimit(3...10)
                    ForEach(files, id: \.self) { file in
                        Label(file.lastPathComponent, systemImage: "doc")
                            .lineLimit(1)
                    }
                }
                Section {
                    if workspaces.count > 1 {
                        Picker("Workspace", selection: $workspaceID) {
                            ForEach(workspaces) { Text($0.name).tag($0.id) }
                        }
                    }
                    Picker("Send to", selection: $channelID) {
                        Text("Golem").tag("")
                        ForEach(channels) { channel in
                            Text("\(channel.icon ?? "#") \(channel.name)").tag(channel.id)
                        }
                    }
                }
                if let failure {
                    Section { Text(failure).foregroundStyle(Tokens.Colors.danger) }
                }
            }
            .navigationTitle("Golem")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { done(false) }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if sending {
                        ProgressView()
                    } else {
                        Button("Send", action: send).disabled(!canSend)
                    }
                }
            }
        }
        .tint(Tokens.Colors.accent)
        .task { await load() }
        .task(id: workspaceID) { await loadWorkspace() }
    }

    /// Reads what was shared and the person's workspaces.
    private func load() async {
        let shared = await Self.read(providers)
        text = shared.text.joined(separator: "\n")
        files = shared.files
        guard api.token != nil else { return failure = "Sign in to Golem first." }
        do {
            workspaces = try await api.me().workspaces
            if !workspaces.contains(where: { $0.id == workspaceID }) { workspaceID = workspaces.first?.id ?? "" }
        } catch {
            failure = error.localizedDescription
        }
    }

    private func loadWorkspace() async {
        guard !workspaceID.isEmpty else { return }
        do {
            async let detail = api.workspace(workspaceID)
            async let golem = api.orchestrator(workspaceID: workspaceID)
            (channels, orchestrator) = try await (detail.channels, golem)
            if !channels.contains(where: { $0.id == channelID }) { channelID = "" }
            failure = nil
        } catch {
            failure = error.localizedDescription
        }
    }

    private func send() {
        let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
        sending = true
        failure = nil
        Task {
            do {
                if channelID.isEmpty, let orchestrator {
                    try await api.sendMessage(threadID: orchestrator.id, text: message, files: files)
                } else {
                    _ = try await api.createThread(
                        workspaceID: workspaceID, channelID: channelID, text: message, files: files
                    )
                }
                done(true)
            } catch {
                failure = error.localizedDescription
                sending = false
            }
        }
    }

    /// The app's session, which the Keychain shares with this extension.
    private static func signedInAPI() -> APIClient {
        let api = APIClient()
        api.baseURL = Keychain.serverURL
            ?? Bundle.main.object(forInfoDictionaryKey: "GolemServerURL") as? String ?? ""
        api.token = Keychain.token
        // iOS can give a share sheet no network for a moment, which failed at once as "offline"; wait for it.
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        configuration.timeoutIntervalForResource = 120
        api.session = URLSession(configuration: configuration)
        return api
    }

    /// Web links and text as lines of the message; files, pictures, and videos as copies in the temporary folder.
    static func read(_ providers: [NSItemProvider]) async -> (text: [String], files: [URL]) {
        var text: [String] = []
        var files: [URL] = []
        for provider in providers {
            if !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                   let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL,
                   !url.isFileURL {
                    text.append(url.absoluteString)
                    continue
                }
                if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                   let string = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                    text.append(string)
                    continue
                }
            }
            if let file = await file(provider) { files.append(file) }
        }
        return (text, files)
    }

    private static func file(_ provider: NSItemProvider) async -> URL? {
        let picked = await withCheckedContinuation { continuation in
            _ = provider.loadTransferable(type: PickedFile.self) { continuation.resume(returning: try? $0.get()) }
        }
        if let picked { return picked.url }
        // Some apps share a picture only as an image object, with no file.
        guard let image = try? await provider.loadItem(forTypeIdentifier: UTType.image.identifier) as? UIImage,
              let data = image.jpegData(compressionQuality: 0.9) else { return nil }
        let url = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).jpg")
        return (try? data.write(to: url)) == nil ? nil : url
    }
}
