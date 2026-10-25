import SwiftUI

/// Buttons per design/components.md: four variants in four sizes. The visual height follows the spec;
/// the touch target always reaches 44 pt.
struct GolemButtonStyle: ButtonStyle {
    enum Variant { case primary, secondary, ghost, danger }
    enum Size { case regular, small, icon, large }

    var variant: Variant = .secondary
    var size: Size = .regular
    /// A circle instead of the icon square: the composer's send button.
    var round = false
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.onRaisedSurface) private var onRaisedSurface

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed && isEnabled
        let shape = RoundedRectangle(cornerRadius: radius)
        configuration.label
            .labelStyle(ButtonLabelStyle(iconOnly: size == .icon || round))
            .font(.golem(Tokens.FontSize.md, Tokens.FontWeight.medium))
            .lineLimit(1)
            .foregroundStyle(foreground)
            .padding(.horizontal, size == .icon || round ? 0 : Tokens.Space.lg)
            .frame(minWidth: height, maxWidth: size == .large ? .infinity : nil, minHeight: height, maxHeight: height)
            .background(background(pressed: pressed), in: shape)
            .overlay(shape.strokeBorder(ring, lineWidth: 0.5))
            .shadow(variant == .primary ? Tokens.Shadows.low : [])
            .opacity(isEnabled ? 1 : 0.5)
            // The visual size stays; the hit area grows to 44 pt.
            .contentShape(.interaction, Rectangle().inset(by: -max(0, (Tokens.Size.listRow - height) / 2)))
            .contentShape(.hoverEffect, shape)
            .animation(Tokens.Easing.out(Tokens.Duration.fast), value: pressed)
    }

    private var height: CGFloat {
        switch size {
        case .regular: Tokens.Size.control
        case .small, .icon: Tokens.Size.controlSmall
        case .large: Tokens.Size.controlLarge
        }
    }

    private var radius: CGFloat {
        switch size {
        case .regular, .large: Tokens.Radius.full
        case .small, .icon: round ? Tokens.Radius.full : Tokens.Radius.md
        }
    }

    private var foreground: Color {
        switch variant {
        case .primary: Tokens.Colors.onAccent
        case .secondary, .ghost: Tokens.Colors.textSecondary
        case .danger: Tokens.Colors.danger
        }
    }

    private var ring: Color {
        variant == .secondary || variant == .danger ? Tokens.Colors.borderStrong : .clear
    }

    private func background(pressed: Bool) -> Color {
        switch variant {
        case .primary: pressed ? Tokens.Colors.accentHover : Tokens.Colors.accent
        case .secondary, .danger: pressed ? Tokens.Colors.surfaceHover : Tokens.Colors.surfaceRaised
        case .ghost: pressed ? (onRaisedSurface ? Tokens.Colors.surfaceHover : Tokens.Colors.fillHover) : .clear
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
    static var send: GolemButtonStyle { GolemButtonStyle(variant: .primary, round: true) }
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
            .foregroundStyle(Tokens.Colors.accent)
            .opacity(configuration.isPressed ? 0.6 : 1)
            .frame(minHeight: Tokens.Size.listRow)
            .contentShape(.rect)
    }
}

extension ButtonStyle where Self == LinkButtonStyle {
    static var link: LinkButtonStyle { LinkButtonStyle() }
}
