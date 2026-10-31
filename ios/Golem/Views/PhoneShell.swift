import SwiftUI

/// The iPhone app, as Slack's iOS app: Home, Golem, Activity, and Search in a floating glass tab bar that stays under
/// every screen and its composer, with a fifth item, You, whose menu opens the settings in sheets.
/// Each tab keeps its own stack; screens leave room for the bar with ``View/phoneTabBar()`` or ``ComposerRow``.
struct PhoneShell: View {
    enum Tab: CaseIterable { case home, golem, activity, search }

    @Environment(Session.self) private var session
    @State private var bar = PhoneTabBar()
    @State private var paths: [Tab: [Destination]] = [:]
    @State private var sheet: Destination?

    var body: some View {
        ZStack {
            // Every tab stays alive, so each keeps its place; the open one fades in over the others.
            ForEach(Tab.allCases, id: \.self) { tab in
                let selected = bar.tab == tab
                stack(tab)
                    .opacity(selected ? 1 : 0)
                    .allowsHitTesting(selected)
                    .accessibilityHidden(!selected)
            }
        }
        .animation(Tokens.Easing.ease(Tokens.Duration.normal), value: bar.tab)
        .overlay(alignment: .bottom) {
            TabBar(bar: bar, unread: session.inbox?.unread ?? 0, select: select, open: open)
                // The keyboard covers the bar, as it covers Slack's.
                .ignoresSafeArea(.keyboard)
                .opacity(bar.keyboard ? 0 : 1)
        }
        .environment(\.phoneTabBar, bar)
        // Glass buttons and menus are plain white or black; fields keep the accent for their cursor.
        .tint(Tokens.Mobile.Colors.title)
        .sensoryFeedback(.selection, trigger: bar.tab)
        .sheet(item: $sheet) { destination in
            NavigationStack {
                Group {
                    if destination == .workspaceSettings {
                        WorkspaceSettingsView().id(session.workspace?.id)
                    } else {
                        SettingsView { destination in
                            sheet = nil
                            open(destination)
                        }
                    }
                }
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Close", systemImage: "xmark") { sheet = nil }
                    }
                }
            }
            .environment(\.phoneTabBar, nil)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            withAnimation(.smooth(duration: Tokens.Duration.normal)) { bar.keyboard = true }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            withAnimation(.smooth(duration: Tokens.Duration.normal)) { bar.keyboard = false }
        }
        .onAppear {
            openTapped()
            openDictation()
        }
        .onChange(of: session.workspace?.id) {
            paths = [:]
            bar.tab = .home
            openTapped()
            openDictation()
        }
        .onChange(of: Push.shared.tapped) { openTapped() }
        .onChange(of: Dictation.shared.requested) { openDictation() }
    }

    /// Opens the Golem thread, whose composer then starts dictating.
    private func openDictation() {
        if let orchestrator = session.orchestrator, Dictation.shared.take(for: orchestrator.id) {
            open(.thread(orchestrator.id))
        }
    }

    private func openTapped() {
        if let destination = session.takeTapped() { open(destination) }
    }

    /// A tap in the bar opens the tab; a tap on the open tab goes back to its first screen.
    private func select(_ tab: Tab) {
        if tab == bar.tab { paths[tab] = [] }
        bar.tab = tab
    }

    private func stack(_ tab: Tab) -> some View {
        NavigationStack(path: Binding { paths[tab] ?? [] } set: { paths[tab] = $0 }) {
            root(tab).navigationDestination(for: Destination.self) { screen($0) }
        }
    }

    @ViewBuilder
    private func root(_ tab: Tab) -> some View {
        switch tab {
        case .home:
            HomeView(open: open).id(session.workspace?.id)
        case .golem:
            if let orchestrator = session.orchestrator {
                WithArtifacts { ConversationView(threadID: orchestrator.id, showArtifacts: $0, open: open) }
                    .id(orchestrator.id)
            }
        case .activity:
            InboxView(open: open).id(session.workspace?.id)
        case .search:
            SearchView(open: open).id(session.workspace?.id)
        }
    }

    @ViewBuilder
    private func screen(_ destination: Destination) -> some View {
        switch destination {
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
        case .upcoming:
            UpcomingView(open: open).id(session.workspace?.id)
        case .search, .inbox, .workspaceSettings, .settings:
            EmptyView()
        }
    }

    /// Opens a screen: Golem, Activity, and Search in their tabs, the settings in a sheet, anything else on the open
    /// tab's stack.
    private func open(_ destination: Destination) {
        switch destination {
        case .thread(session.orchestrator?.id ?? ""):
            paths[.golem] = []
            bar.tab = .golem
        case .search:
            bar.tab = .search
        case .inbox:
            bar.tab = .activity
        case .settings, .workspaceSettings:
            sheet = destination
        default:
            if paths[bar.tab]?.last != destination { paths[bar.tab, default: []].append(destination) }
        }
    }
}

/// Gives a screen its own artifacts panel, so a panel opened on one screen does not open on another.
private struct WithArtifacts<Content: View>: View {
    @ViewBuilder let content: (Binding<Bool>) -> Content
    @State private var show = false

    var body: some View { content($show) }
}

/// The tab bar's state, shared with the screens that leave room for it.
@Observable final class PhoneTabBar {
    var tab = PhoneShell.Tab.home
    /// The keyboard shows and covers the bar.
    var keyboard = false

    /// The room a screen leaves at its bottom for the bar: the bar sits 24 pt above the bottom of the screen, which
    /// is 10 pt into the home indicator's area, and the screen's content stops 8 pt above it.
    static let room = Tokens.Mobile.Size.tabBar + Tokens.Mobile.Size.tabBarBottom - Tokens.Mobile.Size.homeIndicator
        + Tokens.Space.md
}

extension EnvironmentValues {
    @Entry var phoneTabBar: PhoneTabBar?
}

extension View {
    /// Leaves room for the tab bar at the bottom of a screen on iPhone; content scrolls under it and fades.
    func phoneTabBar() -> some View { modifier(PhoneTabBarRoom()) }
}

private struct PhoneTabBarRoom: ViewModifier {
    @Environment(\.phoneTabBar) private var bar

    func body(content: Content) -> some View {
        content.safeAreaBar(edge: .bottom) {
            if let bar, !bar.keyboard { Color.clear.frame(height: PhoneTabBar.room) }
        }
    }
}

extension PhoneShell.Tab {
    var title: String {
        switch self {
        case .home: "Home"
        case .golem: "Golem"
        case .activity: "Activity"
        case .search: "Search"
        }
    }

    var systemImage: String {
        switch self {
        case .home: "house"
        case .golem: "sparkles"
        case .activity: "bell"
        case .search: "magnifyingglass"
        }
    }
}

/// The bar, as Slack's: a glass capsule across the screen of four tabs with their names, the open one on a filled
/// capsule that slides to the tab tapped, and the count of unread notifications on Activity; then You, a native menu
/// with both settings.
private struct TabBar: View {
    let bar: PhoneTabBar
    let unread: Int
    let select: (PhoneShell.Tab) -> Void
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @Namespace private var selection
    @State private var taps: [PhoneShell.Tab: Int] = [:]

    var body: some View {
        HStack(spacing: 0) {
            ForEach(PhoneShell.Tab.allCases, id: \.self) { item($0) }
            you
        }
        .padding(Tokens.Space.xs)
        .frame(height: Tokens.Mobile.Size.tabBar)
        .glassEffect(.regular.interactive(), in: .capsule)
        .padding(.horizontal, Tokens.Mobile.Size.margin)
        .padding(.bottom, Tokens.Mobile.Size.tabBarBottom - Tokens.Mobile.Size.homeIndicator)
        .animation(.snappy, value: bar.tab)
        .animation(.snappy, value: unread)
    }

    private var you: some View {
        Menu {
            Section(session.user?.name ?? "") {
                Button("Settings", systemImage: "gearshape") { open(.settings) }
                Button("Workspace settings", systemImage: "person.2") { open(.workspaceSettings) }
            }
        } label: {
            VStack(spacing: Tokens.Space.xxs) {
                Image(systemName: "person.crop.circle")
                    .font(.system(size: 18, weight: .medium))
                    .frame(height: 22)
                Text("You").font(.golem(Tokens.Mobile.FontSize.tabLabel, Tokens.FontWeight.medium))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Tokens.Mobile.Colors.textSecondary)
        .accessibilityLabel("You")
    }

    private func item(_ tab: PhoneShell.Tab) -> some View {
        let selected = bar.tab == tab
        return Button {
            taps[tab, default: 0] += 1
            select(tab)
        } label: {
            VStack(spacing: Tokens.Space.xxs) {
                Image(systemName: tab.systemImage)
                    .font(.system(size: 18, weight: .medium))
                    .symbolVariant(selected ? .fill : .none)
                    .symbolEffect(.bounce, value: taps[tab, default: 0])
                    .frame(height: 22)
                    .overlay(alignment: .topTrailing) {
                        if tab == .activity, unread > 0 {
                            Text("\(unread)")
                                .font(.golem(Tokens.Mobile.FontSize.tabLabel, Tokens.FontWeight.semibold))
                                .foregroundStyle(Tokens.Colors.onAccent)
                                .contentTransition(.numericText(value: Double(unread)))
                                .padding(.horizontal, Tokens.Space.xs)
                                .frame(minWidth: 16, minHeight: 16)
                                .background(Tokens.Colors.accent, in: .capsule)
                                .offset(x: 10, y: -4)
                                .transition(.scale.combined(with: .opacity))
                        }
                    }
                Text(tab.title).font(.golem(Tokens.Mobile.FontSize.tabLabel, Tokens.FontWeight.medium))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background {
                if selected {
                    Capsule()
                        .fill(Tokens.Mobile.Colors.tabSelected)
                        .matchedGeometryEffect(id: "selection", in: selection)
                }
            }
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .foregroundStyle(selected ? Tokens.Mobile.Colors.title : Tokens.Mobile.Colors.textSecondary)
        .accessibilityLabel(tab.title)
        .accessibilityValue(tab == .activity && unread > 0 ? "\(unread) unread" : "")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
