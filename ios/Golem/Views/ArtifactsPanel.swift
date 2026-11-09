import SwiftUI

/// Files, artifacts, and the open artifact of a topic beside the topic or one of its chats, or of the workspace
/// beside the orchestrator.
struct ArtifactsPanel: View {
    enum Tab: String, CaseIterable {
        case files = "Files", artifacts = "Artifacts"

        var empty: String {
            switch self {
            case .files: "No files yet"
            case .artifacts: "No artifacts yet"
            }
        }
    }

    /// Nil for the workspace's own files and artifacts.
    let topicID: String?
    /// Changes when the chat does, so the files and artifacts load again: they come with messages.
    let changes: Int
    /// Closes the panel where it is a sheet, on iPhone.
    var close: (() -> Void)?
    @Environment(Session.self) private var session
    @State private var tab = Tab.files
    @State private var files: [SavedFile] = []
    @State private var uploading = false
    @State private var artifacts: [Artifact] = []
    @State private var openArtifact: String?
    @State private var opening: FileRef?

    /// `artifactID` opens an artifact at once, as a search result does.
    init(
        topicID: String?, changes: Int, artifactID: String? = nil, close: (() -> Void)? = nil
    ) {
        self.topicID = topicID
        self.changes = changes
        self.close = close
        _openArtifact = State(initialValue: artifactID)
    }
    /// Lists the artifacts again after the open artifact changes one.
    @State private var artifactChanges = 0

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Tokens.Space.md) {
                if openArtifact != nil {
                    GlassCircleButton(label: "Back to artifacts", pixel: .back) {
                        openArtifact = nil
                        tab = .artifacts
                    }
                    .padding(.leading, Tokens.Space.lg)
                    Spacer()
                } else {
                    PillBar(selection: $tab, options: Tab.allCases) { $0.rawValue }
                }
                if let close {
                    GlassCircleButton(label: "Close", pixel: .close, action: close)
                        .padding(.trailing, Tokens.Space.lg)
                }
            }
            .padding(.vertical, Tokens.Space.md)
            if let openArtifact {
                ArtifactView(artifactID: openArtifact, changes: changes) { artifactChanges += 1 }
                    .id(openArtifact)
            } else {
                switch tab {
                case .files: filesTab
                case .artifacts: artifactsTab
                }
            }
        }
        .mobileBackground()
        // On iPhone the panel is a sheet, which held back the Quick Look of the screen under it until it closed.
        .filePreview($opening)
        .task(id: changes) {
            await session.run {
                files = try await session.api.files(workspaceID: workspaceID, topicID: topicID)
            }
        }
        .task(id: "\(changes)-\(artifactChanges)") {
            await session.run {
                artifacts = try await session.api.artifacts(workspaceID: workspaceID, topicID: topicID)
                if let openArtifact, !artifacts.contains(where: { $0.id == openArtifact }) {
                    self.openArtifact = nil
                }
            }
        }
    }

    private var workspaceID: String { session.workspace?.id ?? "" }

    /// The topic's artifacts, newest first. Tapping one opens it in the panel.
    @ViewBuilder
    private var artifactsTab: some View {
        if artifacts.isEmpty {
            EmptyState(title: tab.empty)
        } else {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(artifacts) { artifact in
                        Button {
                            openArtifact = artifact.id
                        } label: {
                            ListRow(title: artifact.title, pixel: .artifact) {
                                Text("\(artifact.visitors)")
                                    .font(.golem(Tokens.Mobile.FontSize.small))
                                    .foregroundStyle(Tokens.Mobile.Colors.textQuaternary)
                                    .accessibilityLabel("\(artifact.visitors) people")
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .returnsToEnd()
        }
    }

    /// The topic's files, newest first, under an upload button that spins while files upload. Files dropped on the
    /// tab upload.
    private var filesTab: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.md) {
            AttachMenu(add: upload) {
                Label {
                    Text("Upload files")
                } icon: {
                    if uploading { ProgressView().controlSize(.mini) } else { Image(pixel: .plus) }
                }
            }
                .buttonStyle(.secondary)
            if files.isEmpty {
                EmptyState(title: tab.empty)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(files.reversed()) { file in
                            Button { opening = file.ref } label: { ListRow(file.name, pixel: .file) }
                                .buttonStyle(.plain)
                                .contextMenu {
                                    Button("Delete file", pixel: .trash, role: .destructive) { delete(file) }
                                }
                        }
                    }
                }
                .returnsToEnd()
                .padding(.horizontal, -Tokens.Space.lg)
            }
        }
        .padding(.horizontal, Tokens.Space.lg)
        .frame(maxHeight: .infinity, alignment: .top)
        .dropDestination(for: PickedFile.self) { dropped, _ in
            upload(dropped.map(\.url))
            return true
        }
    }

    private func upload(_ picked: [URL]) {
        guard !picked.isEmpty else { return }
        uploading = true
        Task {
            await session.run {
                files = try await session.api.uploadFiles(workspaceID: workspaceID, topicID: topicID, files: picked)
            }
            uploading = false
        }
    }

    private func delete(_ file: SavedFile) {
        Task {
            await session.run { files = try await session.api.deleteFile(workspaceID: workspaceID, fileID: file.id) }
        }
    }
}
