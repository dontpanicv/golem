import PassKit

/// Apple Wallet (PassKit): adds a pass file of the workspace, which the person confirms.
enum PhoneWallet {
    private struct Arguments: Decodable {
        let fileId: String
    }

    static func add(_ call: PhoneCall) async throws -> PhoneAnswer {
        let file = try await PhoneLink.file(call, try call.arguments(Arguments.self).fileId)
        defer { try? FileManager.default.removeItem(at: file.url) }
        let pass: PKPass
        do {
            pass = try PKPass(data: try Data(contentsOf: file.url))
        } catch {
            throw PhoneError("\(file.url.lastPathComponent) is not a valid Wallet pass.")
        }
        guard let controller = PKAddPassesViewController(pass: pass) else { throw PhoneError("This phone cannot add passes.") }
        let top = try PhoneLink.topScreen()
        let delegate = Delegate()
        controller.delegate = delegate
        await withCheckedContinuation { continuation in
            delegate.finished = { continuation.resume() }
            top.present(controller, animated: true)
        }
        return PhoneAnswer(
            text: PKPassLibrary().containsPass(pass) ? "The pass is in Wallet." : "The person did not add the pass."
        )
    }

    private final class Delegate: NSObject, PKAddPassesViewControllerDelegate {
        var finished: () -> Void = {}

        func addPassesViewControllerDidFinish(_ controller: PKAddPassesViewController) {
            controller.dismiss(animated: true)
            finished()
        }
    }
}
