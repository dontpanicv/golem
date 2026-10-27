import SwiftUI

/// The name, members, machines, and integrations of the open workspace; only an owner renames or deletes it.
struct WorkspaceSettingsView: View {
    @Environment(Session.self) private var session
    @State private var members: [Member] = []
    @State private var email = ""
    @State private var name = ""
    @State private var confirmDelete = false

    private var workspaceID: String { session.workspace?.id ?? "" }
    private var renamed: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty && name != session.workspace?.name
    }

    var body: some View {
        SettingsList {
            if session.workspace?.role == "owner" {
                SettingsCard(title: "Workspace") {
                    HStack(spacing: Tokens.Space.md) {
                        GolemTextField(nil, placeholder: "Name", text: $name)
                            .onSubmit(rename)
                            .accessibilityLabel("Name")
                        Button("Save", action: rename)
                            .buttonStyle(.secondary)
                            .disabled(!renamed)
                    }
                    .padding(Tokens.Space.xl)
                    SettingsRow("Delete workspace") {
                        Button("Delete") { confirmDelete = true }
                            .buttonStyle(.golem(.danger, .small))
                    }
                }
            }
            SettingsCard(title: "Members") {
                ForEach(members) { member in
                    SettingsRow(label: member.name, description: member.email) {
                        Avatar(name: member.name, size: 32)
                    } control: {
                        Badge(label: member.role.capitalized)
                    }
                }
                if session.workspace?.role == "owner" {
                    HStack(spacing: Tokens.Space.md) {
                        GolemTextField(nil, placeholder: "Email address", text: $email)
                            .keyboardType(.emailAddress)
                            .textContentType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .onSubmit(addMember)
                            .accessibilityLabel("Email")
                        Button("Add", action: addMember)
                            .buttonStyle(.secondary)
                            .disabled(email.isEmpty)
                    }
                    .padding(Tokens.Space.xl)
                }
            }
            MachinesSection(workspaceID: workspaceID)
            IntegrationsSection(workspaceID: workspaceID)
        }
        .phoneTabBar()
        .screenTitle(session.workspace?.name ?? "")
        .task { await load() }
        .onAppear { name = session.workspace?.name ?? "" }
        .refreshable { await load() }
        .sheet(isPresented: $confirmDelete) {
            DeleteDialog(
                title: "Delete \(session.workspace?.name ?? "")?",
                message: "Its channels, threads, files, artifacts, and routines go with it.",
                submit: "Delete workspace"
            ) {
                try await session.deleteWorkspace()
            }
        }
    }

    private func load() async {
        await session.run { members = try await session.api.members(workspaceID: workspaceID) }
    }

    private func rename() {
        let name = name
        guard renamed else { return }
        Task {
            await session.run {
                try await session.renameWorkspace(name: name)
                session.show("Saved", .success)
            }
        }
    }

    private func addMember() {
        let email = email
        guard !email.isEmpty else { return }
        Task {
            await session.run {
                let member = try await session.api.addMember(workspaceID: workspaceID, email: email)
                members.append(member)
                self.email = ""
                session.show("Added \(member.name)", .success)
            }
        }
    }
}
