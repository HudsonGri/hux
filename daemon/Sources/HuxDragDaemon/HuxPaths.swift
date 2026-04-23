import Foundation

enum HuxPaths {
    static func dragSocket() -> String {
        if let override = ProcessInfo.processInfo.environment["HUX_DRAG_SOCKET"] {
            return override
        }
        let state: String
        if let xdg = ProcessInfo.processInfo.environment["XDG_STATE_HOME"], !xdg.isEmpty {
            state = xdg
        } else {
            state = (NSHomeDirectory() as NSString).appendingPathComponent(".local/state")
        }
        let dir = (state as NSString).appendingPathComponent("hux")
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try? FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: dir
        )
        return (dir as NSString).appendingPathComponent("drag.sock")
    }

    static func lockPath() -> String {
        return dragSocket() + ".lock"
    }
}
