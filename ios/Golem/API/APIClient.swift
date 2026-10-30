import Foundation

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
    var session = URLSession.shared

    // MARK: Auth

    /// Opened in a web authentication session; `challenge` is the base64url SHA-256 of the sign-in's verifier.
    func googleSignInURL(challenge: String) throws -> URL {
        try makeRequest("GET", "/api/v1/sign-in/google?challenge=\(challenge)").url!
    }

    /// Swaps the one-time code of a sign-in, with its verifier, for the session token.
    func signInToken(code: String, verifier: String) async throws -> String {
        let pair = ["code": code, "verifier": verifier]
        let body: [String: String] = try await post("/api/v1/sign-in/google/token", pair)
        guard let token = body["token"] else { throw APIError(status: 0, message: "Sign-in failed") }
        return token
    }

    func signOut() async throws {
        _ = try await send("POST", "/api/auth/sign-out")
    }

    // MARK: Workspaces

    func me() async throws -> Profile { try await get("/api/v1/me") }
    func workspace(_ id: String) async throws -> WorkspaceDetail { try await get("/api/v1/workspaces/\(id)") }
    func renameWorkspace(_ id: String, name: String) async throws -> Workspace {
        try decode(try await send("PUT", "/api/v1/workspaces/\(id)", ["name": name]).data)
    }

    /// The workspace's thread that never ends; the first call makes it.
    func orchestrator(workspaceID: String) async throws -> ThreadSummary {
        try await get("/api/v1/workspaces/\(workspaceID)/orchestrator")
    }

    func createChannel(workspaceID: String, name: String, isPrivate: Bool) async throws -> Channel {
        try await post("/api/v1/workspaces/\(workspaceID)/channels", ["name": name, "private": isPrivate])
    }

    func deleteChannel(workspaceID: String, channelID: String) async throws {
        _ = try await send("DELETE", "/api/v1/workspaces/\(workspaceID)/channels/\(channelID)")
    }

    func createThread(
        workspaceID: String, channelID: String, text: String, files: [URL]
    ) async throws -> ThreadSummary {
        let fields = ["channelId": channelID, "text": text]
        return try decode(try await sendForm("/api/v1/workspaces/\(workspaceID)/threads", fields, files).data)
    }

    func setThreadSettled(workspaceID: String, threadID: String, settled: Bool) async throws {
        _ = try await post(
            "/api/v1/workspaces/\(workspaceID)/threads/\(threadID)/settled", ["settled": settled]
        ) as ThreadSummary
    }

    func search(workspaceID: String, query: String) async throws -> SearchResponse {
        // `&`, `+`, and `=` are allowed in a query but would end or change the `q` value.
        let allowed = CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&+="))
        let escaped = query.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
        return try await get("/api/v1/workspaces/\(workspaceID)/search?q=\(escaped)")
    }
    func members(workspaceID: String) async throws -> [Member] {
        try await get("/api/v1/workspaces/\(workspaceID)/members")
    }

    func addMember(workspaceID: String, email: String) async throws -> Member {
        try await post("/api/v1/workspaces/\(workspaceID)/members", ["email": email])
    }

    // MARK: Routines

    func routines(workspaceID: String, channelID: String) async throws -> ChannelRoutines {
        try await get("/api/v1/workspaces/\(workspaceID)/channels/\(channelID)/routines")
    }

    func brief(workspaceID: String, channelID: String) async throws -> Brief? {
        let found: ChannelBrief = try await get("/api/v1/workspaces/\(workspaceID)/channels/\(channelID)/brief")
        return found.brief
    }

    func setRoutine(_ id: String, enabled: Bool) async throws -> Routine {
        try decode(try await send("PUT", "/api/v1/routines/\(id)", ["enabled": enabled]).data)
    }

    func runRoutine(_ id: String) async throws {
        _ = try await send("POST", "/api/v1/routines/\(id)/runs")
    }

    func deleteRoutine(_ id: String) async throws {
        _ = try await send("DELETE", "/api/v1/routines/\(id)")
    }

    // MARK: Machines

    /// A workspace's machines, or the person's own for a nil `workspaceID`.
    func machines(workspaceID: String?) async throws -> Machines {
        try await get("\(Self.machinesBase(workspaceID))/machines")
    }

    func startPairing(workspaceID: String?) async throws -> Pairing {
        try await post("\(Self.machinesBase(workspaceID))/machines/pairing")
    }

    func removeMachine(workspaceID: String?, machineID: String) async throws {
        _ = try await send("DELETE", "\(Self.machinesBase(workspaceID))/machines/\(machineID)")
    }

    private static func machinesBase(_ workspaceID: String?) -> String {
        workspaceID.map { "/api/v1/workspaces/\($0)" } ?? "/api/v1"
    }

    // MARK: Threads

    func thread(_ id: String) async throws -> ThreadState { try await get("/api/v1/threads/\(id)") }

    /// `voice`: spoken in a conversation, so the answer is written to be read aloud.
    func sendMessage(threadID: String, text: String, files: [URL], voice: Bool = false) async throws {
        let fields = voice ? ["text": text, "voice": "true"] : ["text": text]
        _ = try await sendForm("/api/v1/threads/\(threadID)/messages", fields, files)
    }

    // MARK: Files

    /// The files of a channel, or the workspace's own for a nil `channelID`.
    func files(workspaceID: String, channelID: String?) async throws -> [SavedFile] {
        (try await get(filesPath(workspaceID, channelID)) as SavedFiles).files
    }

    func uploadFiles(workspaceID: String, channelID: String?, files: [URL]) async throws -> [SavedFile] {
        (try decode(try await sendForm(filesPath(workspaceID, channelID), [:], files).data) as SavedFiles).files
    }

    /// Returns the files left where the file was.
    func deleteFile(workspaceID: String, fileID: String) async throws -> [SavedFile] {
        let data = try await send("DELETE", "/api/v1/workspaces/\(workspaceID)/files/\(fileID)").data
        return (try decode(data) as SavedFiles).files
    }

    /// Downloads a file of the workspace to a temporary folder under its own name, for Quick Look.
    func download(workspaceID: String, file: FileRef) async throws -> URL {
        let request = try makeRequest("GET", "/api/v1/workspaces/\(workspaceID)/files/\(file.id)")
        let (location, response) = try await session.download(for: request)
        try check(response, data: Data())
        let folder = FileManager.default.temporaryDirectory.appending(path: file.id)
        try? FileManager.default.removeItem(at: folder)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appending(path: file.name)
        try FileManager.default.moveItem(at: location, to: url)
        return url
    }

    /// A JPEG of a picture file at most 1024 pixels long, for its thumbnail in a message.
    func picture(workspaceID: String, fileID: String) async throws -> Data {
        try await send("GET", "/api/v1/workspaces/\(workspaceID)/files/\(fileID)/picture").data
    }

    /// Reads the server-sent events of a thread until the stream ends, the task is cancelled, or an error occurs.
    func threadEvents(_ id: String, onState: (ThreadState) -> Void) async throws {
        try await events("/api/v1/threads/\(id)/events", named: "thread", onEvent: onState)
    }

    /// Answers an approval; `scope` "turn" also allows the rest of the turn's changes on that machine.
    func answerApproval(threadID: String, approvalID: String, allow: Bool, scope: String = "once") async throws {
        _ = try await send(
            "POST", "/api/v1/threads/\(threadID)/approvals/\(approvalID)", ["allow": allow, "scope": scope]
        )
    }

    /// Stops the agent of a thread: it drops the messages it has not read yet and ends its run.
    func stopThread(_ id: String) async throws {
        _ = try await send("POST", "/api/v1/threads/\(id)/stop")
    }

    /// Reads the threads of a workspace whose agent works, at once and after every change, until the stream ends, the
    /// task is cancelled, or an error occurs.
    func workingEvents(workspaceID: String, onThreads: ([String]) -> Void) async throws {
        try await events("/api/v1/workspaces/\(workspaceID)/working", named: "working") { (event: WorkingThreads) in
            onThreads(event.threadIds)
        }
    }

    private func events<Event: Decodable>(
        _ path: String, named name: String, onEvent: (Event) -> Void
    ) async throws {
        var request = try makeRequest("GET", path)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 24 * 60 * 60
        let (bytes, response) = try await session.bytes(for: request)
        try check(response, data: Data())
        var event = ""
        // `lines` drops empty lines, so each `data:` line is one event; the server sends its JSON on one line.
        for try await line in bytes.lines {
            if line.hasPrefix("event:") {
                event = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:"), event == name {
                onEvent(try decode(Data(line.dropFirst(5).utf8)))
            }
        }
    }

    // MARK: Artifacts

    /// The artifacts of a channel, or the workspace's own for a nil `channelID`.
    func artifacts(workspaceID: String, channelID: String?) async throws -> [Artifact] {
        let place = channelID.map { "/channels/\($0)" } ?? ""
        return (try await get("/api/v1/workspaces/\(workspaceID)\(place)/artifacts") as ArtifactList).artifacts
    }

    func artifact(_ id: String) async throws -> ArtifactDetail { try await get("/api/v1/artifacts/\(id)") }

    func setArtifact(_ id: String, visibility: Artifact.Visibility) async throws -> Artifact {
        try decode(try await send("PUT", "/api/v1/artifacts/\(id)", ["visibility": visibility.rawValue]).data)
    }

    func deleteArtifact(_ id: String) async throws {
        _ = try await send("DELETE", "/api/v1/artifacts/\(id)")
    }

    func clearArtifactData(_ id: String) async throws {
        _ = try await send("DELETE", "/api/v1/artifacts/\(id)/data")
    }

    func deleteArtifactRecord(artifactID: String, recordID: String) async throws {
        _ = try await send("DELETE", "/api/v1/artifacts/\(artifactID)/records/\(recordID)")
    }

    /// A call of an artifact's `golem` runtime; `args` and the result are JSON values from `JSONSerialization`.
    func artifactCall(_ id: String, operation: String, args: Any) async throws -> Any {
        let data = try await send("POST", "/api/v1/artifacts/\(id)/rpc", ["op": operation, "args": args]).data
        let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return body?["result"] ?? NSNull()
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

    /// Restarts Golem, which then reads its configuration again.
    func restartServer() async throws {
        _ = try await send("POST", "/api/v1/server/restart")
    }

    // MARK: Transport

    private func filesPath(_ workspaceID: String, _ channelID: String?) -> String {
        "/api/v1/workspaces/\(workspaceID)\(channelID.map { "/channels/\($0)" } ?? "")/files"
    }

    func get<Response: Decodable>(_ path: String) async throws -> Response {
        try decode(try await send("GET", path).data)
    }

    func post<Response: Decodable>(_ path: String, _ body: [String: Any]? = nil) async throws -> Response {
        try decode(try await send("POST", path, body).data)
    }

    func send(
        _ method: String, _ path: String, _ body: [String: Any]? = nil
    ) async throws -> (data: Data, response: HTTPURLResponse) {
        var request = try makeRequest(method, path)
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        return (data, try check(response, data: data))
    }

    /// A `multipart/form-data` post: the text fields, then one `files` part per file.
    private func sendForm(
        _ path: String, _ fields: [String: String], _ files: [URL]
    ) async throws -> (data: Data, response: HTTPURLResponse) {
        var request = try makeRequest("POST", path)
        let boundary = "golem-\(UUID().uuidString)"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        func part(_ headers: String, _ content: Data) {
            body.append(Data("--\(boundary)\r\n\(headers)\r\n\r\n".utf8))
            body.append(content)
            body.append(Data("\r\n".utf8))
        }
        for (name, value) in fields {
            part("Content-Disposition: form-data; name=\"\(name)\"", Data(value.utf8))
        }
        for file in files {
            // A quote would end the name; browsers send it as %22 too.
            let name = file.lastPathComponent.replacingOccurrences(of: "\"", with: "%22")
            let disposition = "Content-Disposition: form-data; name=\"files\"; filename=\"\(name)\""
            part("\(disposition)\r\nContent-Type: application/octet-stream", try Data(contentsOf: file))
        }
        body.append(Data("--\(boundary)--\r\n".utf8))
        let (data, response) = try await session.upload(for: request, from: body)
        return (data, try check(response, data: data))
    }

    private func makeRequest(_ method: String, _ path: String) throws -> URLRequest {
        let base = baseURL.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        // Only TLS proves that the server is Golem before the token goes to it; a simulator talks to its own Mac.
        guard let url = URL(string: base + path), url.scheme == "https" || url.host == "localhost" else {
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

/// The inbox and the devices that get pushes.
extension APIClient {
    func inbox(workspaceID: String) async throws -> Inbox {
        try await get("/api/v1/workspaces/\(workspaceID)/notifications")
    }

    /// Marks one notification read, or all of the workspace's for a nil `id`.
    func readNotifications(workspaceID: String, id: String?) async throws -> Inbox {
        try await post("/api/v1/workspaces/\(workspaceID)/notifications/read", id.map { ["id": $0] } ?? [:])
    }

    func addDevice(token: String, environment: String) async throws {
        _ = try await send("POST", "/api/v1/devices", ["token": token, "environment": environment])
    }

    func removeDevice(token: String) async throws {
        _ = try await send("DELETE", "/api/v1/devices/\(token)")
    }
}

/// The facts that the family writes by hand; every agent of the workspace reads them.
extension APIClient {
    func facts(workspaceID: String) async throws -> Facts {
        try await get("/api/v1/workspaces/\(workspaceID)/facts")
    }

    func setFacts(workspaceID: String, text: String) async throws -> Facts {
        try decode(try await send("PUT", "/api/v1/workspaces/\(workspaceID)/facts", ["text": text]).data)
    }
}
