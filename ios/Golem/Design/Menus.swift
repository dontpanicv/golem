import SwiftUI

// Menus and selects: our own card in a popover, never a native Menu or Picker.

extension EnvironmentValues {
    @Entry var closeMenu = CloseMenuAction { $0() }
}

/// Closes the open menu, then runs the given action. Menu items call it.
nonisolated struct CloseMenuAction: Sendable {
    let run: @MainActor @Sendable (_ then: @escaping @MainActor () -> Void) -> Void

    @MainActor func callAsFunction(_ then: @escaping @MainActor () -> Void) { run(then) }
}

/// A button that opens a menu of `MenuItem`s, separators, and section labels below its label.
/// Style the trigger with `.buttonStyle` as for any button.
struct GolemMenu<Label: View, Content: View>: View {
    @ViewBuilder let content: Content
    @ViewBuilder let label: Label
    @State private var open = false

    var body: some View {
        Button { open = true } label: { label }
            .popover(isPresented: $open, attachmentAnchor: .rect(.bounds)) {
                MenuCard { content }
            }
    }
}

/// A select: a trigger showing the value that opens a menu of the options, with a check on the selected one.
struct GolemSelect<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [Value]
    let title: (Value) -> String

    init(selection: Binding<Value>, options: [Value], title: @escaping (Value) -> String = { "\($0)" }) {
        _selection = selection
        self.options = options
        self.title = title
    }

    var body: some View {
        GolemMenu {
            ForEach(options, id: \.self) { option in
                MenuItem(title(option), checked: option == selection) { selection = option }
            }
        } label: {
            Text(title(selection))
        }
        .buttonStyle(SelectTriggerStyle())
        .accessibilityValue(title(selection))
    }
}

private struct SelectTriggerStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        let height = Tokens.Size.control - 2
        configuration.label
            .font(.golem(Tokens.FontSize.md, Tokens.FontWeight.regular))
            .foregroundStyle(Tokens.Colors.text)
            .lineLimit(1)
            .padding(.leading, 10)
            .padding(.trailing, 28)
            .frame(height: height)
            .overlay(alignment: .trailing) {
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Tokens.Colors.textTertiary)
                    .frame(width: Tokens.Size.icon, height: Tokens.Size.icon)
                    .padding(.trailing, Tokens.Space.sm)
            }
            .background(
                configuration.isPressed ? Tokens.Colors.surfaceHover : Tokens.Colors.surfaceRaised,
                in: .rect(cornerRadius: Tokens.Radius.md)
            )
            .contentShape(.interaction, Rectangle().inset(by: -(Tokens.Size.listRow - height) / 2))
            .animation(Tokens.Easing.out(Tokens.Duration.fast), value: configuration.isPressed)
    }
}

/// The menu card inside the popover. It opens in 140 ms from 96 % toward the trigger and closes in 100 ms;
/// with Reduce Motion it only fades.
struct MenuCard<Content: View>: View {
    @ViewBuilder let content: Content
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .padding(.vertical, Tokens.Space.xs)
            .frame(minWidth: Tokens.Size.menuMinWidth, alignment: .leading)
            // The popover sizes itself to the ideal size of the card.
            .fixedSize()
            .opacity(shown ? 1 : 0)
            .scaleEffect(shown || reduceMotion ? 1 : 0.96, anchor: .top)
            .environment(\.onRaisedSurface, true)
            .environment(\.closeMenu, CloseMenuAction { then in
                withAnimation(.easeOut(duration: 0.1)) { shown = false } completion: {
                    dismiss()
                    then()
                }
            })
            .onAppear { withAnimation(Tokens.Easing.out(Tokens.Duration.menu)) { shown = true } }
            .presentationCompactAdaptation(.popover)
            .presentationBackground(Tokens.Colors.surfaceRaised)
    }
}

/// A menu row: optional leading icon, title, and a check when it is the selected option.
struct MenuItem: View {
    let title: String
    var systemImage: String?
    var checked = false
    var role: ButtonRole?
    let action: @MainActor () -> Void
    @Environment(\.closeMenu) private var closeMenu

    init(
        _ title: String, systemImage: String? = nil, checked: Bool = false, role: ButtonRole? = nil,
        action: @escaping @MainActor () -> Void
    ) {
        self.title = title
        self.systemImage = systemImage
        self.checked = checked
        self.role = role
        self.action = action
    }

    var body: some View {
        Button(role: role) {
            closeMenu(action)
        } label: {
            HStack(spacing: Tokens.Space.md) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(role == .destructive ? Tokens.Colors.danger : Tokens.Colors.textTertiary)
                        .frame(width: Tokens.Size.icon, height: Tokens.Size.icon)
                }
                Text(title).lineLimit(1)
                Spacer(minLength: 0)
            }
        }
        .buttonStyle(MenuItemStyle(checked: checked, destructive: role == .destructive))
        .accessibilityAddTraits(checked ? .isSelected : [])
    }
}

private struct MenuItemStyle: ButtonStyle {
    let checked: Bool
    let destructive: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.golem(Tokens.FontSize.md))
            .foregroundStyle(destructive ? Tokens.Colors.danger : Tokens.Colors.textSecondary)
            .padding(.leading, Tokens.Space.lg)
            .padding(.trailing, 35)
            // 44 pt rows where the web uses 32 px: iOS touch targets.
            .frame(maxWidth: .infinity, minHeight: Tokens.Size.listRow, alignment: .leading)
            .overlay(alignment: .trailing) {
                if checked {
                    Image(systemName: "checkmark")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Tokens.Colors.textSecondary)
                        .frame(width: Tokens.Size.icon, height: Tokens.Size.icon)
                        .padding(.trailing, Tokens.Space.lg)
                }
            }
            .background {
                RoundedRectangle(cornerRadius: Tokens.Radius.md)
                    .fill(configuration.isPressed ? Tokens.Colors.surfaceHover : .clear)
                    .padding(.horizontal, Tokens.Space.xs)
            }
            .contentShape(.rect)
    }
}

struct MenuSeparator: View {
    var body: some View {
        Rectangle()
            .fill(Tokens.Colors.border)
            .frame(height: 0.5)
            .padding(.vertical, Tokens.Space.xs)
    }
}

struct MenuSectionLabel: View {
    let title: String

    init(_ title: String) { self.title = title }

    var body: some View {
        Text(title)
            .font(.golem(Tokens.FontSize.xs, Tokens.FontWeight.medium))
            .foregroundStyle(Tokens.Colors.textTertiary)
            .padding(.horizontal, Tokens.Space.lg)
            .frame(height: 28, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }
}
