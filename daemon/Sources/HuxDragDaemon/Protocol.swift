import Foundation

struct PreviewCell: Codable {
    let ch: String
    let fg: Int?
    let bg: Int?
    let bold: Bool?
}

enum ClientOp: String, Codable {
    case dragStart = "drag_start"
    case dragCancel = "drag_cancel"
    case ping = "ping"
}

struct DragStartMessage: Codable {
    let op: ClientOp
    let paneId: String
    let title: String?
    let accent: Int?
    let preview: [[PreviewCell]]?
    let sourcePid: Int?
    let huxBinary: String?
    let command: String?

    enum CodingKeys: String, CodingKey {
        case op
        case paneId = "pane_id"
        case title
        case accent
        case preview
        case sourcePid = "source_pid"
        case huxBinary = "hux_binary"
        case command
    }
}

struct SimpleMessage: Codable {
    let op: ClientOp
}

enum DaemonOp: String, Codable {
    case dragResult = "drag_result"
    case permissionDenied = "permission_denied"
    case pong = "pong"
    case hello = "hello"
}

enum DragOutcome: String, Codable {
    case dropped
    case cancelled
    case error
}

enum DropTargetKind: String, Codable {
    case newTab = "new_tab"
    case inputText = "input_text"
    case newWindow = "new_window"
}

struct DragResult: Codable {
    let op: DaemonOp
    let outcome: DragOutcome
    let target: DropTargetKind?
    let message: String?

    init(outcome: DragOutcome, target: DropTargetKind? = nil, message: String? = nil) {
        self.op = .dragResult
        self.outcome = outcome
        self.target = target
        self.message = message
    }
}

struct PermissionDenied: Codable {
    let op: DaemonOp
    let what: String

    init(what: String) {
        self.op = .permissionDenied
        self.what = what
    }
}

struct Hello: Codable {
    let op: DaemonOp
    let version: String

    init(version: String = "0.1") {
        self.op = .hello
        self.version = version
    }
}

struct Pong: Codable {
    let op: DaemonOp

    init() { self.op = .pong }
}

enum ProtocolCodec {
    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = []
        return e
    }()

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        return d
    }()

    static func encode<T: Encodable>(_ value: T) throws -> Data {
        var data = try encoder.encode(value)
        data.append(0x0A) // newline delimiter
        return data
    }

    static func peekOp(_ data: Data) -> String? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return obj["op"] as? String
    }
}
