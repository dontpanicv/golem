import SwiftUI

/// Files, artifacts, and the open artifact of a channel beside the channel or one of its threads, or of the workspace
/// beside the orchestrator.
struct ArtifactsPanel: View {
    enum Tab: String, CaseIterable {
        case files = "Files", artifacts = "Artifacts"

        var empty: (title: String, systemImage: String) {
            switch self {
            case .artifacts: ("No artifacts yet", "shippingbox")
            case .files: ("No files yet", "doc")
            }
        }
    }

    /// Nil for the workspace's own files and artifacts.
    let channelID: String?
    /// Changes when the thread does, so the files and artifacts load again: they come with messages.
    let changes: Int
    let openFile: (FileRef) -> Void
    /// Closes the panel where it is a sheet, on iPhone.
    var close: (() -> Void)?
    @Environment(Session.self) private var session
    @State private var tab = Tab.files
    @State private var files: [SavedFile] = []
    @State private var uploading = false
    @State private var artifacts: [Artifact] = []
    @State private var openArtifact: String?

    /// `artifactID` opens an artifact at once, as a search result does.
    init(
        channelID: String?, changes: Int, artifactID: String? = nil, openFile: @escaping (FileRef) -> Void,
        close: (() -> Void)? = nil
    ) {
        self.channelID = channelID
        self.changes = changes
        self.openFile = openFile
        self.close = close
        _openArtifact = State(initialValue: artifactID)
    }
    /// Lists the artifacts again after the open artifact changes one.
    @State private var artifactChanges = 0

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Tokens.Space.md) {
                if openArtifact != nil {
                    GlassCircleButton(label: "Back to artifacts", systemImage: "chevron.left") {
                        openArtifact = nil
                        tab = .artifacts
                    }
                    .padding(.leading, Tokens.Space.lg)
                    Spacer()
                } else {
                    PillBar(selection: $tab, options: Tab.allCases) { $0.rawValue }
                }
                if let close {
                    GlassCircleButton(label: "Close", systemImage: "xmark", action: close)
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
        .task(id: changes) {
            await session.run {
                files = try await session.api.files(workspaceID: workspaceID, channelID: channelID)
            }
        }
        .task(id: "\(changes)-\(artifactChanges)") {
            await session.run {
                artifacts = try await session.api.artifacts(workspaceID: workspaceID, channelID: channelID)
                if let openArtifact, !artifacts.contains(where: { $0.id == openArtifact }) {
                    self.openArtifact = nil
                }
            }
        }
    }

    private var workspaceID: String { session.workspace?.id ?? "" }

    /// The channel's artifacts, newest first. Tapping one opens it in the panel.
    @ViewBuilder
    private var artifactsTab: some View {
        if artifacts.isEmpty {
            EmptyState(title: tab.empty.title, systemImage: tab.empty.systemImage)
        } else {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(artifacts) { artifact in
                        Button {
                            openArtifact = artifact.id
                        } label: {
                            ListRow(title: artifact.title, systemImage: "shippingbox") {
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
        }
    }

    /// The channel's files, newest first, under an upload button that spins while files upload. Files dropped on the
    /// tab upload.
    private var filesTab: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.md) {
            AttachMenu(add: upload) {
                Label {
                    Text("Upload files")
                } icon: {
                    if uploading { ProgressView().controlSize(.mini) } else { Image(systemName: "plus") }
                }
            }
                .buttonStyle(.secondary)
            if files.isEmpty {
                EmptyState(title: tab.empty.title, systemImage: tab.empty.systemImage)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(files.reversed()) { file in
                            Button { openFile(file.ref) } label: { ListRow(file.name, systemImage: "doc") }
                                .buttonStyle(.plain)
                                .contextMenu {
                                    Button("Delete file", systemImage: "trash", role: .destructive) { delete(file) }
                                }
                        }
                    }
                }
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
                files = try await session.api.uploadFiles(workspaceID: workspaceID, channelID: channelID, files: picked)
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
