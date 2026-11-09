import SwiftUI
import UIKit

// The Golem design system for iOS. Values come from Tokens.swift, generated from design/tokens.json,
// so the app matches the web components in public/styles.css.

extension Color {
    /// A color that follows the light or dark appearance. Hex is `#rrggbb` or `#rrggbbaa`.
    init(light: String, dark: String) {
        let light = UIColor(hex: light), dark = UIColor(hex: dark)
        // SwiftUI resolves colors on its render thread too, so the provider must not be main-actor isolated.
        self.init(uiColor: UIColor { @Sendable traits in
            traits.userInterfaceStyle == .dark ? dark : light
        })
    }
}

extension UIColor {
    convenience init(hex: String) {
        let value = UInt64(hex.dropFirst(), radix: 16) ?? 0
        let hasAlpha = hex.count == 9
        let rgb = hasAlpha ? value >> 8 : value
        self.init(
            red: CGFloat((rgb >> 16) & 0xff) / 255,
            green: CGFloat((rgb >> 8) & 0xff) / 255,
            blue: CGFloat(rgb & 0xff) / 255,
            alpha: hasAlpha ? CGFloat(value & 0xff) / 255 : 1
        )
    }
}

extension Font {
    /// Inter at a token size; scales with Dynamic Type.
    static func golem(_ size: CGFloat, _ weight: Font.Weight = Tokens.FontWeight.regular) -> Font {
        .custom("Inter Variable", size: size, relativeTo: .body).weight(weight)
    }

    /// Geist Mono at a token size, for times, counts, and values: regular, or medium and heavier as medium.
    static func mono(_ size: CGFloat, _ weight: Font.Weight = Tokens.FontWeight.regular) -> Font {
        .custom(weight == Tokens.FontWeight.regular ? "GeistMono-Regular" : "GeistMono-Medium", size: size,
                relativeTo: .caption)
    }

    /// Silkscreen at its one size, for section labels. Pixel type does not scale with Dynamic Type.
    static var pixel: Font { .custom("Silkscreen-Regular", fixedSize: Tokens.FontSize.pixel) }
}

struct Shadow {
    let y: CGFloat
    let blur: CGFloat
    let color: Color
}

extension View {
    func shadow(_ layers: [Shadow]) -> some View {
        layers.reduce(AnyView(self)) { view, layer in
            AnyView(view.shadow(color: layer.color, radius: layer.blur / 2, y: layer.y))
        }
    }

    /// A raised card: a settings card with a 0.5 pt `ring`, or the composer with its own fill and no ring, and the
    /// `low` shadow.
    func raisedCard(
        radius: CGFloat = Tokens.Radius.lg, fill: Color = Tokens.Colors.surfaceRaised, ring: Color = Tokens.Colors.ring
    ) -> some View {
        background(fill, in: .rect(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(ring, lineWidth: 0.5))
            .shadow(Tokens.Shadows.low)
    }

    /// A floating card, the toast: the menu surface, a 0.5 pt `ringControl` line, and the `menu` shadow.
    func floatingCard(radius: CGFloat = Tokens.Radius.xl) -> some View {
        background(Tokens.Colors.surfaceMenu, in: .rect(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(Tokens.Colors.ringControl, lineWidth: 0.5))
            .shadow(Tokens.Shadows.menu)
    }
}

// MARK: - Small components

/// A person's picture, or their initial on an accent tile whose corner dissolves.
struct Avatar: View {
    let name: String
    var image: UIImage?
    var agent = false
    var size = Tokens.Size.avatar

    var body: some View {
        if let image {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: size, height: size)
                .clipped()
                .accessibilityHidden(true)
        } else {
            initial
        }
    }

    private var initial: some View {
        let cell = max(1, (size / 12).rounded(.down))
        let cells = size / cell
        // The first letter without its accent, 2 pt or 3 pt a pixel; an initial outside the set shows as `?`.
        let letter = String(name.prefix(1)).decomposedStringWithCanonicalMapping.uppercased().first ?? "?"
        return ZStack {
            Tokens.Colors.accent
            DitherView(pattern: .corner(Int(size))).foregroundStyle(Tokens.Colors.canvas)
            PixelShape(path: pixelLetters[letter] ?? pixelLetters["?"]!, cells: cells, inset: (cells - 12) / 2)
                .fill(Tokens.Colors.onAccent)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// Golem's face, the 8 × 8 pixels at the small sizes; from 48 pt it is the dissolving logo.
struct GolemMark: View {
    var size = Tokens.Size.avatar

    var body: some View {
        if size >= 48 {
            Image("Mark")
                .resizable()
                .interpolation(.none)
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        } else {
            GolemFace(mood: .resting, size: size)
        }
    }
}

struct Badge: View {
    enum Tone { case neutral, accent, success, warning, danger }

    let label: String
    var tone = Tone.neutral

    var body: some View {
        HStack(spacing: Tokens.Space.sm) {
            Rectangle().fill(color).frame(width: Tokens.Size.dot, height: Tokens.Size.dot)
            Text(label)
        }
        .font(.golem(Tokens.Mobile.FontSize.small, Tokens.FontWeight.book))
        .foregroundStyle(Tokens.Mobile.Colors.textSecondary)
        .frame(minHeight: Tokens.Size.controlTiny)
    }

    private var color: Color {
        switch tone {
        case .neutral: Tokens.Colors.textQuaternary
        case .accent: Tokens.Colors.accent
        case .success: Tokens.Colors.success
        case .warning: Tokens.Colors.warning
        case .danger: Tokens.Colors.danger
        }
    }
}

/// A file attached to a message, or picked in the composer; picked files have a button that takes them out.
struct FileChip: View {
    let name: String
    var remove: (() -> Void)?

    var body: some View {
        HStack(spacing: Tokens.Space.xs) {
            Image(pixel: .attach).foregroundStyle(Tokens.Colors.textTertiary)
            Text(name).lineLimit(1).truncationMode(.middle)
            if let remove {
                Button("Remove \(name)", pixel: .close, action: remove)
                    .labelStyle(.iconOnly)
                    .foregroundStyle(Tokens.Colors.textTertiary)
                    .frame(minWidth: Tokens.Size.listRow, minHeight: Tokens.Size.listRow)
                    .padding(.horizontal, -Tokens.Space.lg)
            }
        }
        .font(.golem(Tokens.FontSize.sm))
        .foregroundStyle(Tokens.Colors.textSecondary)
        .padding(.leading, Tokens.Space.md)
        .padding(.trailing, 10)
        .frame(maxWidth: 240, minHeight: Tokens.Size.controlSmall)
        .background(Tokens.Colors.fillSubtle, in: .rect(cornerRadius: Tokens.Radius.md))
        .overlay(
            RoundedRectangle(cornerRadius: Tokens.Radius.md)
                .strokeBorder(Tokens.Colors.ring, lineWidth: 0.5)
        )
        // Touch target: 44 pt where the web chip is 28 px.
        .frame(minHeight: Tokens.Size.listRow)
        .contentShape(.rect)
    }
}

/// A keyboard shortcut.
struct Keycap: View {
    let key: String

    var body: some View {
        Text(key)
            .font(.golem(Tokens.FontSize.xs, Tokens.FontWeight.regular))
            .foregroundStyle(Tokens.Colors.textTertiary)
            .padding(Tokens.Space.xxs)
            .frame(minWidth: 18, minHeight: 17)
            .overlay(
                RoundedRectangle(cornerRadius: Tokens.Radius.xs)
                    .strokeBorder(Tokens.Colors.borderSubtle, lineWidth: 0.5)
            )
    }
}

/// A sidebar or list row: icon, label, optional count. Selected rows use the active fill.
struct NavRow: View {
    let title: String
    let pixel: Pixel
    var selected = false
    var count: Int?
    /// A thread whose agent works shows a spinner.
    var working = false
    /// Shows in place of the symbol when set.
    var emoji: String?
    /// A private channel, which only its person sees.
    var locked = false
    /// Golem's face in place of the symbol.
    var golem = false

    var body: some View {
        HStack(spacing: Tokens.Space.md) {
            Group {
                if golem {
                    GolemGlyph(size: 12)
                } else if let emoji {
                    Text(emoji).font(.system(size: Tokens.Size.icon * 0.8))
                } else {
                    Image(pixel: pixel)
                }
            }
            .frame(width: Tokens.Size.icon)
            Text(title).lineLimit(1)
            if locked {
                Image(pixel: .lock, size: 8)
                    .accessibilityLabel("Private")
            }
            if working { PixelSpinner() }
            Spacer(minLength: 0)
            if let count {
                Text("\(count)").font(.mono(Tokens.FontSize.mono, Tokens.FontWeight.semibold))
                    .foregroundStyle(Tokens.Colors.accent)
            }
        }
        .font(.golem(Tokens.FontSize.lg, Tokens.FontWeight.medium))
        .foregroundStyle(selected ? Tokens.Colors.text : Tokens.Colors.textTertiary)
        .padding(.horizontal, Tokens.Space.sm)
        // Touch target: 44 pt on iOS where the web row is 28 px.
        .frame(minHeight: Tokens.Size.listRow)
        // The content stops before the dither, which is never under text.
        .padding(.trailing, selected ? 36 : 0)
        .background(alignment: .trailing) {
            if selected {
                DitherView(pattern: .selected).foregroundStyle(Tokens.Colors.accent).frame(width: 48)
            }
        }
        .background(selected ? Tokens.Colors.fillActive : .clear)
        .contentShape(.rect)
    }
}

struct SectionHeader: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.pixel)
            .textCase(.uppercase)
            .foregroundStyle(Tokens.Colors.textTertiary)
            .padding(.horizontal, Tokens.Space.sm)
            .padding(.top, Tokens.Space.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A dithered Golem face over the title.
struct EmptyState: View {
    let title: String

    var body: some View {
        VStack(spacing: Tokens.Space.md) {
            DitherView(pattern: .emptyFace)
                .foregroundStyle(Tokens.Colors.textTertiary)
                .frame(width: 96, height: 96)
            Text(title)
                .font(.golem(Tokens.FontSize.md, Tokens.FontWeight.medium))
                .foregroundStyle(Tokens.Colors.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(Tokens.Space.xxxl)
    }
}
