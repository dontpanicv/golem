import PhotosUI
import SwiftUI
import UIKit

/// The person's integrations, what Golem learned, machines, the use of the model, the voice, shortcuts, the LLM
/// provider, which the whole server shares and only its owner changes, and the account, most used first. `open` opens
/// a thread of the usage.
struct SettingsView: View {
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @State private var llm: Llm?
    /// The signed shortcuts of the build (ios/scripts/make-shortcuts.py), for the Action button and Back Tap.
    private let shortcuts: [(name: String, url: URL)] = ["Ask Golem", "Dictate to Golem"].compactMap { name in
        Bundle.main.url(forResource: name, withExtension: "shortcut", subdirectory: "Shortcuts").map { (name, $0) }
    }

    var body: some View {
        SettingsList {
            if let workspace = session.workspace {
                IntegrationsSection(workspaceID: workspace.id)
                PlacesSection(workspaceID: workspace.id)
                LearnedSection(workspaceID: workspace.id)
                MachinesSection(workspaceID: workspace.id)
                UsageSection(workspaceID: workspace.id, open: open)
            }
            if Speaker.isBundled {
                SettingsCard(title: "Conversation") {
                    SettingsRow("Voice") {
                        GolemSelect(
                            selection: Binding(get: { Speaker.shared.voice }, set: chooseVoice),
                            options: Speaker.voices.map(\.id),
                            title: voiceLabel
                        )
                        .accessibilityLabel("Voice")
                    }
                }
            }
            if !shortcuts.isEmpty {
                SettingsCard(title: "Shortcuts") {
                    ForEach(shortcuts, id: \.name) { shortcut in
                        SettingsRow(shortcut.name) {
                            // The share sheet's Shortcuts app imports it.
                            ShareLink(item: shortcut.url) { Text("Add") }
                                .buttonStyle(.secondary)
                        }
                    }
                }
            }
            SettingsCard(title: "LLM provider") {
                if let llm {
                    SettingsRow(llm.provider, description: llm.error, descriptionColor: Tokens.Mobile.Colors.danger) {
                        HStack(spacing: Tokens.Space.md) {
                            if llm.connected {
                                Badge(label: "Connected", tone: .success)
                                if llm.owner {
                                    Button("Disconnect") { update { try await session.api.llmLogout() } }
                                        .buttonStyle(.secondary)
                                        .fixedSize()
                                }
                            } else if !llm.owner {
                                Badge(label: "Not connected")
                            } else if llm.login != nil {
                                Badge(label: "Waiting", tone: .warning)
                            } else {
                                Button("Connect") { update { try await session.api.llmLogin() } }
                                    .buttonStyle(.primary)
                            }
                        }
                    }
                    if !llm.connected, let login = llm.login {
                        DeviceLogin(login: login).padding(Tokens.Space.xl)
                    }
                    if llm.connected && !llm.owner {
                        SettingsRow("Model") {
                            Text(llm.models.first { $0.id == llm.model }?.name ?? llm.model)
                                .foregroundStyle(Tokens.Mobile.Colors.textTertiary)
                        }
                        SettingsRow("Effort") {
                            Text(effortLabel(llm.effort)).foregroundStyle(Tokens.Mobile.Colors.textTertiary)
                        }
                    }
                    if llm.connected && llm.owner {
                        SettingsRow("Model") {
                            GolemSelect(
                                selection: Binding(get: { llm.model }, set: setModel),
                                options: llm.models.map(\.id),
                                title: { id in llm.models.first { $0.id == id }?.name ?? id }
                            )
                            .accessibilityLabel("Model")
                        }
                        SettingsRow("Effort") {
                            GolemSelect(
                                selection: Binding(get: { llm.effort }, set: setEffort),
                                options: llm.models.first { $0.id == llm.model }?.efforts ?? [],
                                title: effortLabel
                            )
                            .accessibilityLabel("Effort")
                        }
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity, minHeight: Tokens.Size.settingsRow)
                }
            }
            if llm?.owner == true {
                SettingsCard(title: "Server") {
                    SettingsRow("Configuration") {
                        Button("Reload") {
                            Task {
                                await session.run {
                                    try await session.api.restartServer()
                                    session.show("Golem restarts", .success)
                                }
                            }
                        }
                        .buttonStyle(.secondary)
                    }
                }
            }
            if let user = session.user {
                SettingsCard(title: "Account") {
                    SettingsRow(label: user.name, description: user.email) {
                        PersonAvatar(name: user.name, picture: user.picture, size: 32)
                    } control: {
                        PictureMenu(picture: user.picture)
                    }
                }
            }
            Button { Task { await session.signOut() } } label: {
                SettingsRow("Sign out", labelColor: Tokens.Mobile.Colors.danger) {
                    Image(systemName: "rectangle.portrait.and.arrow.right")
                        .font(.system(size: 15))
                        .foregroundStyle(Tokens.Mobile.Colors.danger)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
        }
        .phoneTabBar()
        .screenTitle("Settings")
        .task { update { try await session.api.llm() } }
        // While a device login waits, poll every 2 seconds until it connects or stops.
        .task(id: llm?.login?.userCode) {
            while let current = llm, current.login != nil, !current.connected {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled else { return }
                if let next = try? await session.api.llm() { llm = next }
            }
        }
    }

    /// Plays a sample of the voice, unless a conversation is on: then it speaks with it from the next sentence.
    private func chooseVoice(_ voice: String) {
        guard !VoiceSession.shared.talk.isOn else { return Speaker.shared.voice = voice }
        Task { await session.run { try await Speaker.shared.sample(voice) } }
    }

    private func voiceLabel(_ id: String) -> String {
        Speaker.voices.first { $0.id == id }?.name ?? id
    }

    private func setModel(_ model: String) {
        update { try await session.api.setModel(model) }
    }

    private func setEffort(_ effort: String) {
        update { try await session.api.setEffort(effort) }
    }

    private func effortLabel(_ effort: String) -> String {
        effort == "xhigh" ? "Extra high" : effort.capitalized
    }

    private func update(_ request: @escaping () async throws -> Llm) {
        Task { await session.run { llm = try await request() } }
    }
}

private struct DeviceLogin: View {
    let login: Llm.Login
    @Environment(Session.self) private var session

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.lg) {
            Text("Enter this code at \(host)")
                .font(.golem(Tokens.FontSize.sm, Tokens.FontWeight.book))
                .foregroundStyle(Tokens.Mobile.Colors.textTertiary)
            Text(login.userCode)
                .font(.system(size: Tokens.FontSize.xxl, weight: .semibold, design: .monospaced))
                .foregroundStyle(Tokens.Mobile.Colors.text)
                .textSelection(.enabled)
            HStack(spacing: Tokens.Space.lg) {
                Button("Copy code") {
                    UIPasteboard.general.string = login.userCode
                    session.show("Copied", .success)
                }
                .buttonStyle(.secondary)
                if let url = URL(string: login.verificationUri) {
                    Link("Open \(host)", destination: url)
                    .buttonStyle(.primary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var host: String {
        URL(string: login.verificationUri)?.host() ?? login.verificationUri
    }
}

/// Uploads a picture from the photo library as the person's profile picture, or removes it.
private struct PictureMenu: View {
    let picture: String?
    @Environment(Session.self) private var session
    @State private var picking = false
    @State private var photo: PhotosPickerItem?

    /// The longest side of a profile picture that the app uploads, in pixels, as the web app sends it.
    private static let size: CGFloat = 256

    var body: some View {
        GolemMenu {
            MenuItem("Upload picture", systemImage: "photo.on.rectangle") { picking = true }
            if picture != nil {
                MenuItem("Remove picture", systemImage: "trash", role: .destructive) {
                    Task { await session.run { try await session.setPicture(nil) } }
                }
            }
        } label: {
            Label("Picture actions", systemImage: "ellipsis")
        }
        .buttonStyle(.golem(.ghost, .icon))
        .photosPicker(isPresented: $picking, selection: $photo, matching: .images)
        .onChange(of: photo) { _, item in
            guard let item else { return }
            photo = nil
            Task {
                await session.run {
                    guard let data = try await item.loadTransferable(type: Data.self), let image = UIImage(data: data)
                    else { throw APIError(status: 0, message: "Golem cannot read this picture.") }
                    let file = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).jpg")
                    try Self.square(image).write(to: file)
                    try await session.setPicture(file)
                }
            }
        }
    }

    /// The middle square of a picture as a small JPEG, so every app shows it round and the upload stays small.
    private static func square(_ image: UIImage) -> Data {
        let side = min(image.size.width, image.size.height)
        let length = min(side * image.scale, size)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let scale = length / side
        return UIGraphicsImageRenderer(size: CGSize(width: length, height: length), format: format).jpegData(
            withCompressionQuality: 0.9
        ) { _ in
            image.draw(in: CGRect(
                x: (side - image.size.width) / 2 * scale, y: (side - image.size.height) / 2 * scale,
                width: image.size.width * scale, height: image.size.height * scale
            ))
        }
    }
}
