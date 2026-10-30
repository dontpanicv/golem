import AuthenticationServices
import SwiftUI

struct LoginView: View {
    @Environment(Session.self) private var session
    @Environment(\.webAuthenticationSession) private var browser
    @State private var busy = false

    var body: some View {
        @Bindable var session = session
        CenteredForm(title: "Sign in to Golem") {
            GolemTextField("Server", text: $session.serverURL)
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

/// Shown to a person who signed in before a family member added them.
struct NotMemberView: View {
    @Environment(Session.self) private var session

    var body: some View {
        CenteredForm(title: "Ask a family member to add you") {
            Button("Try again") { Task { await session.load() } }
                .buttonStyle(.golem(.primary, .large))
                .padding(.top, Tokens.Space.xs)
        } footer: {
            Button("Sign out") { Task { await session.signOut() } }.buttonStyle(.link)
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
                        GolemMark(size: 48)
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
        .mobileBackground()
    }
}
