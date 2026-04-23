import AppKit

@MainActor
final class DragPreviewWindow {
    private let window: NSWindow
    private let contentView: NSView
    private let titleLabel: NSTextField
    private let previewCells: [[PreviewCell]]
    private var isShown = false

    init(title: String, accent: Int, preview: [[PreviewCell]]) {
        self.previewCells = preview
        let size = NSSize(width: 220, height: 96)
        let rect = NSRect(origin: .zero, size: size)
        let styleMask: NSWindow.StyleMask = [.borderless, .nonactivatingPanel]
        let win = NSPanel(
            contentRect: rect,
            styleMask: styleMask,
            backing: .buffered,
            defer: false
        )
        win.isFloatingPanel = true
        win.level = .statusBar
        win.ignoresMouseEvents = true
        win.isOpaque = false
        win.backgroundColor = .clear
        win.hasShadow = true
        win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]

        let content = NSView(frame: rect)
        content.wantsLayer = true
        if let layer = content.layer {
            layer.cornerRadius = 8
            layer.borderWidth = 1
            layer.borderColor = accentCGColor(accent).copy(alpha: 0.85)
            layer.backgroundColor = NSColor(calibratedWhite: 0.08, alpha: 0.92).cgColor
        }
        win.contentView = content
        self.contentView = content

        let label = NSTextField(labelWithString: title)
        label.textColor = NSColor(cgColor: accentCGColor(accent)) ?? .white
        label.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .semibold)
        label.backgroundColor = .clear
        label.isBordered = false
        label.frame = NSRect(x: 10, y: size.height - 22, width: size.width - 20, height: 16)
        content.addSubview(label)
        self.titleLabel = label

        let previewText = Self.buildPreviewText(preview)
        let body = NSTextField(wrappingLabelWithString: previewText)
        body.textColor = NSColor(calibratedWhite: 0.85, alpha: 1.0)
        body.font = NSFont.monospacedSystemFont(ofSize: 9, weight: .regular)
        body.backgroundColor = .clear
        body.isBordered = false
        body.drawsBackground = false
        body.isSelectable = false
        body.frame = NSRect(x: 10, y: 8, width: size.width - 20, height: size.height - 34)
        content.addSubview(body)

        self.window = win
    }

    func showIfNeeded() {
        if isShown { return }
        isShown = true
        window.orderFrontRegardless()
    }

    func hide() {
        if !isShown { return }
        isShown = false
        window.orderOut(nil)
    }

    func move(to screenPoint: CGPoint) {
        let size = window.frame.size
        let flipped = flipFromTopLeft(screenPoint)
        let origin = NSPoint(
            x: flipped.x + 16,
            y: flipped.y - size.height - 16
        )
        window.setFrameOrigin(origin)
    }

    func closePreview() {
        window.orderOut(nil)
    }

    private static func buildPreviewText(_ cells: [[PreviewCell]]) -> String {
        if cells.isEmpty { return "" }
        var lines: [String] = []
        for row in cells.prefix(4) {
            var s = ""
            for cell in row.prefix(30) {
                s += cell.ch.isEmpty ? " " : cell.ch
            }
            lines.append(s)
        }
        return lines.joined(separator: "\n")
    }

    private func flipFromTopLeft(_ point: CGPoint) -> NSPoint {
        let mainHeight = NSScreen.screens.first?.frame.size.height ?? 0
        return NSPoint(x: point.x, y: mainHeight - point.y)
    }
}

private func accentCGColor(_ accent: Int) -> CGColor {
    // Very rough palette-256 → RGB mapping; the top bit of `accent` signals RGB.
    let rgbFlag = 0x0100_0000
    if accent >= rgbFlag {
        let r = CGFloat((accent >> 16) & 0xFF) / 255.0
        let g = CGFloat((accent >> 8) & 0xFF) / 255.0
        let b = CGFloat(accent & 0xFF) / 255.0
        return CGColor(red: r, green: g, blue: b, alpha: 1.0)
    }
    return palette256(accent) ?? CGColor(red: 0.45, green: 0.65, blue: 1.0, alpha: 1.0)
}

private func palette256(_ idx: Int) -> CGColor? {
    guard idx >= 0 && idx < 256 else { return nil }
    if idx < 16 {
        let base: [(CGFloat, CGFloat, CGFloat)] = [
            (0, 0, 0), (0.8, 0, 0), (0, 0.8, 0), (0.8, 0.8, 0),
            (0, 0, 0.8), (0.8, 0, 0.8), (0, 0.8, 0.8), (0.7, 0.7, 0.7),
            (0.3, 0.3, 0.3), (1, 0, 0), (0, 1, 0), (1, 1, 0),
            (0.3, 0.3, 1.0), (1, 0, 1), (0, 1, 1), (1, 1, 1),
        ]
        let (r, g, b) = base[idx]
        return CGColor(red: r, green: g, blue: b, alpha: 1.0)
    }
    if idx >= 232 {
        let level = CGFloat(8 + (idx - 232) * 10) / 255.0
        return CGColor(red: level, green: level, blue: level, alpha: 1.0)
    }
    let n = idx - 16
    let r = n / 36
    let g = (n / 6) % 6
    let b = n % 6
    func lvl(_ v: Int) -> CGFloat { v == 0 ? 0 : CGFloat(55 + v * 40) / 255.0 }
    return CGColor(red: lvl(r), green: lvl(g), blue: lvl(b), alpha: 1.0)
}
