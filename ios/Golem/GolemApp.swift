import SwiftUI
import UIKit

@main
struct GolemApp: App {
    init() {
        // Navigation titles use Inter like the rest of the app.
        let appearance = UINavigationBar.appearance()
        // Large titles are page titles: `fontSize.xxl` `medium`.
        let largeTitle = UIFont(name: "InterVariable-Medium", size: Tokens.FontSize.xxl)
        let title = UIFont(name: "InterVariable-SemiBold", size: Tokens.FontSize.lg)
        appearance.largeTitleTextAttributes = [.font: largeTitle as Any]
        appearance.titleTextAttributes = [.font: title as Any]
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}
