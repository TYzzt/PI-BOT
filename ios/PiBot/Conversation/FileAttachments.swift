import SwiftUI
import UIKit
import PiBotKit

struct FileDraft: Identifiable, Sendable {
    let id = UUID().uuidString.lowercased()
    let name: String
    let data: Data
    var progress = 0
    var artifact: ReportAttachment?
    var error: String?
}

func readFileDraft(_ url: URL) async throws -> FileDraft {
    try await Task.detached(priority: .userInitiated) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var data = Data()
        while let chunk = try handle.read(upToCount: 65536), !chunk.isEmpty {
            try Task.checkCancellation()
            guard data.count + chunk.count <= 10 * 1024 * 1024 else { throw APIError(status: 413, message: "每份文件最多 10 MiB") }
            data.append(chunk)
        }
        guard !data.isEmpty else { throw APIError(status: 422, message: "文件不能为空") }
        return FileDraft(name: url.lastPathComponent, data: data)
    }.value
}

struct CameraCapture: UIViewControllerRepresentable {
    let completion: (UIImage?) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(completion) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let completion: (UIImage?) -> Void
        init(_ completion: @escaping (UIImage?) -> Void) { self.completion = completion }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { completion(nil) }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            completion(info[.originalImage] as? UIImage)
        }
    }
}
