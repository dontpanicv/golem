import Foundation
import Security

/// The session in the Keychain: the server and its token. The Share extension reads them too, through the access
/// group that both have (`keychain-access-groups` in project.yml).
enum Keychain {
    static var token: String? {
        get { read("token") }
        set { write("token", newValue) }
    }

    static var serverURL: String? {
        get { read("serverURL") }
        set { write("serverURL", newValue) }
    }

    /// The app's bundle id, also in the extension, so both find the same items.
    private static let service = Bundle.main.object(forInfoDictionaryKey: "GolemAppBundleID") as? String ?? "Golem"

    private static func query(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }

    private static func read(_ account: String) -> String? {
        var result: AnyObject?
        var search = query(account)
        search[kSecReturnData as String] = true
        guard SecItemCopyMatching(search as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func write(_ account: String, _ value: String?) {
        SecItemDelete(query(account) as CFDictionary)
        guard let value else { return }
        var item = query(account)
        item[kSecValueData as String] = Data(value.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(item as CFDictionary, nil)
    }
}
