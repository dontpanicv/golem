import SwiftUI

// The building blocks of the iPhone screens, in Ember: flat, square, with hairlines, and never the system's glass. A
// `ToolbarItem` needs `.sharedBackgroundVisibility(.hidden)`, or iOS draws its glass around the item.

extension View {
    /// Ember's surface for what floats over content or stands in a bar: the flat `fill` and a 1 pt hairline.
    func barSurface(_ shown: Bool = true) -> some View {
        background(shown ? Tokens.Mobile.Colors.fill : .clear, in: .rect)
            .overlay(Rectangle().strokeBorder(shown ? Tokens.Mobile.Colors.separator : .clear))
    }

    /// A sheet in Ember: the flat background and square corners.
    func emberSheet() -> some View {
        presentationBackground(Tokens.Mobile.Colors.background).presentationCornerRadius(0)
    }

    /// The screen's title at the leading edge of the navigation bar, level with its buttons, as Linear's
    /// top-level screens show it. The bar's own title stays for accessibility and the back menu. In a sheet
    /// (``EnvironmentValues/closeSheet``), the title is in the middle with the close button at the leading edge.
    func screenTitle(_ title: String) -> some View {
        modifier(ScreenTitle(title: title))
    }

    /// A pushed screen: the bar holds only the back button and the screen's buttons, as on Linear's issue screen; the
    /// title stays for accessibility, and the screen shows it in its content.
    func pushedScreen(_ title: String) -> some View {
        modifier(PushedScreen(title: title))
    }

    /// A pushed screen, or nothing for a list that another screen shows inside it under its own title.
    @ViewBuilder
    func pushedScreen(_ title: String?) -> some View {
        if let title { pushedScreen(title) } else { self }
    }

    /// Lets the ``HeaderTitle`` of the screens inside grow to the trailing button of the bar: the width less the
    /// 20 pt margins, the 44 pt back and trailing buttons, and the gaps of 16 pt beside the title.
    func headerTitleRoom() -> some View { modifier(HeaderTitleRoom()) }

    /// The page background of a mobile screen.
    func mobileBackground() -> some View {
        background(Tokens.Mobile.Colors.background)
            .scrollContentBackground(.hidden)
            // No blur under the bars: the navigation bar is opaque, and the tab bar and composer are flat.
            .scrollEdgeEffectHidden(true, for: .all)
            .toolbarBackgroundVisibility(.visible, for: .navigationBar)
            .toolbarBackground(Tokens.Mobile.Colors.background, for: .navigationBar)
    }
}

extension EnvironmentValues {
    /// The widest a ``HeaderTitle`` fits between the back button and one trailing button; ``View/headerTitleRoom()``
    /// sets it from the screen's width.
    @Entry var headerTitleWidth: CGFloat = 220
    /// Closes the sheet that shows the screen; ``View/screenTitle(_:)`` then draws a sheet's title.
    @Entry var closeSheet: (() -> Void)?
}

private struct HeaderTitleRoom: ViewModifier {
    @State private var width: CGFloat?

    func body(content: Content) -> some View {
        content
            .environment(\.headerTitleWidth, width.map { max($0 - 2 * (20 + 44 + 16) - 24, 120) } ?? 220)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }
}

/// The system's back button is glass, so a pushed screen draws its own.
private struct PushedScreen: ViewModifier {
    let title: String
    @Environment(\.dismiss) private var dismiss
    @Environment(\.isPresented) private var isPresented

    func body(content: Content) -> some View {
        content
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(removing: .title)
            .navigationBarBackButtonHidden()
            .toolbar {
                if isPresented {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Back", pixel: .back) { dismiss() }.buttonStyle(.golem(.secondary, .header))
                    }
                    .sharedBackgroundVisibility(.hidden)
                }
            }
    }
}

/// Keeps the swipe back from the screen's edge, which SwiftUI turns off with the system's back button.
extension UINavigationController: @retroactive UIGestureRecognizerDelegate {
    override open func viewDidLoad() {
        super.viewDidLoad()
        interactivePopGestureRecognizer?.delegate = self
    }

    public func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        viewControllers.count > 1
    }
}

private struct ScreenTitle: ViewModifier {
    let title: String
    @Environment(\.closeSheet) private var closeSheet
    @Environment(\.youMenu) private var youMenu

    @ViewBuilder
    func body(content: Content) -> some View {
        if let closeSheet {
            // A square close button and the title in the middle. The bar keeps its title here, as removing it also
            // removes the middle item.
            content
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Close", pixel: .close, action: closeSheet).buttonStyle(.golem(.secondary, .header))
                    }
                    .sharedBackgroundVisibility(.hidden)
                    ToolbarItem(placement: .principal) {
                        Text(title)
                            .font(.golem(Tokens.Mobile.FontSize.sheetTitle, Tokens.FontWeight.semibold))
                            .foregroundStyle(Tokens.Mobile.Colors.title)
                            .lineLimit(1)
                            .accessibilityAddTraits(.isHeader)
                    }
                    .sharedBackgroundVisibility(.hidden)
                }
        } else {
            content
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar(removing: .title)
                .toolbar {
                    if let youMenu {
                        ToolbarItem(placement: .topBarLeading) { YouMenu(open: youMenu) }
                            .sharedBackgroundVisibility(.hidden)
                    }
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
    }
}

/// The title of a pushed screen at the top of its content, as Linear's issue title: an optional small caption
/// above, such as the topic of a chat.
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

/// Pills that switch the view of a screen, as Linear's Assigned, Created, and Subscribed: the selected one is on a
/// flat surface, the others are plain text. An optional count follows each title.
struct PillBar<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [Value]
    let title: (Value) -> String
    var count: ((Value) -> Int?)?

    var body: some View {
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
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .barSurface(selected)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
            }
        .padding(.horizontal, Tokens.Space.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(Tokens.Easing.ease(Tokens.Duration.fast), value: selection)
    }
}

/// A square button with a pixel icon: the close buttons of sheets and the buttons of the artifacts panel.
struct SquareIconButton: View {
    let label: String
    let pixel: Pixel
    var size: CGFloat = Tokens.Mobile.Size.header
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(pixel: pixel)
                .foregroundStyle(Tokens.Mobile.Colors.title)
                .frame(width: size, height: size)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .barSurface()
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
                        .font(.sectionLabel)
                        .textCase(.uppercase)
                        .foregroundStyle(Tokens.Mobile.Colors.textSecondary)
                    Spacer()
                    Image(pixel: .chevron)
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

/// The title of a screen on a flat surface beside the back button: the title over a small caption. The caller wraps it in the screen's menu.
struct HeaderTitle: View {
    let title: String
    var caption: String?
    @Environment(\.headerTitleWidth) private var maxWidth

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
        .padding(.horizontal, Tokens.Space.lg)
        // It hugs the title and grows up to the trailing button; any wider, the bar folds it into a menu.
        .frame(maxWidth: maxWidth, alignment: .leading)
        .frame(height: Tokens.Mobile.Size.header)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// Golem at work, as Slack's typing line: four pixels that light in turn, then the words.
struct WorkingLabel: View {
    var text = "Golem is working"

    var body: some View {
        HStack(spacing: Tokens.Space.sm) {
            PixelSpinner()
            Text(text)
        }
        .font(.golem(Tokens.Mobile.FontSize.small, Tokens.FontWeight.book))
        .foregroundStyle(Tokens.Mobile.Colors.textSecondary)
    }
}
