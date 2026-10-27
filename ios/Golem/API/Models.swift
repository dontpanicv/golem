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
    /// The person's role: `owner` can rename and delete the workspace, and add members.
    let role: String
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
    /// What the agent did before this answer; nil for people and for an answer without work.
    let work: Work?
}

/// The agent's work before an answer. `endedAt` is nil while it works.
struct Work: Codable, Hashable {
    let startedAt: Double
    let endedAt: Double?
    /// Someone stopped the agent before it answered.
    let stopped: Bool
    let steps: [Step]
}

/// A thought, words between tool calls, or a tool call. A tool call's text is the thread link in its result, or else
/// the values of its arguments; `input` is its arguments as JSON, `output` the start of its result.
struct Step: Codable, Hashable {
    let kind: String
    let text: String
    let tool: String?
    let input: String?
    let output: String?
    let running: Bool
    let failed: Bool
}

struct WorkingThreads: Codable, Hashable {
    let threadIds: [String]
}

/// Something that needs the person: it opens its thread, or its channel without one.
struct InboxNotification: Codable, Hashable, Identifiable {
    let id: String
    let workspaceId: String
    let channelId: String
    let threadId: String?
    let title: String
    let text: String
    let createdAt: Double
    let readAt: Double?

    var destination: Destination { threadId.map { .thread($0) } ?? .channel(channelId) }
}

struct Inbox: Codable, Hashable {
    let notifications: [InboxNotification]
    /// Unread in this workspace.
    let unread: Int
    /// Unread in all the person's workspaces, which the app icon shows.
    let badge: Int
}

struct FileRef: Codable, Hashable, Identifiable {
    let id: String
    let name: String
}

/// A file of a channel, or of the workspace for the orchestrator: uploaded there, or attached to a message.
struct SavedFile: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let size: Double
    let time: Double
    var ref: FileRef { FileRef(id: id, name: name) }
}

struct SavedFiles: Codable { let files: [SavedFile] }

/// A page or small app an agent made. It belongs to a channel, or to the workspace when `channelId` is nil;
/// `threadId` is the thread that made it. `url` is the link people share.
struct Artifact: Codable, Hashable, Identifiable {
    enum Visibility: String, Codable { case `public`, members }

    let id: String
    let channelId: String?
    let threadId: String
    let title: String
    let visibility: Visibility
    let url: String
    let visitors: Int
    let createdAt: Double
    let updatedAt: Double
}

struct ArtifactList: Codable { let artifacts: [Artifact] }

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
    let approvals: [Approval]
}

/// An action the agent waits for one person to allow, or for any member when `approverId` is nil.
struct Approval: Codable, Hashable, Identifiable {
    let id: String
    let tool: String
    let text: String
    let approverId: String?
    let expiresAt: Double
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
    /// How people connect it: with a secret, by signing in on its page, or by linking a phone number with a code.
    let connect: Connection
    /// The name of the secret, for `.secret`.
    let secretLabel: String?
    /// Whether the secret also needs the address of the person's own server.
    let address: Bool
    /// The steps that set it up, in Markdown; empty when Connect is all.
    let guide: [String]
    /// Golem's own OAuth client, which the server's owner sets; nil for integrations without one.
    let client: Client?
    var credentials: [Credential]

    enum Connection: String, Codable { case secret, signIn = "sign-in", phone }

    struct Client: Codable, Hashable {
        let clientId: String?
        /// Whether this person may set it.
        let changeable: Bool
    }
}

/// The sign-in page of an integration's MCP server.
struct ConnectPage: Decodable {
    let url: URL
}

/// The code that links a phone number, which the person enters on their phone.
struct LinkCode: Decodable {
    let code: String
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

/// What a channel is for, where it is now, its decisions, its open questions, and what each person wants, as Markdown
/// with thread links; the model writes it again from the channel's threads.
struct Brief: Codable {
    let text: String
    let updatedAt: Double
}

struct ChannelBrief: Codable {
    let brief: Brief?
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
    /// Whether the person is the server's owner, who alone changes the login, the model, and the effort.
    let owner: Bool
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
