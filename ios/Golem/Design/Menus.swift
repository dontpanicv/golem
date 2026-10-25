import SwiftUI

// Menus and selects are the native iOS menu, as in Linear's iOS app: glass, grown from the button that opens it.

/// A button that opens a native menu of `MenuItem`s, separators, and section labels.
/// Style the trigger with `.buttonStyle` as for any button.
struct GolemMenu<Label: View, Content: View>: View {
    @ViewBuilder let content: Content
    @ViewBuilder let label: Label

    var body: some View {
        Menu { content } label: { label }
    }
}

/// A select: the value with an up-and-down chevron, as Linear's settings show it, that opens a native menu of the
/// options with a check on the selected one.
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
        Menu {
            Picker(selection: $selection) {
                ForEach(options, id: \.self) { option in Text(title(option)).tag(option) }
            } label: {
                EmptyView()
            }
            .pickerStyle(.inline)
        } label: {
            HStack(spacing: Tokens.Space.sm) {
                Text(title(selection))
                    .font(.golem(Tokens.Mobile.FontSize.row, Tokens.FontWeight.book))
                    .foregroundStyle(Tokens.Mobile.Colors.text)
                    .lineLimit(1)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Tokens.Mobile.Colors.textQuaternary)
            }
            .frame(minHeight: Tokens.Size.listRow)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityValue(title(selection))
    }
}

/// A menu row: optional leading icon, title, and a check when it is the selected option.
struct MenuItem: View {
    let title: String
    var systemImage: String?
    var checked = false
    var role: ButtonRole?
    let action: @MainActor () -> Void

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
        Button(role: role, action: action) {
            if let icon = checked ? "checkmark" : systemImage {
                Label(title, systemImage: icon)
            } else {
                Text(title)
            }
        }
    }
}

struct MenuSeparator: View {
    var body: some View { Divider() }
}

/// A heading inside a menu; the native menu shows it as a dimmed row.
struct MenuSectionLabel: View {
    let title: String

    init(_ title: String) { self.title = title }

    var body: some View { Text(title) }
}
