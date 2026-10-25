import Foundation

// Models mirror the TypeScript types in docs/api.md. Times are Unix milliseconds.

struct User: Codable, Hashable {
    let id: String
    let name: String
    let email: String
}

struct Workspace: Codable, Hashable, Identifiable {
    let id: String
    let name: String
}

struct ThreadSummary: Codable, Hashable, Identifiable {
    let id: String
    let channelId: String
    let title: String
    let updatedAt: Double
    let settledAt: Double?
}

struct Channel: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let summary: String?
    let threads: [ThreadSummary]
}

struct Message: Codable, Hashable, Identifiable {
    let id: String
    let authorId: String?
    let author: String
    let agent: Bool
    let text: String
    let time: Double
    let failed: Bool
    let streaming: Bool
    let files: [FileRef]
}

struct FileRef: Codable, Hashable, Identifiable {
    let id: String
    let name: String
}

struct ThreadFile: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let size: Double
    let time: Double
    var ref: FileRef { FileRef(id: id, name: name) }
}

struct ThreadFiles: Codable { let files: [ThreadFile] }

/// A page or small app an agent made in a thread. `url` is the link people share.
struct Artifact: Codable, Hashable, Identifiable {
    enum Visibility: String, Codable { case `public`, members }

    let id: String
    let threadId: String
    let title: String
    let visibility: Visibility
    let url: String
    let visitors: Int
    let createdAt: Double
    let updatedAt: Double
}

struct ThreadArtifacts: Codable { let artifacts: [Artifact] }

/// A value an artifact keeps: shared (`visitor` is nil), or owned by one visitor.
struct ArtifactRecord: Codable, Hashable, Identifiable {
    let id: String
    let visitor: String?
    let name: String?
    let key: String
    let value: JSONValue
    let updatedAt: Double
}

/// An artifact, its records, and the HTML to run, with Golem's `golem` runtime in it.
struct ArtifactDetail: Codable, Hashable {
    let artifact: Artifact
    let records: [ArtifactRecord]
    let content: String
}

/// Any JSON value.
indirect enum JSONValue: Codable, Hashable {
    case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    /// The value as JSON text, to show it.
    var text: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }
}

struct ThreadState: Codable, Hashable {
    let thread: ThreadSummary
    let messages: [Message]
    let running: Bool
}

struct Member: Codable, Hashable, Identifiable {
    let userId: String
    let name: String
    let email: String
    let role: String
    var id: String { userId }
}

struct Credential: Codable, Hashable, Identifiable {
    let id: String
    let label: String
    let ownerName: String
    let createdAt: Double
}

struct Integration: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let secretLabel: String
    var credentials: [Credential]
}

struct RoutineRun: Codable, Hashable, Identifiable {
    enum Outcome: String, Codable { case running, quiet, posted, failed }

    let id: String
    let routineId: String
    let routineName: String
    let startedAt: Double
    let finishedAt: Double?
    let outcome: Outcome
    let error: String?
}

struct Routine: Codable, Hashable, Identifiable {
    let id: String
    let channelId: String
    let name: String
    let schedule: String
    let instructions: String
    let script: String?
    var enabled: Bool
    let nextRunAt: Double?
    let threadId: String?
    let lastRun: RoutineRun?
}

struct ChannelRoutines: Codable {
    let routines: [Routine]
    let runs: [RoutineRun]
}

struct Machine: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let system: String
    let arch: String
    let version: String

    enum CodingKeys: String, CodingKey {
        case id, name, arch, version
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

struct Llm: Codable, Hashable {
    struct Login: Codable, Hashable {
        let userCode: String
        let verificationUri: String
        let expiresAt: Double
    }

    struct Model: Codable, Hashable {
        let id: String
        let name: String
        let efforts: [String]
    }

    let connected: Bool
    let provider: String
    let model: String
    let effort: String
    let models: [Model]
    let login: Login?
    let error: String?
}

struct SearchResult: Codable, Hashable, Identifiable {
    let uri: String
    let kind: String
    let title: String
    let threadId: String?
    let channelId: String?
    let snippet: String
    let modality: String
    let loc: Double?
    let score: Double
    let updatedAt: Double
    var id: String { uri }
}

struct SearchResponse: Codable {
    let results: [SearchResult]
    let semantic: Bool
}

struct Profile: Codable {
    let user: User
    let workspaces: [Workspace]
}

struct WorkspaceDetail: Codable {
    let workspace: Workspace
    let channels: [Channel]
}

extension Date {
    init(milliseconds: Double) { self.init(timeIntervalSince1970: milliseconds / 1000) }
}
