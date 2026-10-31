import SwiftUI

/// What Golem learned from quiet threads that the person sees: facts about each member, then the how-tos of each
/// channel and of the person's own Golem. A lock marks an entry only the person sees. A change shows at once and
/// goes back when the server refuses it.
struct LearnedSection: View {
    let workspaceID: String
    @Environment(Session.self) private var session
    @State private var learned: [Learned] = []
    @State private var members: [Member] = []
    @State private var editing: Learned?

    var body: some View {
        SettingsCard(title: "What Golem learned") {
            if learned.isEmpty { SettingsRow("Nothing yet") }
            ForEach(groups, id: \.title) { group in
                Text(group.title)
                    .font(.golem(Tokens.Mobile.FontSize.caption, Tokens.FontWeight.medium))
                    .foregroundStyle(Tokens.Mobile.Colors.textTertiary)
                    .padding(.horizontal, Tokens.Mobile.Size.margin)
                    .padding(.top, Tokens.Space.md)
                    .accessibilityAddTraits(.isHeader)
                ForEach(group.entries) { row($0) }
            }
        }
        .task { await session.run { try await load() } }
        .sheet(item: $editing) { entry in
            EditLearnedDialog(entry: entry) { text in save(entry, text) }
        }
    }

    /// In the server's order, facts first; each group where its first entry is.
    private var groups: [(title: String, entries: [Learned])] {
        var groups: [(title: String, entries: [Learned])] = []
        for entry in learned {
            let title = title(entry)
            if let index = groups.firstIndex(where: { $0.title == title }) {
                groups[index].entries.append(entry)
            } else {
                groups.append((title, [entry]))
            }
        }
        return groups
    }

    private func title(_ entry: Learned) -> String {
        switch entry.kind {
        case .about:
            let name = members.first { $0.userId == entry.personId }?.name ?? "a former member"
            return "About \(name)"
        case .howto:
            guard let channelID = entry.channelId else { return "Your Golem" }
            return "#\(session.channels.first { $0.id == channelID }?.name ?? "deleted channel")"
        }
    }

    private func row(_ entry: Learned) -> some View {
        HStack(alignment: .top, spacing: Tokens.Space.md) {
            Text(entry.text)
                .font(.golem(Tokens.Mobile.FontSize.row, Tokens.FontWeight.book))
                .foregroundStyle(Tokens.Mobile.Colors.text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, Tokens.Space.md)
            if entry.realm != nil {
                Image(systemName: "lock")
                    .font(.system(size: 12))
                    .foregroundStyle(Tokens.Mobile.Colors.textQuaternary)
                    .frame(minHeight: Tokens.Size.listRow)
                    .accessibilityLabel("Only you see this")
            }
            GolemMenu { actions(entry) } label: {
                Label("Entry actions", systemImage: "ellipsis")
            }
            .buttonStyle(.golem(.ghost, .icon))
        }
        .padding(.horizontal, Tokens.Mobile.Size.margin)
        .contentShape(.rect)
        .contextMenu { actions(entry) }
    }

    @ViewBuilder
    private func actions(_ entry: Learned) -> some View {
        MenuItem("Edit", systemImage: "pencil") { editing = entry }
        MenuItem("Delete", systemImage: "trash", role: .destructive) { delete(entry) }
    }

    private func load() async throws {
        async let loadedLearned = session.api.learned(workspaceID: workspaceID)
        async let loadedMembers = session.api.members(workspaceID: workspaceID)
        (learned, members) = try await (loadedLearned, loadedMembers)
    }

    private func save(_ entry: Learned, _ text: String) {
        guard let index = learned.firstIndex(where: { $0.id == entry.id }) else { return }
        learned[index].text = text
        Task {
            do {
                let saved = try await session.api.setLearned(workspaceID: workspaceID, id: entry.id, text: text)
                learned = learned.map { $0.id == saved.id ? saved : $0 }
            } catch {
                learned = learned.map { $0.id == entry.id ? entry : $0 }
                session.show(error.localizedDescription, .error)
            }
        }
    }

    private func delete(_ entry: Learned) {
        guard let index = learned.firstIndex(where: { $0.id == entry.id }) else { return }
        learned.remove(at: index)
        Task {
            do {
                try await session.api.deleteLearned(workspaceID: workspaceID, id: entry.id)
            } catch {
                learned.insert(entry, at: min(index, learned.count))
                session.show(error.localizedDescription, .error)
            }
        }
    }
}

/// Corrects what Golem learned; the text field holds the entry's words.
private struct EditLearnedDialog: View {
    let entry: Learned
    let save: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @FocusState private var focused: Bool

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        Dialog(title: "Edit") {
            TextField("Text", text: $text, axis: .vertical)
                .lineLimit(3...10)
                .focused($focused)
                .font(.golem(Tokens.Mobile.FontSize.body))
                .foregroundStyle(Tokens.Mobile.Colors.text)
                .tint(Tokens.Colors.accent)
                .padding(Tokens.Space.lg)
                .background(Tokens.Mobile.Colors.fill, in: .rect(cornerRadius: Tokens.Radius.xl))
                .overlay(
                    RoundedRectangle(cornerRadius: Tokens.Radius.xl)
                        .strokeBorder(focused ? Tokens.Colors.accent : .clear, lineWidth: 1)
                )
        } actions: {
            Button("Cancel") { dismiss() }.buttonStyle(.golem(.secondary, .large))
            Button("Save") {
                save(trimmed)
                dismiss()
            }
            .buttonStyle(.golem(.primary, .large))
            .disabled(trimmed.isEmpty || trimmed == entry.text)
        }
        .onAppear {
            text = entry.text
            focused = true
        }
    }
}
