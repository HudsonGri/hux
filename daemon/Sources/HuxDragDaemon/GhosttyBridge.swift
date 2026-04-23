import Foundation
import AppKit

enum GhosttyBridgeError: Error, CustomStringConvertible {
    case timeout
    case applescript(String)

    var description: String {
        switch self {
        case .timeout: return "AppleScript timed out"
        case .applescript(let s): return s
        }
    }
}

actor GhosttyBridge {
    func execute(
        for classification: DropClassification,
        paneId: String,
        huxBinary: String,
        command: String?
    ) async throws -> DropTargetKind {
        // Ghostty wraps whatever we pass in `bash --noprofile --norc -c
        // 'exec -l <command>'`. Give Ghostty a full `/bin/sh -c <inner>` so
        // the inner shell handles PATH. `huxBinary` is an absolute path with
        // no metacharacters, so we can embed it unquoted in the inner shell.
        // If the client supplied an explicit `command` (e.g. tab-view drops),
        // exec that verbatim instead of the single-pane fallback.
        let inner: String
        if let custom = command, !custom.isEmpty {
            inner = "exec \(custom)"
        } else {
            inner = "exec \(shellQuote(huxBinary)) pane-view \(shellQuote(paneId))"
        }
        let cmdString = "/bin/sh -c \(shellQuote(inner))"
        switch classification {
        case .ghosttyContent:
            let typed = cmdString + "\n"
            try await run(
                script: """
                tell application "Ghostty"
                    activate
                    set w to front window
                    set t to selected tab of w
                    set term to focused terminal of t
                    input text \(encode(typed)) to term
                end tell
                """,
                timeout: 2.0
            )
            return .inputText

        case .ghosttyTabBar, .ghosttyWindow:
            try await run(
                script: """
                tell application "Ghostty"
                    activate
                    set w to front window
                    make new tab in w with configuration {command: \(encode(cmdString))}
                end tell
                """,
                timeout: 2.0
            )
            return .newTab

        case .outside:
            try await run(
                script: """
                tell application "Ghostty"
                    activate
                    make new window with configuration {command: \(encode(cmdString))}
                end tell
                """,
                timeout: 2.0
            )
            return .newWindow
        }
    }

    private func shellQuote(_ path: String) -> String {
        let escaped = path.replacingOccurrences(of: "'", with: "'\\''")
        return "'\(escaped)'"
    }

    private func encode(_ s: String) -> String {
        let escaped = s
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
        return "\"\(escaped)\""
    }

    private func run(script: String, timeout: TimeInterval) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                try await self.executeScript(script)
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                throw GhosttyBridgeError.timeout
            }
            try await group.next()
            group.cancelAll()
        }
    }

    private func executeScript(_ script: String) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            DispatchQueue.global(qos: .userInitiated).async {
                Log.debug("applescript:\n\(script)")
                guard let apple = NSAppleScript(source: script) else {
                    cont.resume(throwing: GhosttyBridgeError.applescript("could not construct script"))
                    return
                }
                var err: NSDictionary?
                let result = apple.executeAndReturnError(&err)
                if let err = err {
                    let msg = (err[NSAppleScript.errorMessage] as? String)
                        ?? (err[NSAppleScript.errorBriefMessage] as? String)
                        ?? "\(err)"
                    let num = err[NSAppleScript.errorNumber] as? Int ?? 0
                    // Ghostty sometimes returns -2710 "can't make class X" after
                    // it successfully creates the tab — treat that as success.
                    if num == -2710 {
                        Log.debug("applescript: swallowed -2710 \(msg)")
                        cont.resume(returning: ())
                        return
                    }
                    Log.error("applescript error [\(num)] \(msg)")
                    cont.resume(throwing: GhosttyBridgeError.applescript("[\(num)] \(msg)"))
                    return
                }
                Log.debug("applescript: ok \(result.stringValue ?? "")")
                cont.resume(returning: ())
            }
        }
    }
}
