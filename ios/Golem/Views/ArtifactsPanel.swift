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

    @State private var tab = Tab.artifacts

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Tokens.Space.xxs) {
                ForEach(Tab.allCases, id: \.self) { candidate in
                    Button(candidate.rawValue) { tab = candidate }
                        .font(.golem(Tokens.FontSize.md, Tokens.FontWeight.medium))
                        .foregroundStyle(tab == candidate ? Tokens.Colors.text : Tokens.Colors.textTertiary)
                        .padding(.horizontal, Tokens.Space.md)
                        .frame(minHeight: Tokens.Size.control)
                        .background(tab == candidate ? Tokens.Colors.fillActive : .clear, in: .rect(cornerRadius: Tokens.Radius.md))
                        .accessibilityAddTraits(tab == candidate ? .isSelected : [])
                }
                Spacer()
            }
            .padding(.horizontal, Tokens.Space.lg)
            .frame(height: Tokens.Size.header)
            Divider().overlay(Tokens.Colors.border)
            EmptyState(title: tab.empty.title, systemImage: tab.empty.systemImage)
        }
        .background(Tokens.Colors.surface)
    }
}
