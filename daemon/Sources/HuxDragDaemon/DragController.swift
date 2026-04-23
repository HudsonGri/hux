import Foundation
import AppKit
import ApplicationServices

// A Sendable-safe weak box for passing a class reference into a
// concurrently-executing closure. The `weak var` itself is not Sendable,
// but this wrapper is (AnyObject references are atomic).
private final class WeakRef<T: AnyObject>: @unchecked Sendable {
    weak var value: T?
    init(_ value: T) { self.value = value }
}

final class DragController {
    private var active: ActiveDrag?
    private var previewWindow: DragPreviewWindow?
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var dropInFlight = false

    private struct ActiveDrag {
        let paneId: String
        let title: String
        let accent: Int
        let huxBinary: String
        let command: String?
        weak var connection: ClientConnection?
        var sourceWindowFrame: CGRect?
        var outsideSource: Bool
    }

    func beginDrag(message: DragStartMessage, connection: ClientConnection) {
        Log.info("beginDrag paneId=\(message.paneId)")
        if active != nil {
            Log.error("beginDrag: drag already in progress")
            connection.send(DragResult(outcome: .error, message: "drag already in progress"))
            return
        }

        let trusted = ensureAccessibility()
        Log.info("beginDrag: ax trusted=\(trusted)")
        if !trusted {
            connection.send(PermissionDenied(what: "accessibility"))
            return
        }

        let sourceFrame = sourceWindowFrame(for: message)
        Log.info("beginDrag: sourceFrame=\(String(describing: sourceFrame))")
        active = ActiveDrag(
            paneId: message.paneId,
            title: message.title ?? message.paneId,
            accent: message.accent ?? 117,
            huxBinary: message.huxBinary ?? "hux",
            command: message.command,
            connection: connection,
            sourceWindowFrame: sourceFrame,
            outsideSource: false
        )

        preparePreview(message: message)
        startEventTap()
        Log.info("beginDrag: event tap started")
    }

    func cancelDrag(connection: ClientConnection) {
        guard let current = active, current.connection === connection else { return }
        if dropInFlight {
            // A drop is already being dispatched to Ghostty; ignore spurious
            // cancels (e.g. from a partial SGR mouse report in the client).
            Log.info("cancelDrag ignored: drop already in flight")
            return
        }
        _ = current
        finish(outcome: .cancelled, target: nil, message: nil)
    }

    func connectionClosed(_ connection: ClientConnection) {
        guard let current = active, current.connection === connection else { return }
        if dropInFlight {
            // AppleScript has already been dispatched to Ghostty. Cancelling now
            // would tear down the preview/event tap while the drop is still
            // committing, and the client is gone anyway — let the in-flight
            // Task.detached complete and clean up via finish().
            Log.info("connectionClosed: drop in flight, letting it finish")
            return
        }
        _ = current
        finish(outcome: .cancelled, target: nil, message: nil)
    }

    private func ensureAccessibility() -> Bool {
        let promptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        let options: CFDictionary = [promptKey: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    private func sourceWindowFrame(for message: DragStartMessage) -> CGRect? {
        let cursor = currentCursorPosition()
        return windowFrameUnderPoint(cursor)
    }

    private func preparePreview(message: DragStartMessage) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let win = DragPreviewWindow(
                title: message.title ?? message.paneId,
                accent: message.accent ?? 117,
                preview: message.preview ?? []
            )
            self.previewWindow = win
        }
    }

    private var tapRefcon: Unmanaged<DragController>?

    private func startEventTap() {
        guard eventTap == nil else { return }
        let mask: CGEventMask =
            (1 << CGEventType.mouseMoved.rawValue) |
            (1 << CGEventType.leftMouseDragged.rawValue) |
            (1 << CGEventType.leftMouseUp.rawValue) |
            (1 << CGEventType.keyDown.rawValue)

        // Retain `self` for the lifetime of the tap so the callback can never
        // dereference a dead pointer if the controller is released between
        // "tap enabled" and the event firing. Released in stopEventTap().
        let retained = Unmanaged.passRetained(self)
        let refcon = retained.toOpaque()
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: { _, type, event, info in
                guard let info = info else { return Unmanaged.passUnretained(event) }
                let ctl = Unmanaged<DragController>.fromOpaque(info).takeUnretainedValue()
                ctl.handle(type: type, event: event)
                return Unmanaged.passUnretained(event)
            },
            userInfo: refcon
        ) else {
            retained.release()
            finish(outcome: .error, target: nil, message: "CGEventTap failed — missing accessibility permission?")
            return
        }
        let src = CFMachPortCreateRunLoopSource(nil, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        eventTap = tap
        runLoopSource = src
        tapRefcon = retained
    }

    private func stopEventTap() {
        if let src = runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), src, .commonModes)
        }
        if let tap = eventTap {
            CGEvent.tapEnable(tap: tap, enable: false)
        }
        eventTap = nil
        runLoopSource = nil
        tapRefcon?.release()
        tapRefcon = nil
    }

    private func handle(type: CGEventType, event: CGEvent) {
        switch type {
        case .leftMouseDragged, .mouseMoved:
            let point = event.location
            update(cursor: point)
        case .leftMouseUp:
            let point = event.location
            drop(at: point)
        case .keyDown:
            let keycode = event.getIntegerValueField(.keyboardEventKeycode)
            if keycode == 53 {
                finish(outcome: .cancelled, target: nil, message: nil)
            }
        default:
            break
        }
    }

    private func update(cursor: CGPoint) {
        guard var current = active else { return }
        let insideSource = current.sourceWindowFrame.map { containsFlipped($0, cursor) } ?? false
        if !current.outsideSource && !insideSource {
            Log.info("cursor left source window at \(cursor)")
        }
        if !insideSource {
            current.outsideSource = true
            active = current
            DispatchQueue.main.async { [weak self] in
                self?.previewWindow?.move(to: cursor)
                self?.previewWindow?.showIfNeeded()
            }
        } else {
            DispatchQueue.main.async { [weak self] in
                self?.previewWindow?.hide()
            }
        }
    }

    private func drop(at point: CGPoint) {
        guard let current = active else { return }
        if !current.outsideSource {
            Log.debug("drop inside source window — cancelling")
            finish(outcome: .cancelled, target: nil, message: nil)
            return
        }
        let classification = DropClassifier.classify(at: point)
        Log.info("drop at \(point) classified as \(classification)")
        dropInFlight = true
        let huxBinary = current.huxBinary
        let command = current.command
        // Bind `self` into a `let` so the MainActor.run closure captures an
        // immutable reference (Swift 6 strict-concurrency rejects capturing a
        // weak var into a concurrently-executing closure).
        let controllerRef = WeakRef(self)
        Task.detached {
            let bridge = GhosttyBridge()
            do {
                let target = try await bridge.execute(
                    for: classification,
                    paneId: current.paneId,
                    huxBinary: huxBinary,
                    command: command
                )
                Log.info("applescript succeeded — target=\(target)")
                await MainActor.run {
                    controllerRef.value?.finish(outcome: .dropped, target: target, message: nil)
                }
            } catch {
                Log.error("applescript failed: \(error)")
                await MainActor.run {
                    controllerRef.value?.finish(outcome: .error, target: nil, message: "\(error)")
                }
            }
        }
    }

    private func finish(outcome: DragOutcome, target: DropTargetKind?, message: String?) {
        let current = active
        active = nil
        dropInFlight = false
        stopEventTap()
        DispatchQueue.main.async { [weak self] in
            self?.previewWindow?.closePreview()
            self?.previewWindow = nil
        }
        if let connection = current?.connection {
            connection.send(DragResult(outcome: outcome, target: target, message: message))
        }
    }

    private func containsFlipped(_ frame: CGRect, _ point: CGPoint) -> Bool {
        // AX coordinates have origin top-left; CGEvent location is also top-left.
        return frame.contains(point)
    }

    private func currentCursorPosition() -> CGPoint {
        if let event = CGEvent(source: nil) {
            return event.location
        }
        return NSEvent.mouseLocation
    }

    private func windowFrameUnderPoint(_ point: CGPoint) -> CGRect? {
        let systemElement = AXUIElementCreateSystemWide()
        var raw: AXUIElement?
        let result = AXUIElementCopyElementAtPosition(systemElement, Float(point.x), Float(point.y), &raw)
        guard result == .success, let element = raw else { return nil }
        return windowFrame(for: element)
    }

    private func windowFrame(for element: AXUIElement) -> CGRect? {
        var current: AXUIElement = element
        for _ in 0..<10 {
            var roleValue: CFTypeRef?
            AXUIElementCopyAttributeValue(current, kAXRoleAttribute as CFString, &roleValue)
            if let role = roleValue as? String, role == kAXWindowRole as String {
                return elementFrame(current)
            }
            var parent: CFTypeRef?
            if AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parent) != .success {
                return nil
            }
            guard let next = parent, CFGetTypeID(next) == AXUIElementGetTypeID() else {
                return nil
            }
            current = next as! AXUIElement
        }
        return nil
    }

    private func elementFrame(_ element: AXUIElement) -> CGRect? {
        var pos: CFTypeRef?
        var size: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &pos)
        AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &size)
        guard let pv = pos, CFGetTypeID(pv) == AXValueGetTypeID(),
              let sv = size, CFGetTypeID(sv) == AXValueGetTypeID() else {
            return nil
        }
        var origin = CGPoint.zero
        var sz = CGSize.zero
        AXValueGetValue(pv as! AXValue, .cgPoint, &origin)
        AXValueGetValue(sv as! AXValue, .cgSize, &sz)
        return CGRect(origin: origin, size: sz)
    }
}
