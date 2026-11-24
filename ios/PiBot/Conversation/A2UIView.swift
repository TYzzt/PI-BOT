import SwiftUI
import WebKit
import PiBotKit

private let uiScheme = "pibot-ui"
private let uiIndex = URL(string: "pibot-ui://app/a2ui/index.html")!

/// The page calls `window.PiBotUiHost.postMessage`, the Android bridge name; map it onto WebKit's handler.
private let bridgeScript = """
window.PiBotUiHost = { postMessage: function (value) { window.webkit.messageHandlers.piBotUiHost.postMessage(String(value)); } };
"""

/// Interactive A2UI surface for one bot message, rendered by the shared web renderer.
struct A2UIView: View {
    @Environment(AppStore.self) private var store
    let message: Message
    let disabled: Bool
    var onDisplayed: (Set<String>, Bool) -> Void = { _, _ in }
    @State private var height: CGFloat = 180

    var body: some View {
        A2UIWebView(message: message, disabled: disabled, store: store, height: $height, onDisplayed: onDisplayed)
            .frame(height: height)
            .frame(maxWidth: .infinity)
    }
}

private struct A2UIWebView: UIViewRepresentable {
    let message: Message
    let disabled: Bool
    let store: AppStore
    @Binding var height: CGFloat
    var onDisplayed: (Set<String>, Bool) -> Void = { _, _ in }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(A2UIAssets(), forURLScheme: uiScheme)
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        let content = WKUserContentController()
        content.addUserScript(WKUserScript(source: bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        content.add(WeakScriptHandler(context.coordinator), name: "piBotUiHost")
        config.userContentController = content
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        web.scrollView.isScrollEnabled = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.navigationDelegate = context.coordinator
        context.coordinator.web = web
        web.load(URLRequest(url: uiIndex))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.sendDocumentIfChanged()
    }

    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        web.configuration.userContentController.removeScriptMessageHandler(forName: "piBotUiHost")
        web.stopLoading()
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var parent: A2UIWebView
        weak var web: WKWebView?
        private var ready = false
        private var sent: String?

        init(_ parent: A2UIWebView) { self.parent = parent }

        private var payload: String {
            JSONValue.object(["document": parent.message.ui ?? .null, "disabled": .bool(parent.disabled)]).jsonString()
        }

        func sendDocumentIfChanged() {
            guard ready, let web else { return }
            let next = payload
            guard next != sent else { return }
            sent = next
            web.evaluateJavaScript("window.piBotUi?.receive(JSON.parse(\(JSONValue.string(next).jsonString())));", completionHandler: nil)
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            action.request.url == uiIndex && action.targetFrame?.isMainFrame == true ? .allow : .cancel
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let raw = message.body as? String, raw.count <= 240_000, let packet = JSONValue.parse(raw) else { return }
            switch packet["type"]?.stringValue {
            case "ready":
                ready = true
                sent = nil
                sendDocumentIfChanged()
            case "height":
                if let value = packet["height"]?.intValue { parent.height = CGFloat(min(max(value, 100), 6000)) }
            case "displayed":
                if case .array(let items)? = packet["ids"] {
                    let allowed = Set(parent.message.attachments.map(\.id))
                    parent.onDisplayed(Set(items.compactMap(\.stringValue)).intersection(allowed), packet["remove"]?.boolValue ?? false)
                }
            case "state", "action", "image", "open", "external":
                guard let id = packet["id"]?.stringValue, let body = packet["payload"], case .object = body else { return }
                let kind = packet["type"]?.stringValue
                let isState = kind == "state"
                let target = parent.message
                let locked = parent.disabled
                let store = parent.store
                Task { @MainActor in
                    var response: [String: JSONValue] = ["id": .string(id)]
                    do {
                        if (kind == "state" || kind == "action") && locked { throw APIError(status: 0, message: "请等待 Bot 完成当前任务后再操作") }
                        if kind == "image" || kind == "open" {
                            guard let artifactId = body["id"]?.stringValue, target.attachments.contains(where: { $0.id == artifactId }) else { throw APIError(status: 404, message: "附件不属于当前消息") }
                            if kind == "image" {
                                let variant = body["variant"]?.stringValue == "original" ? "original" : "thumbnail"
                                let image = try await store.artifactImage(botId: target.botId, messageId: target.id, artifactId: artifactId, variant: variant)
                                response["result"] = .string("data:\(image.mimeType);base64,\(image.data)")
                            } else {
                                await UIApplication.shared.open(try await store.reportOpen(artifactId))
                                response["result"] = .null
                            }
                        } else if kind == "external" {
                            guard let text = body["url"]?.stringValue, let url = URL(string: text), ["https", "http"].contains(url.scheme ?? ""), url.host != nil, url.user == nil, url.password == nil else { throw APIError(status: 422, message: "链接无效") }
                            await UIApplication.shared.open(url)
                            response["result"] = .null
                        } else if isState {
                            response["result"] = try await store.saveUiState(botId: target.botId, messageId: target.id, payload: body)
                        } else {
                            try await store.submitUiAction(botId: target.botId, messageId: target.id, payload: body)
                            response["result"] = .null
                        }
                    } catch {
                        response["error"] = .string(errorText(error))
                    }
                    let json = JSONValue.object(response).jsonString()
                    _ = try? await self.web?.evaluateJavaScript("window.piBotUi?.respond(JSON.parse(\(JSONValue.string(json).jsonString())));")
                }
            default:
                break
            }
        }
    }
}

/// Avoids the retain cycle between `WKUserContentController` and the coordinator.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: (any WKScriptMessageHandler)?
    init(_ target: any WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

/// Renderer assets only. No account token, file system or general native API is exposed to the page.
private final class A2UIAssets: NSObject, WKURLSchemeHandler {
    private static let files = ["/a2ui/index.html": "text/html", "/a2ui/renderer.js": "text/javascript", "/a2ui/style.css": "text/css"]

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        guard let url = task.request.url, url.host == "app", let mime = Self.files[url.path],
              let file = Bundle.main.url(forResource: url.lastPathComponent, withExtension: nil, subdirectory: "a2ui"),
              let data = try? Data(contentsOf: file) else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": "\(mime); charset=utf-8",
            "Content-Length": String(data.count),
            "Access-Control-Allow-Origin": "pibot-ui://app",
        ])!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}
}
