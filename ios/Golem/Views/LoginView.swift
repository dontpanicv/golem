import SwiftUI

struct LoginView: View {
    @Environment(Session.self) private var session
    @State private var signUp = false
    @State private var name = ""
    @State private var email = ""
    @State private var password = ""
    @State private var failure: String?
    @State private var busy = false

    var body: some View {
        @Bindable var session = session
        NavigationStack {
            Form {
                Section {
                    Picker("Mode", selection: $signUp) {
                        Text("Sign in").tag(false)
                        Text("Sign up").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                Section("Server") {
                    TextField("Server", text: $session.serverURL)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section {
                    if signUp {
                        TextField("Name", text: $name).textContentType(.name)
                    }
                    TextField("Email", text: $email)
                        .keyboardType(.emailAddress)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Password", text: $password)
                        .textContentType(signUp ? .newPassword : .password)
                }
                Section {
                    Button(action: submit) {
                        Text(signUp ? "Sign up" : "Sign in").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.primary)
                    .disabled(busy || email.isEmpty || password.isEmpty || (signUp && name.isEmpty))
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                    if let failure {
                        Text(failure)
                            .foregroundStyle(Tokens.Colors.danger)
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets())
                    }
                }
            }
            .font(.golem(Tokens.FontSize.lg, Tokens.FontWeight.book))
            .scrollContentBackground(.hidden)
            .background(Tokens.Colors.canvas)
            .navigationTitle("Golem")
        }
    }

    private func submit() {
        busy = true
        failure = nil
        Task {
            do {
                try await session.signIn(name: signUp ? name : nil, email: email, password: password)
            } catch {
                failure = error.localizedDescription
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
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                }
                Section {
                    Button {
                        busy = true
                        Task {
                            await session.run { try await session.createWorkspace(name: name) }
                            busy = false
                        }
                    } label: {
                        Text("Create workspace").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.primary)
                    .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
            }
            .font(.golem(Tokens.FontSize.lg, Tokens.FontWeight.book))
            .scrollContentBackground(.hidden)
            .background(Tokens.Colors.canvas)
            .navigationTitle("New workspace")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Sign out") { Task { await session.signOut() } }
                }
            }
        }
    }
}
