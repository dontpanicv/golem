import CoreTransferable
import Foundation
import UniformTypeIdentifiers

/// A file from the photo library, dropped or pasted on Golem, or shared to it, copied to the temporary folder.
struct PickedFile: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .item) { received in
            guard let url = pickedCopy(received.file) else { throw CocoaError(.fileReadUnknown) }
            return PickedFile(url: url)
        }
    }
}

/// A copy of a picked file in the temporary folder: the picked file is readable only while its security scope is open.
nonisolated func pickedCopy(_ url: URL) -> URL? {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    let copy = FileManager.default.temporaryDirectory
        .appending(path: UUID().uuidString)
        .appending(path: url.lastPathComponent)
    do {
        try FileManager.default.createDirectory(at: copy.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: url, to: copy)
        return copy
    } catch {
        return nil
    }
}
