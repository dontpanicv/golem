import SwiftUI

/// The fine 8 × 8 Bayer dither, on or off: a cell is 1 device pixel at 2x and 2 at 3x, about 0.5 pt. The images
/// are templates that take the foreground style. The web's `dither.ts` has the same patterns.
nonisolated enum Dither: Hashable, Sendable {
    case selected
    case corner(Int)

    private static let ranks = [
        [0, 32, 8, 40, 2, 34, 10, 42],
        [48, 16, 56, 24, 50, 18, 58, 26],
        [12, 44, 4, 36, 14, 46, 6, 38],
        [60, 28, 52, 20, 62, 30, 54, 22],
        [3, 35, 11, 43, 1, 33, 9, 41],
        [51, 19, 59, 27, 49, 17, 57, 25],
        [15, 47, 7, 39, 13, 45, 5, 37],
        [63, 31, 55, 23, 61, 29, 53, 21]
    ]

    var size: CGSize {
        switch self {
        case .selected: CGSize(width: 48, height: 16)
        case let .corner(side): CGSize(width: side, height: side)
        }
    }

    private func value(_ across: Double, _ down: Double) -> Double {
        switch self {
        case .selected: pow(across, 1.25)
        case .corner: ((across + down) / 2 - 0.48) * 2
        }
    }

    func image(scale: CGFloat) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        let cell = max(1, (scale / 2).rounded()) / scale
        let columns = Int(size.width / cell)
        let rows = Int(size.height / cell)
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            context.cgContext.setShouldAntialias(false)
            for y in 0 ..< rows {
                for x in 0 ..< columns {
                    let lit = value((Double(x) + 0.5) / Double(columns), (Double(y) + 0.5) / Double(rows))
                    if lit > (Double(Self.ranks[y % 8][x % 8]) + 0.5) / 64 {
                        context.cgContext.fill(CGRect(x: CGFloat(x) * cell, y: CGFloat(y) * cell, width: cell, height: cell))
                    }
                }
            }
        }.withRenderingMode(.alwaysTemplate)
    }
}

/// A dither pattern in the foreground style, repeated to fill its frame.
struct DitherView: View {
    let pattern: Dither
    @Environment(\.displayScale) private var scale

    var body: some View {
        Image(uiImage: pattern.image(scale: scale))
            .resizable(resizingMode: .tile)
            .interpolation(.none)
            .accessibilityHidden(true)
    }
}

/// A dotted line of pixels: under a header and between groups.
struct DottedLine: View {
    var color = Tokens.Mobile.Colors.textQuaternary

    var body: some View {
        DottedShape().stroke(color, style: StrokeStyle(lineWidth: 1, dash: [1, 3])).frame(height: 1)
    }
}

nonisolated private struct DottedShape: Shape {
    func path(in rect: CGRect) -> Path {
        Path { $0.move(to: CGPoint(x: rect.minX, y: rect.midY)); $0.addLine(to: CGPoint(x: rect.maxX, y: rect.midY)) }
    }
}

/// A day of 24 cells: the hours gone, and the hour of `date` in the accent. The web's and Android's `DayStrip`.
struct DayStrip: View {
    let date: Date

    var body: some View {
        let hour = Calendar.current.component(.hour, from: date)
        HStack(spacing: 1) {
            ForEach(0 ..< 24, id: \.self) { index in
                Rectangle()
                    .fill(index == hour ? Tokens.Colors.accent
                        : index < hour ? Tokens.Colors.textQuaternary : Tokens.Colors.border)
                    .frame(width: 2, height: index == hour ? 12 : 8)
            }
        }
        .accessibilityHidden(true)
    }
}
