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
}

struct Channel: Codable, Hashable, Identifiable {
    let id: String
    let name: String
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
    let shared: Bool
    let mine: Bool
    let ownerName: String
    let createdAt: Double
}

struct Integration: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let secretLabel: String
    var enabled: Bool
    var credentials: [Credential]
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

struct APIError: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
}

/// The Golem JSON API. Sends the bearer token on every request and reports a 401 to `onUnauthorized`.
final class APIClient {
    var baseURL = ""
    var token: String?
    var onUnauthorized: () -> Void = {}

    // MARK: Auth

    /// Opened in a web authentication session; it ends at `golem://signed-in` with `token` or `error`.
    func googleSignInURL() throws -> URL {
        try makeRequest("GET", "/api/v1/sign-in/google").url!
    }

    func signOut() async throws {
        _ = try await send("POST", "/api/auth/sign-out")
    }

    // MARK: Workspaces

    func me() async throws -> Profile { try await get("/api/v1/me") }
    func createWorkspace(name: String) async throws -> Workspace {
        try await post("/api/v1/workspaces", ["name": name])
    }
    func workspace(_ id: String) async throws -> WorkspaceDetail { try await get("/api/v1/workspaces/\(id)") }

    func createChannel(workspaceID: String, name: String) async throws -> Channel {
        try await post("/api/v1/workspaces/\(workspaceID)/channels", ["name": name])
    }

    func createThread(workspaceID: String, channelID: String, text: String) async throws -> ThreadSummary {
        try await post("/api/v1/workspaces/\(workspaceID)/threads", ["channelId": channelID, "text": text])
    }

    func search(workspaceID: String, query: String) async throws -> SearchResponse {
        let escaped = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        return try await get("/api/v1/workspaces/\(workspaceID)/search?q=\(escaped)")
    }
    func members(workspaceID: String) async throws -> [Member] {
        try await get("/api/v1/workspaces/\(workspaceID)/members")
    }

    func addMember(workspaceID: String, email: String) async throws -> Member {
        try await post("/api/v1/workspaces/\(workspaceID)/members", ["email": email])
    }

    func integrations(workspaceID: String) async throws -> [Integration] {
        try await get("/api/v1/workspaces/\(workspaceID)/integrations")
    }

    func setIntegration(workspaceID: String, integrationID: String, enabled: Bool) async throws -> Integration {
        let path = "/api/v1/workspaces/\(workspaceID)/integrations/\(integrationID)"
        return try decode(try await send("PUT", path, ["enabled": enabled]).data)
    }

    func addCredential(
        workspaceID: String, integrationID: String, label: String, secret: String, shared: Bool
    ) async throws -> Credential {
        try await post(
            "/api/v1/workspaces/\(workspaceID)/integrations/\(integrationID)/credentials",
            ["label": label, "secret": secret, "shared": shared]
        )
    }

    func deleteCredential(workspaceID: String, credentialID: String) async throws {
        _ = try await send("DELETE", "/api/v1/workspaces/\(workspaceID)/credentials/\(credentialID)")
    }

    // MARK: Machines

    func machines(workspaceID: String) async throws -> Machines {
        try await get("/api/v1/workspaces/\(workspaceID)/machines")
    }

    func startPairing(workspaceID: String) async throws -> Pairing {
        try await post("/api/v1/workspaces/\(workspaceID)/machines/pairing")
    }

    func removeMachine(workspaceID: String, machineID: String) async throws {
        _ = try await send("DELETE", "/api/v1/workspaces/\(workspaceID)/machines/\(machineID)")
    }

    // MARK: Threads

    func thread(_ id: String) async throws -> ThreadState { try await get("/api/v1/threads/\(id)") }

    func sendMessage(threadID: String, text: String) async throws {
        _ = try await send("POST", "/api/v1/threads/\(threadID)/messages", ["text": text])
    }

    /// Reads the server-sent events of a thread until the stream ends, the task is cancelled, or an error occurs.
    func threadEvents(_ id: String, onState: (ThreadState) -> Void) async throws {
        var request = try makeRequest("GET", "/api/v1/threads/\(id)/events")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 24 * 60 * 60
        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        try check(response, data: Data())
        var event = ""
        // `lines` drops empty lines, so each `data:` line is one event; the server sends its JSON on one line.
        for try await line in bytes.lines {
            if line.hasPrefix("event:") {
                event = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:"), event == "thread" {
                onState(try decode(Data(line.dropFirst(5).utf8)))
            }
        }
    }

    // MARK: LLM provider

    func llm() async throws -> Llm { try await get("/api/v1/llm") }
    func llmLogin() async throws -> Llm { try await post("/api/v1/llm/login") }
    func llmLogout() async throws -> Llm { try await post("/api/v1/llm/logout") }
    func setModel(_ model: String) async throws -> Llm {
        try decode(try await send("PUT", "/api/v1/llm/model", ["model": model]).data)
    }
    func setEffort(_ effort: String) async throws -> Llm {
        try decode(try await send("PUT", "/api/v1/llm/effort", ["effort": effort]).data)
    }

    // MARK: Transport

    private func get<Response: Decodable>(_ path: String) async throws -> Response {
        try decode(try await send("GET", path).data)
    }

    private func post<Response: Decodable>(_ path: String, _ body: [String: Any]? = nil) async throws -> Response {
        try decode(try await send("POST", path, body).data)
    }

    private func send(
        _ method: String, _ path: String, _ body: [String: Any]? = nil
    ) async throws -> (data: Data, response: HTTPURLResponse) {
        var request = try makeRequest(method, path)
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        return (data, try check(response, data: data))
    }

    private func makeRequest(_ method: String, _ path: String) throws -> URLRequest {
        let base = baseURL.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: base + path), url.scheme?.hasPrefix("http") == true else {
            throw APIError(status: 0, message: "The server address is not valid.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }

    @discardableResult
    private func check(_ response: URLResponse, data: Data) throws -> HTTPURLResponse {
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if 200..<300 ~= http.statusCode { return http }
        if http.statusCode == 401, token != nil { onUnauthorized() }
        // `/api/v1` errors use `error`; better-auth errors under `/api/auth` use `message`.
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let message = body?["error"] as? String ?? body?["message"] as? String
        let fallback = HTTPURLResponse.localizedString(forStatusCode: http.statusCode).capitalized
        throw APIError(status: http.statusCode, message: message ?? fallback)
    }

    private func decode<Response: Decodable>(_ data: Data) throws -> Response {
        try JSONDecoder().decode(Response.self, from: data)
    }
}
