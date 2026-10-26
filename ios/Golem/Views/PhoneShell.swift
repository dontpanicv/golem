import SwiftUI

/// The iPhone app, as Linear's iOS app: a floating glass tab bar with Golem, Channels, Search, and a fourth slot
/// that opens the More menu, and a round button at its side that talks with Golem. Each tab keeps its own stack;
/// each screen shows the bar, or its composer, at its bottom (``View/phoneTabBar()``).
struct PhoneShell: View {
    enum Tab: Hashable { case golem, channels, search, more }

    @Environment(Session.self) private var session
    @State private var showMore = false
    @State private var paths: [Tab: [Destination]] = [:]
    @State private var bar = PhoneTabBar()

    var body: some View {
        TabView(selection: $bar.tab) {
            SwiftUI.Tab(value: Tab.golem) {
                stack(.golem) {
                    if let orchestrator = session.orchestrator {
                        WithArtifacts { ConversationView(threadID: orchestrator.id, showArtifacts: $0, open: open) }
                            .id(orchestrator.id)
                    }
                }
            }
            SwiftUI.Tab(value: Tab.channels) {
                stack(.channels) { ChannelsView(open: open).id(session.workspace?.id) }
            }
            SwiftUI.Tab(value: Tab.search) {
                stack(.search) { SearchView(open: open).id(session.workspace?.id) }
            }
            SwiftUI.Tab(value: Tab.more) {
                stack(.more) { screen(bar.more) }
            }
        }
        .environment(\.phoneTabBar, bar)
        .overlay {
            if showMore { MoreMenu(bar: bar, open: open) { showMore = false } }
        }
        // Linear's glass buttons and menus are plain white or black; fields keep the accent for their cursor.
        .tint(Tokens.Mobile.Colors.title)
        .animation(Tokens.Easing.ease(Tokens.Duration.fast), value: showMore)
        .onAppear {
            bar.select = select
            openTapped()
        }
        .onChange(of: session.workspace?.id) {
            paths = [:]
            bar.tab = .golem
            openTapped()
        }
        .onChange(of: Push.shared.tapped) { openTapped() }
    }

    private func openTapped() {
        if let destination = session.takeTapped() { open(destination) }
    }

    /// A tap in the bar: More opens its menu, the round button talks, and a tap on the open tab goes back to its
    /// first screen.
    private func select(_ choice: PhoneTabBar.Choice) {
        // The bar stays open under the More menu.
        if case .more = choice { return showMore = true }
        bar.expanded = false
        switch choice {
        case .more: break
        case .talk: talk()
        case let .tab(next):
            if next == bar.tab { paths[next] = [] }
            bar.tab = next
        }
    }

    private func stack(_ tab: Tab, @ViewBuilder root: () -> some View) -> some View {
        NavigationStack(path: Binding { paths[tab] ?? [] } set: { paths[tab] = $0 }) {
            root().navigationDestination(for: Destination.self) { screen($0) }
        }
        .toolbarVisibility(.hidden, for: .tabBar)
    }

    @ViewBuilder
    private func screen(_ destination: Destination) -> some View {
        switch destination {
        case .search:
            SearchView(open: open)
        case let .channel(id):
            WithArtifacts { ChannelView(channelID: id, showArtifacts: $0, open: open) }.id(id)
        case let .newThread(id):
            WithArtifacts { ChannelView(channelID: id, compose: true, showArtifacts: $0, open: open) }.id(id)
        case let .artifact(channel?, artifact):
            WithArtifacts { ChannelView(channelID: channel, artifactID: artifact, showArtifacts: $0, open: open) }
                .id(artifact)
        case let .artifact(nil, artifact):
            if let orchestrator = session.orchestrator {
                WithArtifacts {
                    ConversationView(threadID: orchestrator.id, artifactID: artifact, showArtifacts: $0, open: open)
                }
                .id(artifact)
            }
        case let .channelDetails(id):
            ChannelDetailsView(channelID: id, open: open).id(id)
        case let .thread(id):
            WithArtifacts { ConversationView(threadID: id, showArtifacts: $0, open: open) }.id(id)
        case .inbox, .workspaceSettings, .settings:
            moreScreen(destination)
        }
    }

    /// A screen of the More menu.
    @ViewBuilder
    private func moreScreen(_ destination: Destination) -> some View {
        switch destination {
        case .inbox: InboxView(open: open).id(session.workspace?.id)
        case .workspaceSettings: WorkspaceSettingsView().id(session.workspace?.id)
        default: SettingsView()
        }
    }

    /// Opens a screen: the orchestrator, Search, and the settings in their own tabs, anything else on the open tab.
    private func open(_ destination: Destination) {
        showMore = false
        bar.expanded = false
        switch destination {
        case .thread(session.orchestrator?.id ?? ""):
            paths[.golem] = []
            bar.tab = .golem
        case .search:
            bar.tab = .search
        case .inbox, .settings, .workspaceSettings:
            bar.more = destination
            paths[.more] = []
            bar.tab = .more
        default:
            if paths[bar.tab]?.last != destination { paths[bar.tab, default: []].append(destination) }
        }
    }

    private func talk() {
        guard let orchestrator = session.orchestrator else { return }
        open(.thread(orchestrator.id))
        let talk = VoiceSession.shared.talk
        Task {
            await talk.start(thread: orchestrator.id, api: session.api)
            if !talk.isOn, let error = talk.error { session.show(error, .error) }
        }
    }
}

/// Gives a screen its own artifacts panel, so a panel opened on one screen does not open on another.
private struct WithArtifacts<Content: View>: View {
    @ViewBuilder let content: (Binding<Bool>) -> Content
    @State private var show = false

    var body: some View { content($show) }
}

/// The tab bar's state, shared with the screens that show it. A screen with a composer shows the open tab as a round
/// button beside it, as Linear's issue screen does; a tap there brings the whole bar back until the screen scrolls.
@Observable final class PhoneTabBar {
    enum Choice { case tab(PhoneShell.Tab), more, talk }

    var tab = PhoneShell.Tab.golem
    var more = Destination.settings
    var expanded = false
    var select: (Choice) -> Void = { _ in }

    var icon: String {
        switch tab {
        case .golem: "tray"
        case .channels: "number"
        case .search: "magnifyingglass"
        case .more: more.systemImage
        }
    }
}

extension EnvironmentValues {
    @Entry var phoneTabBar: PhoneTabBar?
}

extension View {
    /// Shows the tab bar at the bottom of a screen on iPhone.
    func phoneTabBar() -> some View { modifier(PhoneTabBarInset()) }
}

private struct PhoneTabBarInset: ViewModifier {
    @Environment(\.phoneTabBar) private var bar

    func body(content: Content) -> some View {
        content.safeAreaBar(edge: .bottom) {
            if let bar { FloatingTabBar(bar: bar) }
        }
        // The keyboard covers the bar, as it covers Linear's.
        .ignoresSafeArea(.keyboard, edges: bar == nil ? [] : .bottom)
    }
}

/// The bar, measured from Linear's: a 320 × 56 glass capsule of 48 pt tabs inset 4 pt, the open one on a filled
/// capsule, and the 48 pt round button 12 pt to its side, 24 pt above the bottom of the screen.
struct FloatingTabBar: View {
    let bar: PhoneTabBar

    var body: some View {
        GlassEffectContainer {
            HStack(spacing: Tokens.Space.lg) {
                HStack(spacing: 0) {
                    item(.golem, label: "Golem", systemImage: "tray")
                    item(.channels, label: "Channels", systemImage: "number")
                    item(.search, label: "Search", systemImage: "magnifyingglass")
                    moreItem
                }
                .padding(Tokens.Space.xs)
                .frame(maxWidth: Tokens.Mobile.Size.tabBarWidth)
                .frame(height: Tokens.Mobile.Size.tabBar)
                .glassEffect(.regular.interactive(), in: .capsule)
                .layoutPriority(1)
                GlassCircleButton(label: "Talk with Golem", systemImage: "waveform", size: Tokens.Mobile.Size.voice) {
                    bar.select(.talk)
                }
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, Tokens.Mobile.Size.barMargin)
        .padding(.bottom, Tokens.Mobile.Size.tabBarBottom - Tokens.Mobile.Size.homeIndicator)
    }

    private func item(_ tab: PhoneShell.Tab, label: String, systemImage: String) -> some View {
        let selected = bar.tab == tab
        return Button { bar.select(.tab(tab)) } label: {
            Image(systemName: systemImage)
                .font(.system(size: 19, weight: .medium))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Tokens.Mobile.Colors.title)
        .background(selected ? Tokens.Mobile.Colors.tabSelected : .clear, in: .capsule)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// The fourth slot: the chevron of the More menu, after the icon of the screen picked from it while it is open.
    private var moreItem: some View {
        let selected = bar.tab == .more
        return Button { bar.select(.more) } label: {
            HStack(spacing: 3) {
                if selected { Image(systemName: bar.more.systemImage).font(.system(size: 19, weight: .medium)) }
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: selected ? 10 : 17, weight: .semibold))
            }
            .frame(width: selected ? 78 : 54)
            .frame(maxHeight: .infinity)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Tokens.Mobile.Colors.title)
        .background(selected ? Tokens.Mobile.Colors.tabSelected : .clear, in: .capsule)
        .accessibilityLabel(selected ? "\(bar.more.title), more" : "More")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

extension Destination {
    var title: String {
        switch self {
        case .inbox: "Inbox"
        case .workspaceSettings: "Workspace settings"
        case .settings: "Settings"
        case .search: "Search"
        default: ""
        }
    }

    var systemImage: String {
        switch self {
        case .inbox: "bell"
        case .workspaceSettings: "person.2"
        case .settings: "gearshape"
        default: "magnifyingglass"
        }
    }
}

/// The More menu, as Linear's: a glass card over the tab bar with the workspace switcher at the top and every
/// screen below it. A tap outside closes it.
private struct MoreMenu: View {
    let bar: PhoneTabBar
    let open: (Destination) -> Void
    let close: () -> Void
    @Environment(Session.self) private var session
    @State private var newWorkspace = false

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.black.opacity(0.001).ignoresSafeArea().onTapGesture(perform: close)
            VStack(alignment: .leading, spacing: 0) {
                workspaceSwitcher
                Rectangle().fill(Tokens.Mobile.Colors.separator).frame(height: 1).padding(.horizontal, 15)
                VStack(spacing: 0) {
                    row("Golem", systemImage: "tray", selected: bar.tab == .golem) { bar.select(.tab(.golem)) }
                    row("Channels", systemImage: "number", selected: bar.tab == .channels) {
                        bar.select(.tab(.channels))
                    }
                    row("Search", systemImage: "magnifyingglass", selected: bar.tab == .search) {
                        bar.select(.tab(.search))
                    }
                    ForEach([Destination.inbox, .workspaceSettings, .settings], id: \.self) { destination in
                        row(destination.title, systemImage: destination.systemImage,
                            selected: bar.tab == .more && bar.more == destination,
                            count: destination == .inbox ? session.inbox?.unread ?? 0 : 0) { open(destination) }
                    }
                }
                .padding(9)
            }
            .frame(width: Tokens.Mobile.Size.tabBarWidth)
            .glassEffect(.regular, in: .rect(cornerRadius: 36))
            .transition(.scale(scale: 0.9, anchor: .bottomLeading).combined(with: .opacity))
            // Level with the bar.
            .padding(.leading, Tokens.Mobile.Size.barMargin)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, Tokens.Mobile.Size.tabBarBottom - Tokens.Mobile.Size.homeIndicator)
        }
        .sheet(isPresented: $newWorkspace) {
            NameDialog(title: "New workspace") { name in try await session.createWorkspace(name: name) }
        }
    }

    private var workspaceSwitcher: some View {
        Menu {
            ForEach(session.workspaces) { workspace in
                MenuItem(workspace.name, checked: workspace.id == session.workspace?.id) {
                    close()
                    Task { await session.run { try await session.open(workspace) } }
                }
            }
            MenuSeparator()
            MenuItem("New workspace", systemImage: "plus") { newWorkspace = true }
        } label: {
            HStack(spacing: 10) {
                Avatar(name: session.workspace?.name ?? "G", agent: true)
                Text(session.workspace?.name ?? "Workspaces")
                    .font(.golem(Tokens.Mobile.FontSize.menu, Tokens.FontWeight.medium))
                    .foregroundStyle(Tokens.Mobile.Colors.title)
                    .lineLimit(1)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Tokens.Mobile.Colors.textQuaternary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 21)
            .frame(height: 66)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Workspace")
        .accessibilityValue(session.workspace?.name ?? "")
    }

    private func row(
        _ title: String, systemImage: String, selected: Bool, count: Int = 0, action: @escaping () -> Void
    ) -> some View {
        Button {
            close()
            action()
        } label: {
            HStack(spacing: 11) {
                Image(systemName: systemImage)
                    .font(.system(size: 17, weight: .medium))
                    .frame(width: 21)
                Text(title).font(.golem(Tokens.Mobile.FontSize.menu, Tokens.FontWeight.medium))
                Spacer(minLength: 0)
                if count > 0 {
                    Text("\(count)")
                        .font(.golem(Tokens.Mobile.FontSize.small, Tokens.FontWeight.book))
                        .foregroundStyle(Tokens.Mobile.Colors.textSecondary)
                }
            }
            .foregroundStyle(Tokens.Mobile.Colors.title)
            .padding(.horizontal, 12)
            .frame(height: Tokens.Mobile.Size.menuRow)
            .background(selected ? Tokens.Mobile.Colors.menuSelected : .clear, in: .capsule)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
