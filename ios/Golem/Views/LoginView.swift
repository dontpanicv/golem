import AuthenticationServices
import SwiftUI

struct LoginView: View {
    @Environment(Session.self) private var session
    @Environment(\.webAuthenticationSession) private var browser
    @State private var busy = false

    var body: some View {
        @Bindable var session = session
        CenteredForm(title: "Sign in to Golem") {
            GolemTextField("Server", text: $session.serverURL, large: true)
                .keyboardType(.URL)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .onSubmit(submit)
            Button("Continue with Google", action: submit)
                .buttonStyle(.golem(.primary, .large))
                .disabled(busy || session.serverURL.isEmpty)
                .padding(.top, Tokens.Space.xs)
        } footer: {
            EmptyView()
        }
    }

    private func submit() {
        guard !busy, !session.serverURL.isEmpty else { return }
        busy = true
        Task {
            do {
                try await session.signIn(browser)
            } catch ASWebAuthenticationSessionError.canceledLogin {
            } catch {
                session.show(error.localizedDescription, .error)
            }
            busy = false
        }
    }
}

/// Shown when the user is not a member of any workspace.
struct CreateWorkspaceView: View {
    @Environment(Session.self) private var session
    @State private var name = ""
    @State private var busy = false

    var body: some View {
        CenteredForm(title: "Create a workspace") {
            GolemTextField("Name", text: $name, large: true).onSubmit(create)
            Button("Create workspace", action: create)
                .buttonStyle(.golem(.primary, .large))
                .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
                .padding(.top, Tokens.Space.xs)
        } footer: {
            Button("Sign out") { Task { await session.signOut() } }.buttonStyle(.link)
        }
    }

    private func create() {
        guard !busy, !name.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        busy = true
        Task {
            await session.run { try await session.createWorkspace(name: name) }
            busy = false
        }
    }
}

/// The sign-in layout, after Linear's: a centered mark and title, large fields, and a link below.
private struct CenteredForm<Fields: View, Footer: View>: View {
    let title: String
    @ViewBuilder let fields: Fields
    @ViewBuilder let footer: Footer

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                VStack(spacing: Tokens.Space.xxl) {
                    VStack(spacing: Tokens.Space.xl) {
                        Avatar(name: "Golem", agent: true, size: 48)
                        Text(title)
                            .font(.golem(Tokens.FontSize.xl, Tokens.FontWeight.medium))
                            .foregroundStyle(Tokens.Colors.text)
                            .multilineTextAlignment(.center)
                            .accessibilityAddTraits(.isHeader)
                    }
                    VStack(spacing: Tokens.Space.lg) { fields }
                    footer
                }
                .frame(maxWidth: 360)
                .padding(Tokens.Space.xxl)
                .frame(maxWidth: .infinity, minHeight: proxy.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollDismissesKeyboard(.interactively)
        }
        .background(Tokens.Colors.surface)
    }
}
