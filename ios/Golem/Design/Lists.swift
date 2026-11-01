import SwiftUI

// The flat list sections of the iPhone screens, as Linear's iOS app: a dim heading, rows that light up under a
// finger, and hairlines between groups.

/// The heading of a list section, as Linear's "In Progress": small and dim, with an optional add button.
struct ListSectionHeader: View {
    let title: String
    /// Opens what the section lists, such as the channel.
    var open: (() -> Void)?
    var add: (label: String, action: () -> Void)?

    var body: some View {
        HStack {
            // A heading that opens nothing is plain text: a disabled button would dim it.
            if let open {
                Button(action: open) { label }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(.isHeader)
            } else {
                label.accessibilityAddTraits(.isHeader)
            }
            Spacer()
            if let add {
                Button(add.label, systemImage: "plus", action: add.action)
                    .labelStyle(.iconOnly)
                    .font(.system(size: 15))
                    .foregroundStyle(Tokens.Mobile.Colors.textSecondary)
                    .frame(minWidth: Tokens.Size.listRow, minHeight: Tokens.Size.listRow)
                    .padding(.trailing, -Tokens.Space.md)
            }
        }
        .padding(.horizontal, Tokens.Mobile.Size.margin)
    }

    private var label: some View {
        Text(title)
            .font(.golem(Tokens.Mobile.FontSize.small, Tokens.FontWeight.book))
            .foregroundStyle(Tokens.Mobile.Colors.textQuaternary)
            .frame(minHeight: Tokens.Size.listRow)
            .contentShape(.rect)
    }
}

/// A heading inside a list section, as "About Anna" in What Golem learned: smaller and dimmer than the section's.
struct ListSubheading: View {
    let title: String

    init(_ title: String) { self.title = title }

    var body: some View {
        Text(title)
            .font(.golem(Tokens.Mobile.FontSize.caption, Tokens.FontWeight.medium))
            .foregroundStyle(Tokens.Mobile.Colors.textTertiary)
            .padding(.horizontal, Tokens.Mobile.Size.margin)
            .padding(.top, Tokens.Space.md)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A list row: an icon, a title, and trailing content. Rows sit 10 pt in from the screen edge with their content
/// 10 pt further in, as Linear's.
struct ListRow<Trailing: View>: View {
    let title: String
    var systemImage: String?
    var subtitle: String?
    var working = false
    /// Shows in place of the symbol when set.
    var emoji: String?
    /// Golem's face in place of the symbol, for a row that opens Golem.
    var golem = false
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: Tokens.Space.md) {
            if golem {
                GolemGlyph(size: 16)
                    .foregroundStyle(Tokens.Mobile.Colors.textSecondary)
                    .frame(width: 21)
            } else if let emoji {
                Text(emoji)
                    .font(.system(size: 15))
                    .frame(width: 21)
            } else if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 15))
                    .foregroundStyle(Tokens.Mobile.Colors.textSecondary)
                    .frame(width: 21)
            }
            VStack(alignment: .leading, spacing: 2) {
                // The spinner follows the title on its line, also over a subtitle.
                HStack(spacing: Tokens.Space.md) {
                    Text(title)
                        .font(.golem(Tokens.Mobile.FontSize.row, Tokens.FontWeight.book))
                        .foregroundStyle(Tokens.Mobile.Colors.text)
                        .lineLimit(1)
                    if working { PixelSpinner() }
                }
                if let subtitle {
                    Text(subtitle)
                        .font(.golem(Tokens.Mobile.FontSize.small, Tokens.FontWeight.book))
                        .foregroundStyle(Tokens.Mobile.Colors.textTertiary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            trailing
        }
        .padding(.horizontal, 10)
        .frame(minHeight: Tokens.Mobile.Size.row - 3)
        .contentShape(.rect)
        .padding(.horizontal, 10)
        .padding(.vertical, 1.5)
    }
}

extension ListRow where Trailing == EmptyView {
    init(_ title: String, systemImage: String? = nil, subtitle: String? = nil, working: Bool = false) {
        self.init(title: title, systemImage: systemImage, subtitle: subtitle, working: working) { EmptyView() }
    }
}

/// The full-width hairline between groups of rows.
struct ListSeparator: View {
    var body: some View {
        Rectangle().fill(Tokens.Mobile.Colors.separator).frame(height: 1).padding(.vertical, Tokens.Space.sm)
    }
}
