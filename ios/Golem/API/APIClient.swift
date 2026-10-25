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

struct Llm: Codable, Hashable {
    struct Login: Codable, Hashable {
        let userCode: String
        let verificationUri: String
        let expiresAt: Double
    }

    let connected: Bool
    let provider: String
    let model: String
    let models: [String]
    let login: Login?
    let error: String?
}

struct Me: Codable {
    let user: User
    let workspaces: [Workspace]
}

struct WorkspaceDetail: Codable {
    let workspace: Workspace
    let channels: [Channel]
}

struct AuthResponse: Codable {
    let token: String?
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

    func signIn(email: String, password: String) async throws -> String {
        try await authenticate("/api/auth/sign-in/email", ["email": email, "password": password])
    }

    func signUp(name: String, email: String, password: String) async throws -> String {
        try await authenticate("/api/auth/sign-up/email", ["name": name, "email": email, "password": password])
    }

    func signOut() async throws {
        _ = try await send("POST", "/api/auth/sign-out")
    }

    // MARK: Workspaces

    func me() async throws -> Me { try await get("/api/v1/me") }
    func createWorkspace(name: String) async throws -> Workspace { try await post("/api/v1/workspaces", ["name": name]) }
    func workspace(_ id: String) async throws -> WorkspaceDetail { try await get("/api/v1/workspaces/\(id)") }

    func createChannel(workspaceID: String, name: String) async throws -> Channel {
        try await post("/api/v1/workspaces/\(workspaceID)/channels", ["name": name])
    }

    func createThread(workspaceID: String, channelID: String, text: String) async throws -> ThreadSummary {
        try await post("/api/v1/workspaces/\(workspaceID)/threads", ["channelId": channelID, "text": text])
    }

    func members(workspaceID: String) async throws -> [Member] { try await get("/api/v1/workspaces/\(workspaceID)/members") }

    func addMember(workspaceID: String, email: String) async throws -> Member {
        try await post("/api/v1/workspaces/\(workspaceID)/members", ["email": email])
    }

    func integrations(workspaceID: String) async throws -> [Integration] {
        try await get("/api/v1/workspaces/\(workspaceID)/integrations")
    }

    func setIntegration(workspaceID: String, integrationID: String, enabled: Bool) async throws -> Integration {
        try decode(try await send("PUT", "/api/v1/workspaces/\(workspaceID)/integrations/\(integrationID)", ["enabled": enabled]).data)
    }

    func addCredential(workspaceID: String, integrationID: String, label: String, secret: String, shared: Bool) async throws -> Credential {
        try await post(
            "/api/v1/workspaces/\(workspaceID)/integrations/\(integrationID)/credentials",
            ["label": label, "secret": secret, "shared": shared]
        )
    }

    func deleteCredential(workspaceID: String, credentialID: String) async throws {
        _ = try await send("DELETE", "/api/v1/workspaces/\(workspaceID)/credentials/\(credentialID)")
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
    func setModel(_ model: String) async throws -> Llm { try decode(try await send("PUT", "/api/v1/llm/model", ["model": model]).data) }

    // MARK: Transport

    private func authenticate(_ path: String, _ body: [String: Any]) async throws -> String {
        let (data, response) = try await send("POST", path, body)
        let auth: AuthResponse = try decode(data)
        guard let token = response.value(forHTTPHeaderField: "set-auth-token") ?? auth.token else {
            throw APIError(status: response.statusCode, message: "The server did not return a session token.")
        }
        return token
    }

    private func get<Response: Decodable>(_ path: String) async throws -> Response {
        try decode(try await send("GET", path).data)
    }

    private func post<Response: Decodable>(_ path: String, _ body: [String: Any]? = nil) async throws -> Response {
        try decode(try await send("POST", path, body).data)
    }

    private func send(_ method: String, _ path: String, _ body: [String: Any]? = nil) async throws -> (data: Data, response: HTTPURLResponse) {
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
        throw APIError(status: http.statusCode, message: message ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode).capitalized)
    }

    private func decode<Response: Decodable>(_ data: Data) throws -> Response {
        try JSONDecoder().decode(Response.self, from: data)
    }
}
