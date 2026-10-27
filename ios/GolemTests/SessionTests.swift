import Testing

@testable import Golem

/// The PKCE challenge of the Google sign-in.
@Suite("Sign-in")
struct SignInTests {
    /// RFC 7636, appendix B.
    @Test func challengeIsTheBase64URLSHA256OfTheVerifier() {
        #expect(
            Session.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
                == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        )
    }
}
