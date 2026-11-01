import UIKit
import VisionKit

/// The camera: the person takes a photo (UIKit) or scans pages (VisionKit), and the agent looks at them.
enum PhoneCamera {
    private struct Arguments: Decodable {
        let mode: String?
    }

    static func take(_ call: PhoneCall) async throws -> PhoneAnswer {
        let document = try call.arguments(Arguments.self).mode == "document"
        let top = try PhoneLink.topScreen()
        let images: [UIImage]
        if document {
            guard VNDocumentCameraViewController.isSupported else { throw PhoneError("This phone cannot scan documents.") }
            let controller = VNDocumentCameraViewController()
            let delegate = ScanDelegate()
            controller.delegate = delegate
            images = await withCheckedContinuation { continuation in
                delegate.finished = { continuation.resume(returning: $0) }
                top.present(controller, animated: true)
            }
        } else {
            guard UIImagePickerController.isSourceTypeAvailable(.camera) else { throw PhoneError("This phone has no camera.") }
            let controller = UIImagePickerController()
            controller.sourceType = .camera
            let delegate = PhotoDelegate()
            controller.delegate = delegate
            images = await withCheckedContinuation { continuation in
                delegate.finished = { continuation.resume(returning: $0) }
                top.present(controller, animated: true)
            }
        }
        guard !images.isEmpty else { return PhoneAnswer(text: "The person closed the camera without a picture.") }
        return PhoneAnswer(
            text: document ? "The person scanned \(images.count) pages." : "The person took a photo.",
            images: images.compactMap { jpeg($0) }
        )
    }

    /// The picture at most 1600 points on its longer side, as JPEG.
    static func jpeg(_ image: UIImage) -> Data? {
        let scale = min(1, 1600 / max(image.size.width, image.size.height))
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format)
            .image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
            .jpegData(compressionQuality: 0.8)
    }

    private final class PhotoDelegate: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        var finished: ([UIImage]) -> Void = { _ in }

        func imagePickerController(
            _ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            picker.dismiss(animated: true)
            finished((info[.originalImage] as? UIImage).map { [$0] } ?? [])
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            picker.dismiss(animated: true)
            finished([])
        }
    }

    private final class ScanDelegate: NSObject, VNDocumentCameraViewControllerDelegate {
        var finished: ([UIImage]) -> Void = { _ in }

        func documentCameraViewController(
            _ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan
        ) {
            controller.dismiss(animated: true)
            finished((0..<scan.pageCount).map(scan.imageOfPage(at:)))
        }

        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            controller.dismiss(animated: true)
            finished([])
        }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
            controller.dismiss(animated: true)
            finished([])
        }
    }
}
