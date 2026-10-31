import Foundation

/// The person's own machines in the workspace, which they share or keep private, and the ones other members shared.
extension APIClient {
    func machines(workspaceID: String) async throws -> Machines {
        try await get("/api/v1/workspaces/\(workspaceID)/machines")
    }

    func startPairing(workspaceID: String) async throws -> Pairing {
        try await post("/api/v1/workspaces/\(workspaceID)/machines/pairing")
    }

    /// Shares the person's machine with every member's turns, or makes it private to their own again.
    func setMachineShared(workspaceID: String, machineID: String, shared: Bool) async throws -> Machine {
        try decode(
            try await send("PUT", "/api/v1/workspaces/\(workspaceID)/machines/\(machineID)", ["shared": shared]).data
        )
    }

    func removeMachine(workspaceID: String, machineID: String) async throws {
        _ = try await send("DELETE", "/api/v1/workspaces/\(workspaceID)/machines/\(machineID)")
    }
}

struct Machine: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let system: String
    let arch: String
    let version: String
    /// The person who paired it; only they share or remove it.
    let pairedBy: String
    let pairedByName: String
    /// Whether every member's turns use it; else only its person's.
    var shared: Bool

    enum CodingKeys: String, CodingKey {
        case id, name, arch, version, pairedBy, pairedByName, shared
        case system = "os"
    }

    /// "macOS arm64 · hands 0.5.0"
    var summary: String {
        let names = ["macos": "macOS", "linux": "Linux"]
        return "\(names[system] ?? system) \(arch) · hands \(version)"
    }
}

struct Pairing: Codable, Hashable {
    let command: String
    let expiresAt: Double
}

struct Machines: Codable {
    let machines: [Machine]
    let pairing: Pairing?
}
