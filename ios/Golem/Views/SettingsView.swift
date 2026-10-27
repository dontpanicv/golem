import SwiftUI
import UIKit

/// The LLM provider, which the whole server shares and only its owner changes, and the account.
struct SettingsView: View {
    @Environment(Session.self) private var session
    @State private var llm: Llm?

    var body: some View {
        SettingsList {
            SettingsCard(title: "LLM provider") {
                if let llm {
                    SettingsRow(llm.provider, description: llm.error, descriptionColor: Tokens.Mobile.Colors.danger) {
                        HStack(spacing: Tokens.Space.md) {
                            if llm.connected {
                                Badge(label: "Connected", tone: .success)
                                if llm.owner {
                                    Button("Disconnect") { update { try await session.api.llmLogout() } }
                                        .buttonStyle(.secondary)
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
            MachinesSection(workspaceID: nil)
            IntegrationsSection(workspaceID: nil)
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
                        Avatar(name: user.name, size: 32)
                    } control: {
                        EmptyView()
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
        Speaker.voices.first { $0.id == id }.map { "\($0.name), \($0.accent)" } ?? id
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
