import SwiftUI

/// A shape from the cells of a pixel grid, written as the web writes it in SVG: absolute `M`, `H`, `V`, and `Z` only,
/// so that both apps draw the same strings. `inset` cells of the `cells` grid are left empty around it.
nonisolated struct PixelShape: Shape {
    let path: String
    var cells: CGFloat = 8
    var inset: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / cells
        let point = { (x: Double, y: Double) in
            CGPoint(x: rect.minX + (x + inset) * scale, y: rect.minY + (y + inset) * scale)
        }
        let scanner = Scanner(string: path)
        var result = Path()
        var (x, y, startX, startY) = (0.0, 0.0, 0.0, 0.0)
        while let command = scanner.scanCharacter() {
            switch command {
            case "M":
                x = scanner.scanDouble() ?? x
                y = scanner.scanDouble() ?? y
                (startX, startY) = (x, y)
                result.move(to: point(x, y))
            case "H":
                x = scanner.scanDouble() ?? x
                result.addLine(to: point(x, y))
            case "V":
                y = scanner.scanDouble() ?? y
                result.addLine(to: point(x, y))
            case "Z":
                result.closeSubpath()
                (x, y) = (startX, startY)
            default:
                break
            }
        }
        return result
    }
}

extension Image {
    /// An icon of the 16 × 16 pixel set as a template image, 1 pt a pixel by default, so that native menus and buttons
    /// can show it.
    init(pixel: Pixel, size: CGFloat = 16) {
        self.init(uiImage: PixelImages.image(pixel, size: size))
    }
}

extension Label where Title == Text, Icon == Image {
    init(_ title: LocalizedStringKey, pixel: Pixel) {
        self.init { Text(title) } icon: { Image(pixel: pixel) }
    }

    @_disfavoredOverload
    init(_ title: some StringProtocol, pixel: Pixel) {
        self.init { Text(title) } icon: { Image(pixel: pixel) }
    }
}

extension Button where Label == SwiftUI.Label<Text, Image> {
    init(_ title: LocalizedStringKey, pixel: Pixel, role: ButtonRole? = nil, action: @escaping () -> Void) {
        self.init(role: role, action: action) { SwiftUI.Label(title, pixel: pixel) }
    }

    @_disfavoredOverload
    init(_ title: some StringProtocol, pixel: Pixel, role: ButtonRole? = nil, action: @escaping () -> Void) {
        self.init(role: role, action: action) { SwiftUI.Label(title, pixel: pixel) }
    }
}

extension Menu where Label == SwiftUI.Label<Text, Image> {
    init(_ title: some StringProtocol, pixel: Pixel, @ViewBuilder content: () -> Content) {
        self.init(content: content) { SwiftUI.Label(title, pixel: pixel) }
    }
}

enum PixelImages {
    private static var cache: [String: UIImage] = [:]

    static func image(_ pixel: Pixel, size: CGFloat) -> UIImage { image(path: pixel.rawValue, cells: 16, size: size) }

    /// A path of a pixel grid as a template image, with no smoothing at the edges of its cells.
    static func image(path: String, cells: CGFloat, size: CGFloat) -> UIImage {
        let key = "\(path)@\(size)"
        if let image = cache[key] { return image }
        let rect = CGRect(x: 0, y: 0, width: size, height: size)
        let image = UIGraphicsImageRenderer(size: rect.size).image { context in
            context.cgContext.setShouldAntialias(false)
            context.cgContext.addPath(PixelShape(path: path, cells: cells).path(in: rect).cgPath)
            context.cgContext.fillPath()
        }.withRenderingMode(.alwaysTemplate)
        cache[key] = image
        return image
    }
}

/// The colors of Golem's logo. In light, a black tile keeps the white face apart from the white surface.
enum Ember {
    static let ink = Color(light: "#000000", dark: "#000000")
    static let tile = Color(light: "#000000", dark: "#00000000")
    static let face = Color(light: "#ffffff", dark: "#ffffff")
    static let eyes = Tokens.Colors.accent
}

/// Four pixels in a square that light in turn, clockwise: Golem works.
struct PixelSpinner: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.periodic(from: .now, by: reduceMotion ? 3600 : 0.25)) { context in
            let lit = Int(context.date.timeIntervalSinceReferenceDate * 4) % 4
            Grid(horizontalSpacing: 1, verticalSpacing: 1) {
                GridRow { cell(0, lit); cell(1, lit) }
                GridRow { cell(3, lit); cell(2, lit) }
            }
        }
        .accessibilityElement()
        .accessibilityLabel("Working")
    }

    private func cell(_ index: Int, _ lit: Int) -> some View {
        Rectangle().fill(Tokens.Colors.accent).frame(width: 4, height: 4).opacity(index == lit ? 1 : 0.25)
    }
}

/// A light that runs over words that Golem is at now, as on the web.
struct Shimmer: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        if reduceMotion {
            content.foregroundStyle(Tokens.Mobile.Colors.text)
        } else {
            TimelineView(.animation) { context in
                let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.2) / 2.2
                let center = 1.5 - 2 * phase
                content.foregroundStyle(
                    LinearGradient(
                        colors: [Tokens.Mobile.Colors.textTertiary, Tokens.Mobile.Colors.title,
                                 Tokens.Mobile.Colors.textTertiary],
                        startPoint: UnitPoint(x: center - 0.5, y: 0.5), endPoint: UnitPoint(x: center + 0.5, y: 0.5)
                    )
                )
            }
        }
    }
}

/// The pixel icons of an agent's cards, in the accent on a black tile. The web's `cards.tsx` has the
/// same paths.
struct PixelIcon: View {
    static let paths: [String: String] = [
        "temperature": "M3 0H5V5H6V7H5V8H3V7H2V5H3Z",
        "heat": "M4 0H5V1H6V3H7V6H6V7H5V8H3V7H2V6H1V3H2V2H3V1H4Z",
        "rain": "M2 1H5V2H6V3H7V5H1V4H0V3H1V2H2ZM1 6H2V7H1ZM3 6H4V8H3ZM5 6H6V7H5Z",
        "sun": "M3 2H5V3H6V5H5V6H3V5H2V3H3ZM3 0H5V1H3ZM3 7H5V8H3ZM0 3H1V5H0ZM7 3H8V5H7Z",
        "battery": "M0 2H7V3H8V5H7V6H0ZM1 3V5H4V3Z",
        "bolt": "M4 0H6V1H5V3H7V4H6V5H5V6H4V7H3V8H2V5H1V4H3V2H4Z",
        "car": "M2 1H6V2H7V4H8V6H7V7H5V6H3V7H1V6H0V4H1V2H2ZM2 2V4H6V2Z",
        "home": "M3 0H5V1H6V2H7V3H8V4H7V8H5V5H3V8H1V4H0V3H1V2H2V1H3Z",
        "lock": "M2 0H6V1H7V3H8V8H0V3H1V1H2ZM2 1V3H6V1ZM3 4V6H5V4Z"
    ]

    let path: String
    var size: CGFloat = 32

    var body: some View {
        PixelShape(path: path, cells: 12, inset: 2)
            .fill(Ember.eyes, style: FillStyle(eoFill: true))
            .frame(width: size, height: size)
            .background(Ember.ink)
            .accessibilityHidden(true)
    }
}
