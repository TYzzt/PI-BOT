import AVFoundation
import Combine
import Speech
import SwiftUI

/// Uses the system recognizer; only its transcript becomes part of the message.
@MainActor
final class ComposerSpeech: ObservableObject {
    enum Phase: Equatable { case idle, authorizing, recording, finishing }
    @Published private(set) var phase: Phase = .idle
    enum Event { case error(String), recognized(String) }
    let events = PassthroughSubject<Event, Never>()

    private var session: UUID?
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognizer: SFSpeechRecognizer?
    private var recognition: SFSpeechRecognitionTask?
    private var finalTranscript: String?
    private var timeout: Task<Void, Never>?

    func press() {
        guard phase == .idle else { return }
        let id = UUID()
        session = id
        phase = .authorizing
        Task { [weak self] in
            let authorization: SFSpeechRecognizerAuthorizationStatus = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
            }
            guard let self, self.session == id else { return }
            guard authorization == .authorized else { self.fail("请允许语音识别权限"); return }
            let microphone = await AVAudioApplication.requestRecordPermission()
            guard self.session == id else { return }
            guard microphone else { self.fail("需要麦克风权限才能输入语音指令"); return }
            self.startRecording(id: id)
        }
    }

    private func startRecording(id: UUID) {
        guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else { fail("此设备当前没有可用的系统语音识别服务"); return }
        let audio = AVAudioSession.sharedInstance()
        do {
            try audio.setCategory(.record, mode: .measurement)
            try audio.setActive(true)
            let engine = AVAudioEngine()
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                try? audio.setActive(false, options: .notifyOthersOnDeactivation)
                fail("当前没有可用的麦克风")
                return
            }
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
            self.engine = engine
            self.request = request
            self.recognizer = recognizer
            recognition = recognizer.recognitionTask(with: request) { [weak self] result, error in
                let transcript = result.flatMap { $0.isFinal ? $0.bestTranscription.formattedString : nil }
                let failed = error != nil
                Task { @MainActor in
                    guard let self, self.session == id else { return }
                    if let transcript {
                        if self.phase == .finishing { self.finish(transcript) }
                        else { self.finalTranscript = transcript; self.stopRecording() }
                    } else if failed, self.finalTranscript == nil {
                        self.fail("语音识别失败，请重试")
                    }
                }
            }
            engine.prepare()
            try engine.start()
            phase = .recording
        } catch { fail("无法启动麦克风：\(error.localizedDescription)") }
    }

    func release() {
        if phase == .authorizing { cancel(); return }
        guard phase == .recording else { return }
        phase = .finishing
        stopRecording()
        if let finalTranscript { finish(finalTranscript); return }
        timeout = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(8)) } catch { return }
            self?.fail("语音识别超时，请重试")
        }
    }

    func cancel() {
        session = nil
        timeout?.cancel()
        timeout = nil
        stopRecording()
        recognition?.cancel()
        recognition = nil
        recognizer = nil
        request = nil
        finalTranscript = nil
        phase = .idle
    }

    private func stopRecording() {
        guard let engine else { return }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        self.engine = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func fail(_ message: String) { cancel(); events.send(.error(message)) }

    private func finish(_ value: String) {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        cancel()
        if text.isEmpty { events.send(.error("未识别到语音，请重试")) } else { events.send(.recognized(text)) }
    }
}

struct HoldToSpeak: View {
    @ObservedObject var speech: ComposerSpeech
    let enabled: Bool
    @GestureState private var touching = false
    @State private var pressed = false

    var body: some View {
        Text(label)
            .font(.caption.weight(.medium))
            .foregroundStyle(enabled ? Palette.accent : Palette.muted)
            .frame(width: 62, height: 44)
            .contentShape(Rectangle())
            .accessibilityLabel("\(label)，滑出取消")
            .gesture(DragGesture(minimumDistance: 0)
                .updating($touching) { _, state, _ in state = true }
                .onChanged { _ in
                    guard enabled, !pressed, speech.phase == .idle else { return }
                    pressed = true
                    speech.press()
                }
                .onEnded { value in
                    guard pressed else { return }
                    pressed = false
                    if CGRect(x: -12, y: -12, width: 86, height: 68).contains(value.location) { speech.release() }
                    else { speech.cancel() }
                })
            .onChange(of: touching) { _, touching in
                if !touching && pressed {
                    // A cancelled gesture has no onEnded callback.
                    Task { @MainActor in
                        if pressed && !self.touching { pressed = false; speech.cancel() }
                    }
                }
            }
    }

    private var label: String {
        switch speech.phase {
        case .idle: return "按住说话"
        case .authorizing: return "准备中"
        case .recording: return "松开发送"
        case .finishing: return "识别中"
        }
    }
}
