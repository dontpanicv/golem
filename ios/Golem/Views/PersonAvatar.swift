import SwiftUI
import UIKit

/// A person's avatar with their profile picture, which loads once for each path; the initial shows until it loads.
struct PersonAvatar: View {
    let name: String
    let picture: String?
    var size = Tokens.Size.avatar
    @Environment(Session.self) private var session
    @State private var loaded: UIImage?

    /// A picture's path changes with the picture, so a loaded one stays good.
    private static let cache = NSCache<NSString, UIImage>()

    var body: some View {
        Avatar(name: name, image: picture.flatMap { Self.cache.object(forKey: $0 as NSString) } ?? loaded, size: size)
            .task(id: picture) {
                loaded = nil
                guard let picture, Self.cache.object(forKey: picture as NSString) == nil,
                      let data = try? await session.api.profilePicture(picture),
                      let image = UIImage(data: data) else { return }
                Self.cache.setObject(image, forKey: picture as NSString)
                loaded = image
            }
    }
}
