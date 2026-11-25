import WebKit
import PiBotKit

/// Vertical pans consume the page first, then pass only the remainder to the chat.
/// Horizontal pans remain with WebKit so DOM tables and Tabs keep native touch scrolling.
final class InlineUiWebView: WKWebView {
    private(set) lazy var scrolling = UiScrollHandoff(web: self)
    var onLayout: (() -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        scrolling.attachToChat()
        onLayout?()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { scrolling.stop() }
    }
}

@MainActor
final class UiScrollHandoff: NSObject, UIGestureRecognizerDelegate {
    private weak var web: WKWebView?
    private weak var chat: UIScrollView?
    private lazy var pan = UIPanGestureRecognizer(target: self, action: #selector(drag))
    private var displayLink: CADisplayLink?
    private var velocity: CGFloat = 0
    private var timestamp: CFTimeInterval = 0
    private var hitTest = 0
    private var canHandoff = false
    private var touchStarted: CFTimeInterval = 0

    init(web: WKWebView) {
        self.web = web
        super.init()
        pan.delegate = self
        pan.maximumNumberOfTouches = 1
        web.addGestureRecognizer(pan)
        web.scrollView.panGestureRecognizer.require(toFail: pan)
        web.scrollView.bounces = false
        web.scrollView.alwaysBounceVertical = false
        web.scrollView.alwaysBounceHorizontal = false
    }

    func attachToChat() {
        var ancestor = web?.superview
        while let view = ancestor {
            if let scroll = view as? UIScrollView {
                if chat !== scroll {
                    chat = scroll
                    scroll.panGestureRecognizer.require(toFail: pan)
                }
                break
            }
            ancestor = view.superview
        }
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        attachToChat()
        guard let web, chat != nil, web.scrollView.isScrollEnabled, canHandoff,
              CACurrentMediaTime() - touchStarted < 0.4 else { return false }
        let direction = pan.velocity(in: web.window)
        return abs(direction.y) > abs(direction.x)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        stop()
        canHandoff = false
        hitTest += 1
        let current = hitTest
        touchStarted = CACurrentMediaTime()
        guard let web, web.bounds.width > 0, web.bounds.height > 0 else { return false }
        let point = touch.location(in: web)
        // A late/failed response leaves the gesture with WebKit. Controls, maps and
        // text selection must keep their existing DOM gestures and recognizers.
        web.evaluateJavaScript("window.piBotUi?.canScrollAt(\(point.x / web.bounds.width),\(point.y / web.bounds.height)) === true") { [weak self] result, _ in
            guard let self, self.hitTest == current, self.pan.state == .possible else { return }
            self.canHandoff = result as? Bool == true
        }
        return true
    }

    private func consume(_ delta: CGFloat, in scroll: UIScrollView) -> CGFloat {
        let lower = -scroll.adjustedContentInset.top
        let upper = max(lower, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
        let before = scroll.contentOffset.y
        let after = CGFloat(UiViewport.scrollPosition(current: Double(before), delta: Double(delta), minimum: Double(lower), maximum: Double(upper)))
        scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: after), animated: false)
        return after - before
    }

    @discardableResult private func move(_ delta: CGFloat) -> CGFloat {
        guard let web else { return 0 }
        let inner = consume(delta, in: web.scrollView)
        let outer = chat.map { consume(delta - inner, in: $0) } ?? 0
        return inner + outer
    }

    @objc private func drag() {
        guard let web else { return }
        switch pan.state {
        case .began:
            stop()
            if let chat { chat.setContentOffset(chat.contentOffset, animated: false) }
            web.scrollView.setContentOffset(web.scrollView.contentOffset, animated: false)
            fallthrough
        case .changed:
            // Window coordinates stay stable when handing motion to the chat moves this view.
            move(-pan.translation(in: web.window).y)
            pan.setTranslation(.zero, in: web.window)
        case .ended:
            velocity = -pan.velocity(in: web.window).y
            timestamp = 0
            displayLink = CADisplayLink(target: self, selector: #selector(tick(_:)))
            displayLink?.add(to: .main, forMode: .common)
        case .cancelled, .failed: stop()
        default: break
        }
    }

    @objc private func tick(_ link: CADisplayLink) {
        guard timestamp > 0 else { timestamp = link.timestamp; return }
        let elapsed = min(link.timestamp - timestamp, 0.05)
        timestamp = link.timestamp
        let consumed = move(velocity * CGFloat(elapsed))
        velocity *= CGFloat(pow(Double(UIScrollView.DecelerationRate.normal.rawValue), elapsed * 1000))
        if abs(velocity) < 10 || abs(consumed) < 0.1 { stop() }
    }

    func stop() { displayLink?.invalidate(); displayLink = nil; velocity = 0 }
}
