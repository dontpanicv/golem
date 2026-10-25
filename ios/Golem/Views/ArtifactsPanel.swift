import SwiftUI

/// Artifacts, files, and previews of the open thread, as in T3 Code's side panel.
struct ArtifactsPanel: View {
    enum Tab: String, CaseIterable {
        case artifacts = "Artifacts", files = "Files", preview = "Preview"

        var empty: (title: String, systemImage: String) {
            switch self {
            case .artifacts: ("No artifacts yet", "shippingbox")
            case .files: ("No files yet", "doc")
            case .preview: ("Nothing to preview", "globe")
            }
        }
    }

    let threadID: String
    /// Changes when the thread does, so the files load again: files come with messages.
    let changes: Int
    let openFile: (FileRef) -> Void
    @Environment(Session.self) private var session
    @State private var tab = Tab.artifacts
    @State private var files: [ThreadFile] = []

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Tokens.Space.xxs) {
                ForEach(Tab.allCases, id: \.self) { candidate in
                    Button(candidate.rawValue) { tab = candidate }
                        .font(.golem(Tokens.FontSize.md, Tokens.FontWeight.medium))
                        .foregroundStyle(tab == candidate ? Tokens.Colors.text : Tokens.Colors.textTertiary)
                        .padding(.horizontal, Tokens.Space.md)
                        .frame(minHeight: Tokens.Size.control)
                        .background(
                            tab == candidate ? Tokens.Colors.fillActive : .clear,
                            in: .rect(cornerRadius: Tokens.Radius.md)
                        )
                        .accessibilityAddTraits(tab == candidate ? .isSelected : [])
                }
                Spacer()
            }
            .padding(.horizontal, Tokens.Space.lg)
            .frame(height: Tokens.Size.header)
            Divider().overlay(Tokens.Colors.border)
            if tab == .files {
                filesTab
            } else {
                EmptyState(title: tab.empty.title, systemImage: tab.empty.systemImage)
            }
        }
        .background(Tokens.Colors.surface)
        .task(id: changes) { await session.run { files = try await session.api.threadFiles(threadID) } }
    }

    /// The thread's files, newest first, under an upload button. Files dropped on the tab upload.
    private var filesTab: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.md) {
            AttachMenu(add: upload) { Label("Upload files", systemImage: "plus") }
                .buttonStyle(.secondary)
            if files.isEmpty {
                EmptyState(title: tab.empty.title, systemImage: tab.empty.systemImage)
            } else {
                ScrollView {
                    VStack(spacing: 1) {
                        ForEach(files.reversed()) { file in
                            HStack(spacing: Tokens.Space.xs) {
                                Button { openFile(file.ref) } label: {
                                    NavRow(title: file.name, systemImage: "doc")
                                }
                                .buttonStyle(.plain)
                                GolemMenu {
                                    MenuItem("Delete file", systemImage: "trash", role: .destructive) { delete(file) }
                                } label: {
                                    Label("File actions", systemImage: "ellipsis")
                                }
                                .buttonStyle(.golem(.ghost, .icon))
                            }
                        }
                    }
                }
            }
        }
        .padding(Tokens.Space.lg)
        .frame(maxHeight: .infinity, alignment: .top)
        .dropDestination(for: PickedFile.self) { dropped, _ in
            upload(dropped.map(\.url))
            return true
        }
    }

    private func upload(_ picked: [URL]) {
        guard !picked.isEmpty else { return }
        Task { await session.run { files = try await session.api.uploadFiles(threadID: threadID, files: picked) } }
    }

    private func delete(_ file: ThreadFile) {
        Task { await session.run { files = try await session.api.deleteFile(threadID: threadID, fileID: file.id) } }
    }
}
