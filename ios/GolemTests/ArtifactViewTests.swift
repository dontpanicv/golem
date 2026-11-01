import Testing

@testable import Golem

/// An artifact without a viewport gets one, so it lays out at the phone's width.
@Suite("Artifact viewport")
struct ArtifactViewportTests {
    @Test func findsTheViewportOfThePage() {
        #expect(ArtifactWebView.hasViewport(#"<head><meta name="viewport" content="width=device-width"></head>"#))
        #expect(ArtifactWebView.hasViewport("<META content='width=device-width' NAME=viewport>"))
    }

    @Test func aPageWithoutOneHasNone() {
        #expect(!ArtifactWebView.hasViewport("<h1>Heating plan</h1><p>The viewport is open.</p>"))
        #expect(!ArtifactWebView.hasViewport(#"<meta charset="utf-8">"#))
    }
}
