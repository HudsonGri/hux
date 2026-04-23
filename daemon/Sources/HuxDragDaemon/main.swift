import Foundation
import AppKit
import ApplicationServices

// Agent / LSUIElement style — no dock icon, no menu bar.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// Trigger the Accessibility prompt at startup so the user grants permission
// before their first drag — otherwise the first-ever drag races the system
// permission dialog and silently fails.
let promptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
let trusted = AXIsProcessTrustedWithOptions([promptKey: true] as CFDictionary)
FileHandle.standardError.write(
    "hux-drag-daemon: accessibility trusted=\(trusted)\n".data(using: .utf8)!
)

let controller = DragController()

let socketPath = HuxPaths.dragSocket()
let server = SocketServer(path: socketPath, controller: controller)

do {
    try server.start()
    FileHandle.standardError.write("hux-drag-daemon: listening on \(socketPath)\n".data(using: .utf8)!)
} catch {
    FileHandle.standardError.write("hux-drag-daemon: failed to start: \(error)\n".data(using: .utf8)!)
    exit(1)
}

signal(SIGTERM) { _ in
    SocketServer.shared?.shutdown()
    exit(0)
}
signal(SIGINT) { _ in
    SocketServer.shared?.shutdown()
    exit(0)
}

app.run()
