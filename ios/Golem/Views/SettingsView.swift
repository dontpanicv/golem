import SwiftUI
import UIKit

/// The LLM provider, which the whole server shares, and the account.
struct SettingsView: View {
    @Environment(Session.self) private var session
    @State private var llm: Llm?

    var body: some View {
        Form {
            Section("LLM provider") {
                if let llm {
                    LabeledContent(llm.provider) {
                        Badge(label: llm.connected ? "Connected" : "Not connected", tone: llm.connected ? .success : .neutral)
                    }
                    if !llm.models.isEmpty {
                        Picker("Model", selection: Binding(get: { llm.model }, set: setModel)) {
                            ForEach(llm.models, id: \.self) { Text($0) }
                        }
                    }
                    if llm.connected {
                        Button("Disconnect", role: .destructive) { update { try await session.api.llmLogout() } }
                    } else if let login = llm.login {
                        DeviceLogin(login: login)
                    } else {
                        Button("Connect \(llm.provider)") { update { try await session.api.llmLogin() } }
                    }
                    if let error = llm.error {
                        Text(error).foregroundStyle(Tokens.Colors.danger)
                    }
                } else {
                    ProgressView()
                }
            }
            if let user = session.user {
                Section("Account") {
                    LabeledContent("Name", value: user.name)
                    LabeledContent("Email", value: user.email)
                    Button("Sign out", role: .destructive) { Task { await session.signOut() } }
                }
            }
        }
        .font(.golem(Tokens.FontSize.lg, Tokens.FontWeight.book))
        .scrollContentBackground(.hidden)
        .background(Tokens.Colors.canvas)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
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

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.lg) {
            Text(login.userCode)
                .font(.system(size: Tokens.FontSize.xxl, weight: .semibold, design: .monospaced))
                .foregroundStyle(Tokens.Colors.text)
                .textSelection(.enabled)
            HStack(spacing: Tokens.Space.lg) {
                Button("Copy code", systemImage: "doc.on.doc") { UIPasteboard.general.string = login.userCode }
                    .buttonStyle(.secondary)
                if let url = URL(string: login.verificationUri) {
                    Link(destination: url) {
                        Label("Open \(url.host() ?? login.verificationUri)", systemImage: "arrow.up.right.square")
                    }
                    .buttonStyle(.primary)
                }
            }
        }
        .padding(.vertical, Tokens.Space.md)
    }
}
