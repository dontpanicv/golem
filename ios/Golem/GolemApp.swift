import SwiftUI
import UIKit

@main
struct GolemApp: App {
    init() {
        // Navigation titles use Inter like the rest of the app.
        let appearance = UINavigationBar.appearance()
        // Large titles are page titles: `fontSize.xxl` `medium`.
        appearance.largeTitleTextAttributes = [.font: UIFont(name: "InterVariable-Medium", size: Tokens.FontSize.xxl) as Any]
        appearance.titleTextAttributes = [.font: UIFont(name: "InterVariable-SemiBold", size: Tokens.FontSize.lg) as Any]
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}
