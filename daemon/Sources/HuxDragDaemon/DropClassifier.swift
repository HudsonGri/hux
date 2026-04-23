import Foundation
import AppKit
import ApplicationServices

enum DropClassification {
    case ghosttyContent(windowId: Int?)
    case ghosttyTabBar(windowId: Int?)
    case ghosttyWindow(windowId: Int?)
    case outside
}

enum DropClassifier {
    static let ghosttyBundleIds: Set<String> = [
        "com.mitchellh.ghostty",
        "dev.ghostty.Ghostty",
    ]

    static func classify(at point: CGPoint) -> DropClassification {
        let system = AXUIElementCreateSystemWide()
        var rawElement: AXUIElement?
        let status = AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &rawElement)
        guard status == .success, let element = rawElement else {
            return .outside
        }

        guard let pid = pid(for: element) else {
            return .outside
        }
        guard let bundle = bundleId(forPid: pid), ghosttyBundleIds.contains(bundle) else {
            return .outside
        }

        let role = attributeString(element, kAXRoleAttribute as CFString) ?? ""
        let window = nearestWindow(from: element)
        let windowId = window.map(axWindowNumber)

        switch role {
        case kAXTextAreaRole, kAXScrollAreaRole:
            return .ghosttyContent(windowId: windowId ?? nil)
        case kAXToolbarRole, kAXTabGroupRole, kAXRadioButtonRole, kAXRadioGroupRole, kAXButtonRole:
            return .ghosttyTabBar(windowId: windowId ?? nil)
        default:
            if let frame = window.flatMap(elementFrame),
               point.y - frame.origin.y < 36 {
                return .ghosttyTabBar(windowId: windowId ?? nil)
            }
            return .ghosttyWindow(windowId: windowId ?? nil)
        }
    }

    private static func attributeString(_ element: AXUIElement, _ attr: CFString) -> String? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attr, &raw) == .success else {
            return nil
        }
        return raw as? String
    }

    private static func pid(for element: AXUIElement) -> pid_t? {
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success else { return nil }
        return pid
    }

    private static func bundleId(forPid pid: pid_t) -> String? {
        if let app = NSRunningApplication(processIdentifier: pid) {
            return app.bundleIdentifier
        }
        return nil
    }

    private static func nearestWindow(from element: AXUIElement) -> AXUIElement? {
        var current: AXUIElement = element
        for _ in 0..<10 {
            if attributeString(current, kAXRoleAttribute as CFString) == kAXWindowRole as String {
                return current
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

    private static func elementFrame(_ element: AXUIElement) -> CGRect? {
        var posRef: CFTypeRef?
        var sizeRef: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRef)
        AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef)
        guard let pv = posRef, CFGetTypeID(pv) == AXValueGetTypeID(),
              let sv = sizeRef, CFGetTypeID(sv) == AXValueGetTypeID() else {
            return nil
        }
        var origin = CGPoint.zero
        var size = CGSize.zero
        AXValueGetValue(pv as! AXValue, .cgPoint, &origin)
        AXValueGetValue(sv as! AXValue, .cgSize, &size)
        return CGRect(origin: origin, size: size)
    }

    private static func axWindowNumber(_ element: AXUIElement) -> Int? {
        // AX doesn't expose a stable window id; Ghostty's AppleScript uses `front window`
        // which is fine for now.
        return nil
    }
}
