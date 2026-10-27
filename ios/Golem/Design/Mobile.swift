import SwiftUI

// The building blocks of the iPhone screens. They keep the look measured from Linear's iOS app (a title in the
// navigation bar beside its glass buttons, pills, flat list sections with hairlines between groups, and round glass
// buttons) in the layout of Slack's iOS app (folding sections, a title capsule in the bar, and rows that light up
// under a finger).

extension View {
    /// The screen's title at the leading edge of the navigation bar, level with its glass buttons, as Linear's
    /// top-level screens show it. The bar's own title stays for accessibility and the back menu.
    func screenTitle(_ title: String) -> some View {
        navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(removing: .title)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Text(title)
                        .font(.golem(Tokens.Mobile.FontSize.title, Tokens.FontWeight.semibold))
                        .foregroundStyle(Tokens.Mobile.Colors.title)
                        .lineLimit(1)
                        .fixedSize()
                        // Linear's title starts 12 pt from the edge, where the bar puts its first item at 20.
                        .padding(.leading, -8)
                        .accessibilityAddTraits(.isHeader)
                }
                .sharedBackgroundVisibility(.hidden)
            }
    }

    /// A pushed screen: the bar holds only the back button and the glass buttons, as on Linear's issue screen; the
    /// title stays for accessibility and the back menu, and the screen shows it in its content.
    func pushedScreen(_ title: String) -> some View {
        navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(removing: .title)
    }

    /// The page background of a mobile screen.
    func mobileBackground() -> some View {
        background(Tokens.Mobile.Colors.background)
            .scrollContentBackground(.hidden)
            // Content fades under the glass bars, as Linear's does.
            .scrollEdgeEffectStyle(.soft, for: .all)
    }
}

/// The title of a pushed screen at the top of its content, as Linear's issue title: an optional small caption
/// above, such as the channel of a thread.
struct DetailTitle: View {
    let title: String
    var caption: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.xs) {
            if let caption {
                Text(caption)
                    .font(.golem(Tokens.Mobile.FontSize.caption, Tokens.FontWeight.book))
                    .foregroundStyle(Tokens.Mobile.Colors.textTertiary)
            }
            Text(title)
                .font(.golem(Tokens.Mobile.FontSize.detailTitle, Tokens.FontWeight.semibold))
                .foregroundStyle(Tokens.Mobile.Colors.text)
                .accessibilityAddTraits(.isHeader)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Pills that switch the view of a screen, as Linear's Assigned, Created, and Subscribed: the selected one sits
/// in glass, the others are plain text. An optional count follows each title.
struct PillBar<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [Value]
    let title: (Value) -> String
    var count: ((Value) -> Int?)?

    var body: some View {
        GlassEffectContainer {
            HStack(spacing: 7) {
                ForEach(options, id: \.self) { option in
                    let selected = option == selection
                    Button { selection = option } label: {
                        HStack(spacing: Tokens.Space.md) {
                            Text(title(option))
                                .foregroundStyle(
                                    selected ? Tokens.Mobile.Colors.text : Tokens.Mobile.Colors.textSecondary
                                )
                            if let value = count?(option) {
                                Text("\(value)").foregroundStyle(Tokens.Mobile.Colors.textQuaternary)
                            }
                        }
                        .font(.golem(Tokens.Mobile.FontSize.small, Tokens.FontWeight.book))
                        .padding(.horizontal, Tokens.Space.lg)
                        .frame(height: Tokens.Mobile.Size.pill)
                        .contentShape(.capsule)
                    }
                    .buttonStyle(.plain)
                    .glassEffect(selected ? .regular.interactive() : .identity, in: .capsule)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
        }
        .padding(.horizontal, Tokens.Space.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(Tokens.Easing.ease(Tokens.Duration.fast), value: selection)
    }
}

/// The heading of a list section, as Linear's "In Progress": small and dim, with an optional add button.
struct ListSectionHeader: View {
    let title: String
    /// Opens what the section lists, such as the channel.
    var open: (() -> Void)?
    var add: (label: String, action: () -> Void)?

    var body: some View {
        HStack {
            Button { open?() } label: {
                Text(title)
                    .font(.golem(Tokens.Mobile.FontSize.small, Tokens.FontWeight.book))
                    .foregroundStyle(Tokens.Mobile.Colors.textQuaternary)
                    .frame(minHeight: Tokens.Size.listRow)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(open == nil)
            .accessibilityAddTraits(.isHeader)
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
}

/// A list row: an icon, a title, and trailing content. Rows sit 10 pt in from the screen edge with their content
/// 10 pt further in, as Linear's.
struct ListRow<Trailing: View>: View {
    let title: String
    var systemImage: String?
    var subtitle: String?
    var working = false
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: Tokens.Space.md) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 15))
                    .foregroundStyle(Tokens.Mobile.Colors.textSecondary)
                    .frame(width: 21)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.golem(Tokens.Mobile.FontSize.row, Tokens.FontWeight.book))
                    .foregroundStyle(Tokens.Mobile.Colors.text)
                    .lineLimit(1)
                if let subtitle {
                    Text(subtitle)
                        .font(.golem(Tokens.Mobile.FontSize.small, Tokens.FontWeight.book))
                        .foregroundStyle(Tokens.Mobile.Colors.textTertiary)
                        .lineLimit(1)
                }
            }
            if working { ProgressView().controlSize(.mini).accessibilityLabel("Working") }
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

/// A round glass button with a symbol: the close buttons of sheets and the buttons of the artifacts panel.
struct GlassCircleButton: View {
    let label: String
    let systemImage: String
    var size: CGFloat = Tokens.Mobile.Size.header
    var tint: Color?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: size * 0.4, weight: .semibold))
                .foregroundStyle(tint == nil ? Tokens.Mobile.Colors.title : Tokens.Colors.onAccent)
                .frame(width: size, height: size)
                .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .glassEffect(tint.map { .regular.tint($0).interactive() } ?? .regular.interactive(), in: .circle)
        .accessibilityLabel(label)
    }
}

/// A row that lights up while a finger is on it: at once, then it fades out in 150 ms, as Linear's hover does.
struct RowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background {
                RoundedRectangle(cornerRadius: Tokens.Radius.xl)
                    .fill(configuration.isPressed ? Tokens.Mobile.Colors.fill : .clear)
                    .padding(.horizontal, 10)
            }
            .animation(
                configuration.isPressed ? nil : Tokens.Easing.ease(Tokens.Duration.fast), value: configuration.isPressed
            )
    }
}

extension ButtonStyle where Self == RowButtonStyle {
    static var row: RowButtonStyle { RowButtonStyle() }
}

/// A list section whose heading folds it, as Slack's Home sections: the chevron turns and the rows slide away.
struct FoldingSection<Content: View>: View {
    let title: String
    @Binding var folded: Bool
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.snappy) { folded.toggle() }
            } label: {
                HStack {
                    Text(title)
                        .font(.golem(Tokens.Mobile.FontSize.small, Tokens.FontWeight.medium))
                        .foregroundStyle(Tokens.Mobile.Colors.textSecondary)
                    Spacer()
                    Image(systemName: "chevron.down")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Tokens.Mobile.Colors.textQuaternary)
                        .rotationEffect(.degrees(folded ? -90 : 0))
                }
                .padding(.horizontal, Tokens.Mobile.Size.margin)
                .frame(minHeight: Tokens.Size.listRow)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(.isHeader)
            .accessibilityValue(folded ? "Folded" : "Open")
            if !folded {
                VStack(alignment: .leading, spacing: 0) { content }
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .clipped()
    }
}

/// The title of a screen in a glass capsule beside the back button, as Slack's channel header: the title over a
/// small caption. The caller wraps it in the screen's menu.
struct HeaderTitle: View {
    let title: String
    var caption: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title)
                .font(.golem(Tokens.Mobile.FontSize.row, Tokens.FontWeight.semibold))
                .foregroundStyle(Tokens.Mobile.Colors.title)
            if let caption {
                Text(caption)
                    .font(.golem(Tokens.Mobile.FontSize.caption, Tokens.FontWeight.book))
                    .foregroundStyle(Tokens.Mobile.Colors.textTertiary)
                    .contentTransition(.opacity)
            }
        }
        .lineLimit(1)
        .padding(.horizontal, Tokens.Space.sm)
        .frame(maxWidth: 220, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// Golem at work, as Slack's typing line: three dots that light in turn, then the words.
struct WorkingLabel: View {
    var text = "Golem is working"

    var body: some View {
        HStack(spacing: Tokens.Space.sm) {
            Image(systemName: "ellipsis")
                .symbolEffect(.variableColor.iterative.dimInactiveLayers, options: .repeating)
                .foregroundStyle(Tokens.Colors.accent)
            Text(text)
        }
        .font(.golem(Tokens.Mobile.FontSize.small, Tokens.FontWeight.book))
        .foregroundStyle(Tokens.Mobile.Colors.textSecondary)
    }
}
