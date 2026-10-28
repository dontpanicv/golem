import SwiftUI

/// The name, members, facts, machines, and integrations of the open workspace; only an owner renames or deletes it.
struct WorkspaceSettingsView: View {
    @Environment(Session.self) private var session
    @State private var members: [Member] = []
    @State private var email = ""
    @State private var name = ""
    @State private var confirmDelete = false
    @State private var facts = ""
    @State private var savedFacts = ""

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
            SettingsCard(title: "Facts") {
                VStack(alignment: .trailing, spacing: Tokens.Space.md) {
                    TextField(
                        "Facts", text: $facts,
                        prompt: Text("Names, birthdays, addresses, work")
                            .foregroundStyle(Tokens.Mobile.Colors.placeholder),
                        axis: .vertical
                    )
                    .lineLimit(6...20)
                    .font(.golem(Tokens.Mobile.FontSize.body))
                    .foregroundStyle(Tokens.Mobile.Colors.text)
                    .tint(Tokens.Colors.accent)
                    .padding(Tokens.Space.lg)
                    .background(Tokens.Mobile.Colors.fill, in: .rect(cornerRadius: Tokens.Radius.xl))
                    Button("Save", action: saveFacts)
                        .buttonStyle(.secondary)
                        .disabled(facts == savedFacts)
                }
                .padding(Tokens.Space.xl)
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
        await session.run {
            async let loadedMembers = session.api.members(workspaceID: workspaceID)
            async let loadedFacts = session.api.facts(workspaceID: workspaceID)
            members = try await loadedMembers
            savedFacts = try await loadedFacts.text
            facts = savedFacts
        }
    }

    private func saveFacts() {
        let text = facts
        Task {
            await session.run {
                savedFacts = try await session.api.setFacts(workspaceID: workspaceID, text: text).text
                facts = savedFacts
                session.show("Saved", .success)
            }
        }
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
