import AVFoundation
import UIKit

/// The phone itself (UIKit and AVFoundation): links, the clipboard, its state, the flashlight, and the brightness.
enum PhoneDevice {
    private struct OpenArguments: Decodable {
        let url: String
    }

    private struct ClipboardArguments: Decodable {
        let text: String?
    }

    private struct FlashlightArguments: Decodable {
        let on: Bool
        let level: Float?
    }

    private struct BrightnessArguments: Decodable {
        let level: Double
    }

    private struct Status: Encodable {
        let batteryPercent: Int?
        let battery: String
        let lowPowerMode: Bool
        let model: String
        let ios: String
        let freeStorageGb: Double?
        let brightness: Double?
        let thermalState: String
    }

    static func open(_ call: PhoneCall) async throws -> PhoneAnswer {
        let text = try call.arguments(OpenArguments.self).url
        guard let url = URL(string: text), url.scheme != nil else { throw PhoneError("\(text) is not a URL.") }
        return PhoneAnswer(text: "Opening \(text).") {
            await UIApplication.shared.open(url)
        }
    }

    static func clipboard(_ call: PhoneCall) async throws -> PhoneAnswer {
        if let text = try call.arguments(ClipboardArguments.self).text {
            UIPasteboard.general.string = text
            return PhoneAnswer(text: "Copied.")
        }
        return PhoneAnswer(text: UIPasteboard.general.string ?? "The clipboard has no text.")
    }

    static func status(_: PhoneCall) async throws -> PhoneAnswer {
        let device = UIDevice.current
        device.isBatteryMonitoringEnabled = true
        let free = try? URL.homeDirectory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
            .volumeAvailableCapacityForImportantUsage
        let battery = switch device.batteryState {
        case .charging: "charging"
        case .full: "full"
        case .unplugged: "unplugged"
        default: "unknown"
        }
        let thermal = switch ProcessInfo.processInfo.thermalState {
        case .nominal: "nominal"
        case .fair: "fair"
        case .serious: "serious"
        case .critical: "critical"
        @unknown default: "unknown"
        }
        return try .json(Status(
            batteryPercent: device.batteryLevel < 0 ? nil : Int(device.batteryLevel * 100),
            battery: battery,
            lowPowerMode: ProcessInfo.processInfo.isLowPowerModeEnabled,
            model: device.model,
            ios: device.systemVersion,
            freeStorageGb: free.map { (Double($0) / 1e8).rounded() / 10 },
            brightness: screen().map { (Double($0.brightness) * 100).rounded() / 100 },
            thermalState: thermal
        ))
    }

    static func flashlight(_ call: PhoneCall) async throws -> PhoneAnswer {
        let arguments = try call.arguments(FlashlightArguments.self)
        guard let torch = AVCaptureDevice.default(for: .video), torch.hasTorch else {
            throw PhoneError("This phone has no flashlight.")
        }
        try torch.lockForConfiguration()
        defer { torch.unlockForConfiguration() }
        if arguments.on {
            try torch.setTorchModeOn(level: min(max(arguments.level ?? 1, 0.1), AVCaptureDevice.maxAvailableTorchLevel))
        } else {
            torch.torchMode = .off
        }
        return PhoneAnswer(text: arguments.on ? "The flashlight is on." : "The flashlight is off.")
    }

    static func brightness(_ call: PhoneCall) async throws -> PhoneAnswer {
        let level = try call.arguments(BrightnessArguments.self).level
        guard let screen = screen() else { throw PhoneError("The Golem app is not on screen.") }
        screen.brightness = CGFloat(min(max(level, 0), 1))
        return PhoneAnswer(text: "Brightness set.")
    }

    private static func screen() -> UIScreen? {
        UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.screen }.first
    }
}
