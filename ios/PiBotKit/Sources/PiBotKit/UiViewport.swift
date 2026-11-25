import Foundation

public enum UiViewport {
    public static func scrollPosition(current: Double, delta: Double, minimum: Double, maximum: Double) -> Double {
        min(maximum, max(minimum, current + delta))
    }
    /// Content and available chat heights are native points after CSS viewport conversion.
    public static func displayHeight(content: Double, available: Double) -> Double {
        let limit = min(6000, max(100, available.isFinite ? available * 0.75 : 100))
        return min(limit, max(100, content.isFinite ? content : 100))
    }
}
