import SwiftUI

/// Buttons per design/components.md: four variants in five sizes, all pills; secondary buttons are glass, as Linear's
/// iOS pills are. The visual height follows the spec; the touch target always reaches 44 pt. A press shows at once and
/// fades out in 150 ms, as a hover does on the web.
struct GolemButtonStyle: ButtonStyle {
    enum Variant { case primary, secondary, ghost, danger }
    enum Size { case regular, small, icon, tiny, large }

    var variant: Variant = .secondary
    var size: Size = .regular
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed && isEnabled
        let iconOnly = size == .icon || size == .tiny
        configuration.label
            .labelStyle(ButtonLabelStyle(iconOnly: iconOnly))
            .font(.golem(size == .small ? Tokens.FontSize.sm : Tokens.FontSize.md, Tokens.FontWeight.medium))
            .lineLimit(1)
            .foregroundStyle(foreground(pressed: pressed))
            .padding(.horizontal, iconOnly ? 0 : size == .small ? 10 : Tokens.Space.lg)
            .frame(minWidth: height, maxWidth: size == .large ? .infinity : nil, minHeight: height, maxHeight: height)
            .background(background(pressed: pressed), in: .capsule)
            .glassEffect(variant == .secondary ? .regular.interactive() : .identity, in: .capsule)
            .shadow(variant == .primary ? Tokens.Shadows.low : [])
            .opacity(isEnabled ? 1 : 0.6)
            // The visual size stays; the hit area grows to 44 pt.
            .contentShape(.interaction, Rectangle().inset(by: -max(0, (Tokens.Size.listRow - height) / 2)))
            .contentShape(.hoverEffect, .capsule)
            .animation(pressed ? nil : Tokens.Easing.ease(Tokens.Duration.fast), value: pressed)
    }

    private var height: CGFloat {
        switch size {
        case .regular: Tokens.Size.control
        case .small, .icon: Tokens.Size.controlSmall
        case .tiny: Tokens.Size.controlTiny
        case .large: Tokens.Size.controlLarge
        }
    }

    private func foreground(pressed: Bool) -> Color {
        switch variant {
        case .primary: Tokens.Colors.onAccent
        case .secondary: Tokens.Mobile.Colors.text
        case .ghost: pressed ? Tokens.Colors.text : Tokens.Colors.textTertiary
        case .danger: Tokens.Colors.danger
        }
    }

    private func background(pressed: Bool) -> Color {
        switch variant {
        case .primary: pressed ? Tokens.Colors.accentHover : Tokens.Colors.accent
        case .secondary: .clear
        // Translucent, so it fits every surface.
        case .ghost: pressed ? Tokens.Colors.ghostHover : .clear
        case .danger: pressed ? Tokens.Colors.dangerSubtle : .clear
        }
    }
}

/// Icon buttons show only the symbol and keep the title as the accessibility label.
private struct ButtonLabelStyle: LabelStyle {
    let iconOnly: Bool

    func makeBody(configuration: Configuration) -> some View {
        if iconOnly {
            Label(configuration).labelStyle(.iconOnly)
        } else {
            HStack(spacing: Tokens.Space.sm) {
                configuration.icon
                configuration.title
            }
        }
    }
}

extension ButtonStyle where Self == GolemButtonStyle {
    static var primary: GolemButtonStyle { GolemButtonStyle(variant: .primary) }
    static var secondary: GolemButtonStyle { GolemButtonStyle(variant: .secondary) }
    static var ghost: GolemButtonStyle { GolemButtonStyle(variant: .ghost) }
    static var danger: GolemButtonStyle { GolemButtonStyle(variant: .danger) }
    /// The composer's send button: a tiny primary circle.
    static var send: GolemButtonStyle { GolemButtonStyle(variant: .primary, size: .tiny) }
    static func golem(
        _ variant: GolemButtonStyle.Variant, _ size: GolemButtonStyle.Size = .regular
    ) -> GolemButtonStyle {
        GolemButtonStyle(variant: variant, size: size)
    }
}

/// A text link: the sign-in and sign-up switch.
struct LinkButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.golem(Tokens.FontSize.md, Tokens.FontWeight.medium))
            .foregroundStyle(configuration.isPressed ? Tokens.Colors.accentHover : Tokens.Colors.accent)
            .frame(minHeight: Tokens.Size.listRow)
            .contentShape(.rect)
    }
}

extension ButtonStyle where Self == LinkButtonStyle {
    static var link: LinkButtonStyle { LinkButtonStyle() }
}
