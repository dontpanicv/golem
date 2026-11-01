import Contacts
import Foundation

/// The phone's contacts (Contacts).
enum PhoneContacts {
    private struct FindArguments: Decodable {
        let query: String
    }

    private struct ContactArguments: Decodable {
        struct Phone: Decodable { let number: String; let label: String? }
        struct Email: Decodable { let address: String; let label: String? }
        let id: String?
        let givenName: String?
        let familyName: String?
        let organization: String?
        let phones: [Phone]?
        let emails: [Email]?
        let birthday: String?
    }

    private struct Labeled: Encodable {
        let label: String
        let value: String
    }

    private struct Row: Encodable {
        let id: String
        let name: String
        let organization: String
        let phones: [Labeled]
        let emails: [Labeled]
        let addresses: [Labeled]
        let birthday: String?
    }

    private static let store = CNContactStore()
    private static let keys: [CNKeyDescriptor] = [
        CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
        CNContactGivenNameKey as CNKeyDescriptor,
        CNContactFamilyNameKey as CNKeyDescriptor,
        CNContactOrganizationNameKey as CNKeyDescriptor,
        CNContactPhoneNumbersKey as CNKeyDescriptor,
        CNContactEmailAddressesKey as CNKeyDescriptor,
        CNContactPostalAddressesKey as CNKeyDescriptor,
        CNContactBirthdayKey as CNKeyDescriptor,
    ]

    static func find(_ call: PhoneCall) async throws -> PhoneAnswer {
        let query = try call.arguments(FindArguments.self).query
        try await access()
        let contacts = try store.unifiedContacts(matching: CNContact.predicateForContacts(matchingName: query), keysToFetch: keys)
        return try .json(contacts.prefix(50).map(row))
    }

    static func add(_ call: PhoneCall) async throws -> PhoneAnswer {
        let arguments = try call.arguments(ContactArguments.self)
        try await access()
        let contact = CNMutableContact()
        try apply(arguments, to: contact)
        let request = CNSaveRequest()
        request.add(contact, toContainerWithIdentifier: nil)
        try store.execute(request)
        return try .json(row(contact))
    }

    static func change(_ call: PhoneCall) async throws -> PhoneAnswer {
        let arguments = try call.arguments(ContactArguments.self)
        try await access()
        guard let found = try? store.unifiedContact(withIdentifier: arguments.id ?? "", keysToFetch: keys),
              let contact = found.mutableCopy() as? CNMutableContact
        else { throw PhoneError("There is no contact \(arguments.id ?? "").") }
        try apply(arguments, to: contact)
        let request = CNSaveRequest()
        request.update(contact)
        try store.execute(request)
        return try .json(row(contact))
    }

    private static func apply(_ arguments: ContactArguments, to contact: CNMutableContact) throws {
        if let name = arguments.givenName { contact.givenName = name }
        if let name = arguments.familyName { contact.familyName = name }
        if let organization = arguments.organization { contact.organizationName = organization }
        contact.phoneNumbers += (arguments.phones ?? []).map {
            CNLabeledValue(label: label($0.label), value: CNPhoneNumber(stringValue: $0.number))
        }
        contact.emailAddresses += (arguments.emails ?? []).map {
            CNLabeledValue(label: label($0.label), value: $0.address as NSString)
        }
        if let birthday = arguments.birthday {
            let parts = birthday.split(separator: "-", omittingEmptySubsequences: true).compactMap { Int($0) }
            var components = DateComponents()
            switch parts.count {
            case 3: (components.year, components.month, components.day) = (parts[0], parts[1], parts[2])
            case 2: (components.month, components.day) = (parts[0], parts[1])
            default: throw PhoneError("birthday must be YYYY-MM-DD or --MM-DD.")
            }
            contact.birthday = components
        }
    }

    private static func label(_ name: String?) -> String? {
        switch name?.lowercased() {
        case nil: CNLabelPhoneNumberMobile
        case "mobile": CNLabelPhoneNumberMobile
        case "iphone": CNLabelPhoneNumberiPhone
        case "main": CNLabelPhoneNumberMain
        case "home": CNLabelHome
        case "work": CNLabelWork
        case "school": CNLabelSchool
        case "other": CNLabelOther
        default: name
        }
    }

    private static func row(_ contact: CNContact) -> Row {
        func labeled<Value>(_ values: [CNLabeledValue<Value>], _ text: (Value) -> String) -> [Labeled] {
            values.map {
                Labeled(label: $0.label.map(CNLabeledValue<NSString>.localizedString(forLabel:)) ?? "", value: text($0.value))
            }
        }
        let birthday = contact.birthday.map { birthday in
            let monthDay = String(format: "%02d-%02d", birthday.month ?? 0, birthday.day ?? 0)
            return birthday.year.map { "\($0)-\(monthDay)" } ?? "--\(monthDay)"
        }
        return Row(
            id: contact.identifier,
            name: CNContactFormatter.string(from: contact, style: .fullName) ?? "",
            organization: contact.organizationName,
            phones: labeled(contact.phoneNumbers) { $0.stringValue },
            emails: labeled(contact.emailAddresses) { $0 as String },
            addresses: labeled(contact.postalAddresses) {
                CNPostalAddressFormatter.string(from: $0, style: .mailingAddress)
                    .replacingOccurrences(of: "\n", with: ", ")
            },
            birthday: birthday
        )
    }

    private static func access() async throws {
        if [.authorized, .limited].contains(CNContactStore.authorizationStatus(for: .contacts)) { return }
        guard try await store.requestAccess(for: .contacts) else {
            throw PhoneError("The person did not allow Golem to use Contacts: Settings › Apps › Golem › Contacts.")
        }
    }
}
