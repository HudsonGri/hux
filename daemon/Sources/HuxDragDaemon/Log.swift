import Foundation

enum Log {
    static let enabled: Bool = ProcessInfo.processInfo.environment["HUX_DRAG_DAEMON_DEBUG"] != nil

    static func debug(_ message: @autoclosure () -> String) {
        guard enabled else { return }
        write("debug", message())
    }

    static func info(_ message: @autoclosure () -> String) {
        write("info", message())
    }

    static func error(_ message: @autoclosure () -> String) {
        write("error", message())
    }

    private static func write(_ level: String, _ message: String) {
        let line = "[\(level)] \(message)\n"
        if let data = line.data(using: .utf8) {
            FileHandle.standardError.write(data)
        }
    }
}
