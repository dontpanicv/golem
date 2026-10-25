import SwiftUI
import WebKit

/// An open artifact: a bar with its actions, then the artifact running, or the data it keeps.
struct ArtifactView: View {
    let artifactID: String
    /// Changes when the thread does, so the artifact loads again after an agent changes it.
    let changes: Int
    /// Called after the artifact is deleted or changed, so the Artifacts tab lists it again.
    let changed: () -> Void
    @Environment(Session.self) private var session
    @Environment(\.openURL) private var openURL
    @State private var detail: ArtifactDetail?
    @State private var showData = false

    var body: some View {
        VStack(spacing: 0) {
            if let detail {
                bar(detail.artifact)
                if showData {
                    data(detail)
                } else {
                    ArtifactWebView(content: detail.content) { operation, args in
                        try await session.api.artifactCall(artifactID, operation: operation, args: args)
                    }
                }
            }
        }
        .task(id: changes) { await load() }
    }

    private func bar(_ artifact: Artifact) -> some View {
        HStack(spacing: Tokens.Space.xs) {
            Text(artifact.title)
                .font(.golem(Tokens.Mobile.FontSize.row, Tokens.FontWeight.medium))
                .foregroundStyle(Tokens.Mobile.Colors.text)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Badge(label: artifact.visibility == .public ? "Public" : "Members",
                  tone: artifact.visibility == .public ? .accent : .neutral)
            Button("Data") { showData.toggle() }
                .buttonStyle(.golem(.ghost, .small))
                .accessibilityAddTraits(showData ? .isSelected : [])
            if let url = URL(string: artifact.url) {
                ShareLink(item: url) { Label("Share", systemImage: "square.and.arrow.up") }
                    .buttonStyle(.golem(.ghost, .icon))
            }
            GolemMenu {
                if let url = URL(string: artifact.url) {
                    MenuItem("Open", systemImage: "globe") { openURL(url) }
                }
                MenuItem("Copy link", systemImage: "link") {
                    UIPasteboard.general.string = artifact.url
                    session.show("Copied", .success)
                }
                if artifact.visibility == .public {
                    MenuItem("Make members only", systemImage: "lock") { setVisibility(.members) }
                } else {
                    MenuItem("Make public", systemImage: "globe") { setVisibility(.public) }
                }
                MenuSeparator()
                MenuItem("Clear data", systemImage: "tray") {
                    act { try await session.api.clearArtifactData(artifactID) }
                }
                MenuItem("Delete", systemImage: "trash", role: .destructive) { delete() }
            } label: {
                Label("\(artifact.title) actions", systemImage: "ellipsis")
            }
            .buttonStyle(.golem(.ghost, .icon))
        }
        .padding(.leading, Tokens.Mobile.Size.margin)
        .padding(.trailing, Tokens.Space.md)
        .padding(.bottom, Tokens.Space.xs)
    }

    @ViewBuilder
    private func data(_ detail: ArtifactDetail) -> some View {
        if detail.records.isEmpty {
            EmptyState(title: "No data yet", systemImage: "tray")
        } else {
            ScrollView {
                SettingsCard {
                    ForEach(detail.records) { record in
                        SettingsRow(record.key, description: describe(record)) {
                            Button("Delete \(record.key)", systemImage: "trash") {
                                act {
                                    try await session.api.deleteArtifactRecord(
                                        artifactID: artifactID, recordID: record.id
                                    )
                                }
                            }
                            .buttonStyle(.golem(.ghost, .icon))
                        }
                    }
                }
                .padding(Tokens.Space.lg)
            }
        }
    }

    private func describe(_ record: ArtifactRecord) -> String {
        let who = record.visitor == nil ? "Shared" : record.name ?? "Visitor"
        return "\(who) · \(record.value.text.prefix(200))"
    }

    private func load() async {
        await session.run { detail = try await session.api.artifact(artifactID) }
    }

    private func setVisibility(_ visibility: Artifact.Visibility) {
        act { _ = try await session.api.setArtifact(artifactID, visibility: visibility) }
    }

    private func delete() {
        Task {
            await session.run {
                try await session.api.deleteArtifact(artifactID)
                detail = nil
                changed()
            }
        }
    }

    /// Runs an action, then loads the artifact and the thread's list again.
    private func act(_ action: @escaping () async throws -> Void) {
        Task {
            await session.run {
                try await action()
                detail = try await session.api.artifact(artifactID)
                changed()
            }
        }
    }
}

/// Runs an artifact's HTML. Its `golem` runtime posts each call to the `golem` message handler; the answer goes
/// back through `window.__golemReceive`. The page has no base URL, so it never runs as Golem's site.
struct ArtifactWebView: UIViewRepresentable {
    let content: String
    let call: (String, Any) async throws -> Any

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(context.coordinator, name: "golem")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isInspectable = true
        context.coordinator.webView = view
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.call = call
        if context.coordinator.content != content {
            context.coordinator.content = content
            view.loadHTMLString(content, baseURL: nil)
        }
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "golem")
    }

    final class Coordinator: NSObject, WKScriptMessageHandler {
        weak var webView: WKWebView?
        var content: String?
        var call: (String, Any) async throws -> Any = { _, _ in NSNull() }

        func userContentController(
            _ controller: WKUserContentController, didReceive message: WKScriptMessage
        ) {
            guard let body = message.body as? [String: Any], let id = body["id"] as? Int,
                  let operation = body["op"] as? String else { return }
            let args = body["args"] ?? [String: Any]()
            Task {
                var reply: [String: Any] = ["golem": 1, "id": id]
                do {
                    reply["result"] = try await call(operation, args)
                } catch {
                    reply["error"] = error.localizedDescription
                }
                guard let data = try? JSONSerialization.data(withJSONObject: reply, options: .fragmentsAllowed),
                      let json = String(data: data, encoding: .utf8) else { return }
                _ = try? await webView?.evaluateJavaScript("window.__golemReceive(\(json))")
            }
        }
    }
}
