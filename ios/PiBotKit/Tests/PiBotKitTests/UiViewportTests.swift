import XCTest
@testable import PiBotKit

final class UiViewportTests: XCTestCase {
    func testOnlyRemainingMotionTransfersAtEdges() {
        XCTAssertEqual(UiViewport.scrollPosition(current: 50, delta: 20, minimum: 0, maximum: 100), 70)
        XCTAssertEqual(80 - (UiViewport.scrollPosition(current: 50, delta: 80, minimum: 0, maximum: 100) - 50), 30)
        XCTAssertEqual(-80 - (UiViewport.scrollPosition(current: 50, delta: -80, minimum: 0, maximum: 100) - 50), -30)
    }
    func testShortLongAndRotatedViewports() {
        for (content, available, expected) in [(0.0, 800.0, 100.0), (599, 800, 599), (600, 800, 600), (601, 800, 600), (16000, 800, 600), (16000, 400, 300), (16000, 10000, 6000)] {
            XCTAssertEqual(UiViewport.displayHeight(content: content, available: available), expected)
        }
    }
}
