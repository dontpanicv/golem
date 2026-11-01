import Photos
import UIKit

/// The photo library (Photos): find photos and videos, look at one, and save the workspace's pictures and videos.
enum PhoneLibrary {
    private struct FindArguments: Decodable {
        let from: String?
        let to: String?
        let kind: String?
        let favorites: Bool?
        let limit: Int?
    }

    private struct PhotoArguments: Decodable {
        let id: String
    }

    private struct SaveArguments: Decodable {
        let fileId: String
    }

    private struct Row: Encodable {
        let id: String
        let date: Date?
        let kind: String
        let favorite: Bool
        let width: Int
        let height: Int
        let seconds: Double?
        let latitude: Double?
        let longitude: Double?
    }

    static func find(_ call: PhoneCall) async throws -> PhoneAnswer {
        let arguments = try call.arguments(FindArguments.self)
        try await access()
        var predicates: [NSPredicate] = []
        if let from = arguments.from { predicates.append(NSPredicate(format: "creationDate >= %@", try PhoneLink.date(from) as NSDate)) }
        if let to = arguments.to { predicates.append(NSPredicate(format: "creationDate < %@", try PhoneLink.date(to) as NSDate)) }
        if arguments.favorites == true { predicates.append(NSPredicate(format: "favorite == YES")) }
        switch arguments.kind {
        case "photo": predicates.append(NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue))
        case "video": predicates.append(NSPredicate(format: "mediaType == %d", PHAssetMediaType.video.rawValue))
        case "screenshot": predicates.append(subtype(.photoScreenshot))
        case "live": predicates.append(subtype(.photoLive))
        default: break
        }
        let options = PHFetchOptions()
        options.predicate = NSCompoundPredicate(andPredicateWithSubpredicates: predicates)
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.fetchLimit = arguments.limit ?? 20
        var rows: [Row] = []
        PHAsset.fetchAssets(with: options).enumerateObjects { asset, _, _ in
            rows.append(Row(
                id: asset.localIdentifier,
                date: asset.creationDate,
                kind: kind(asset),
                favorite: asset.isFavorite,
                width: asset.pixelWidth,
                height: asset.pixelHeight,
                seconds: asset.mediaType == .video ? asset.duration : nil,
                latitude: asset.location?.coordinate.latitude,
                longitude: asset.location?.coordinate.longitude
            ))
        }
        return try .json(rows)
    }

    static func photo(_ call: PhoneCall) async throws -> PhoneAnswer {
        let id = try call.arguments(PhotoArguments.self).id
        try await access()
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else {
            throw PhoneError("There is no photo \(id).")
        }
        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.isNetworkAccessAllowed = true
        let image = await withCheckedContinuation { continuation in
            PHImageManager.default().requestImage(
                for: asset, targetSize: CGSize(width: 1600, height: 1600), contentMode: .aspectFit, options: options
            ) { image, _ in
                continuation.resume(returning: image?.jpegData(compressionQuality: 0.8))
            }
        }
        guard let image else { throw PhoneError("The phone could not load photo \(id).") }
        return PhoneAnswer(text: "\(kind(asset)) taken \(asset.creationDate?.formatted(.iso8601) ?? "at an unknown time").", images: [image])
    }

    static func save(_ call: PhoneCall) async throws -> PhoneAnswer {
        let fileId = try call.arguments(SaveArguments.self).fileId
        let file = try await PhoneLink.file(call, fileId)
        defer { try? FileManager.default.removeItem(at: file.url) }
        let type: PHAssetResourceType
        if file.mimeType.hasPrefix("image/") { type = .photo }
        else if file.mimeType.hasPrefix("video/") { type = .video }
        else { throw PhoneError("\(file.url.lastPathComponent) is not a picture or a video.") }
        if PHPhotoLibrary.authorizationStatus(for: .addOnly) != .authorized,
           await PHPhotoLibrary.requestAuthorization(for: .addOnly) != .authorized {
            throw PhoneError("The person did not allow Golem to add to Photos: Settings › Apps › Golem › Photos.")
        }
        try await PHPhotoLibrary.shared().performChanges {
            PHAssetCreationRequest.forAsset().addResource(with: type, fileURL: file.url, options: nil)
        }
        return PhoneAnswer(text: "Saved \(file.url.lastPathComponent) to Photos.")
    }

    private static func subtype(_ subtype: PHAssetMediaSubtype) -> NSPredicate {
        NSPredicate(format: "(mediaSubtypes & %d) != 0", subtype.rawValue)
    }

    nonisolated private static func kind(_ asset: PHAsset) -> String {
        if asset.mediaType == .video { return "video" }
        if asset.mediaSubtypes.contains(.photoScreenshot) { return "screenshot" }
        if asset.mediaSubtypes.contains(.photoLive) { return "live photo" }
        return "photo"
    }

    private static func access() async throws {
        if [.authorized, .limited].contains(PHPhotoLibrary.authorizationStatus(for: .readWrite)) { return }
        guard [.authorized, .limited].contains(await PHPhotoLibrary.requestAuthorization(for: .readWrite)) else {
            throw PhoneError("The person did not allow Golem to use Photos: Settings › Apps › Golem › Photos.")
        }
    }
}
