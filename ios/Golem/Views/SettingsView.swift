import SwiftUI
import UIKit

/// The LLM provider, which the whole server shares, and the account.
struct SettingsView: View {
    @Environment(Session.self) private var session
    @State private var llm: Llm?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Space.xxxl) {
                SettingsCard(title: "LLM provider") {
                    if let llm {
                        SettingsRow(
                            llm.provider,
                            description: llm.error ?? (llm.connected ? "The whole server shares this connection" : nil),
                            descriptionColor: llm.error == nil ? Tokens.Colors.textTertiary : Tokens.Colors.danger
                        ) {
                            HStack(spacing: Tokens.Space.md) {
                                Badge(label: llm.connected ? "Connected" : "Not connected", tone: llm.connected ? .success : .neutral)
                                if llm.connected {
                                    Button("Disconnect") { update { try await session.api.llmLogout() } }.buttonStyle(.danger)
                                } else if llm.login == nil {
                                    Button("Connect") { update { try await session.api.llmLogin() } }.buttonStyle(.primary)
                                }
                            }
                        }
                        if !llm.connected, let login = llm.login {
                            DeviceLogin(login: login).padding(Tokens.Space.xl)
                        }
                        if !llm.models.isEmpty {
                            SettingsRow("Model") {
                                GolemSelect(selection: Binding(get: { llm.model }, set: setModel), options: llm.models)
                                    .accessibilityLabel("Model")
                            }
                        }
                    } else {
                        ProgressView().frame(maxWidth: .infinity, minHeight: Tokens.Size.settingsRow)
                    }
                }
                if let user = session.user {
                    SettingsCard(title: "Account") {
                        SettingsRow(label: user.name, description: user.email) {
                            Avatar(name: user.name, size: 32)
                        } control: {
                            Button("Sign out") { Task { await session.signOut() } }.buttonStyle(.secondary)
                        }
                    }
                }
            }
            .frame(maxWidth: 640)
            .padding(Tokens.Space.xl)
            .frame(maxWidth: .infinity)
        }
        .background(Tokens.Colors.surface)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.large)
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

    private func setModel(_ model: String) {
        update { try await session.api.setModel(model) }
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
            Text("Enter this code on the provider’s page to connect.")
                .font(.golem(Tokens.FontSize.sm, Tokens.FontWeight.book))
                .foregroundStyle(Tokens.Colors.textTertiary)
            Text(login.userCode)
                .font(.system(size: Tokens.FontSize.xxl, weight: .semibold, design: .monospaced))
                .foregroundStyle(Tokens.Colors.text)
                .textSelection(.enabled)
            HStack(spacing: Tokens.Space.lg) {
                Button("Copy code", systemImage: "doc.on.doc") {
                    UIPasteboard.general.string = login.userCode
                    session.show("Code copied", .success)
                }
                .buttonStyle(.secondary)
                if let url = URL(string: login.verificationUri) {
                    Link(destination: url) {
                        Label("Open \(url.host() ?? login.verificationUri)", systemImage: "arrow.up.right.square")
                    }
                    .buttonStyle(.primary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
