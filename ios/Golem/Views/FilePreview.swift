import QuickLook
import SwiftUI

extension View {
    /// Downloads `file` of the workspace and shows it in Quick Look, with a spinner over the view while it downloads;
    /// a tap on another file meanwhile opens that one instead. A view that shows a sheet cannot show Quick Look too,
    /// so a sheet that opens files needs its own.
    func filePreview(_ file: Binding<FileRef?>) -> some View { modifier(FilePreview(file: file)) }
}

private struct FilePreview: ViewModifier {
    @Binding var file: FileRef?
    @Environment(Session.self) private var session
    @State private var preview: URL?

    func body(content: Content) -> some View {
        content
            .overlay {
                if file != nil {
                    ProgressView()
                        .controlSize(.large)
                        .padding(Tokens.Space.xxl)
                        .barSurface()
                        .accessibilityLabel("Opening file")
                }
            }
            .quickLookPreview($preview)
            .task(id: file) {
                guard let file, let workspaceID = session.workspace?.id else { return }
                await session.run { preview = try await session.api.download(workspaceID: workspaceID, file: file) }
                if !Task.isCancelled { self.file = nil }
            }
    }
}
