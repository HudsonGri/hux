import Foundation

final class SocketServer {
    static var shared: SocketServer?

    private let path: String
    private let controller: DragController
    private var listenFd: Int32 = -1
    private var listenSource: DispatchSourceRead?
    private var clients: [Int32: ClientConnection] = [:]
    private let queue = DispatchQueue(label: "hux-drag-daemon.socket")

    init(path: String, controller: DragController) {
        self.path = path
        self.controller = controller
        SocketServer.shared = self
    }

    func start() throws {
        try acquireLock()
        unlink(path)

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw POSIXError(.EACCES)
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = path.utf8CString
        guard pathBytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else {
            close(fd)
            throw NSError(domain: "hux-drag-daemon", code: 1, userInfo: [NSLocalizedDescriptionKey: "socket path too long"])
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { buf in
            pathBytes.withUnsafeBytes { src in
                buf.copyMemory(from: src)
            }
        }
        let addrLen = socklen_t(MemoryLayout<sockaddr_un>.stride)
        let bindResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.bind(fd, sa, addrLen)
            }
        }
        guard bindResult == 0 else {
            let err = errno
            close(fd)
            throw NSError(domain: "hux-drag-daemon", code: Int(err), userInfo: [NSLocalizedDescriptionKey: "bind failed: \(String(cString: strerror(err)))"])
        }
        chmod(path, 0o600)
        guard listen(fd, 16) == 0 else {
            let err = errno
            close(fd)
            throw NSError(domain: "hux-drag-daemon", code: Int(err), userInfo: [NSLocalizedDescriptionKey: "listen failed"])
        }
        let flags = fcntl(fd, F_GETFL, 0)
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)

        listenFd = fd
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in
            self?.acceptConnections()
        }
        source.resume()
        listenSource = source
    }

    func shutdown() {
        listenSource?.cancel()
        listenSource = nil
        if listenFd >= 0 {
            close(listenFd)
            listenFd = -1
        }
        unlink(path)
        for (_, client) in clients {
            client.close()
        }
        clients.removeAll()
    }

    private func acceptConnections() {
        while true {
            let client = accept(listenFd, nil, nil)
            if client < 0 {
                return
            }
            let flags = fcntl(client, F_GETFL, 0)
            _ = fcntl(client, F_SETFL, flags | O_NONBLOCK)
            let conn = ClientConnection(fd: client, queue: queue, controller: controller) { [weak self] fd in
                self?.removeClient(fd: fd)
            }
            clients[client] = conn
            Log.info("client connected fd=\(client)")
            conn.start()
        }
    }

    private func removeClient(fd: Int32) {
        clients.removeValue(forKey: fd)
    }

    private func acquireLock() throws {
        let lockPath = HuxPaths.lockPath()
        let fd = open(lockPath, O_CREAT | O_RDWR, 0o600)
        guard fd >= 0 else {
            throw NSError(domain: "hux-drag-daemon", code: 2, userInfo: [NSLocalizedDescriptionKey: "cannot open lock file"])
        }
        if flock(fd, LOCK_EX | LOCK_NB) != 0 {
            close(fd)
            throw NSError(domain: "hux-drag-daemon", code: 3, userInfo: [NSLocalizedDescriptionKey: "another instance is running"])
        }
        // Keep the fd alive for the process lifetime by leaking it deliberately.
        _ = fd
    }
}

final class ClientConnection {
    // Cap inbound framing so a stuck client can't grow the buffer without bound
    // (a well-formed drag_start with a full preview grid is << 256 KB).
    private static let maxFrameBytes = 1 << 20  // 1 MiB

    private let fd: Int32
    private let queue: DispatchQueue
    private let controller: DragController
    private let onClose: (Int32) -> Void
    private var source: DispatchSourceRead?
    private var buffer = Data()
    private var closed = false

    init(
        fd: Int32,
        queue: DispatchQueue,
        controller: DragController,
        onClose: @escaping (Int32) -> Void
    ) {
        self.fd = fd
        self.queue = queue
        self.controller = controller
        self.onClose = onClose
    }

    func start() {
        send(Hello())
        let s = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        s.setEventHandler { [weak self] in
            self?.readAvailable()
        }
        s.setCancelHandler { [weak self] in
            self?.finish()
        }
        source = s
        s.resume()
    }

    func close() {
        source?.cancel()
    }

    func send<T: Encodable>(_ message: T) {
        guard !closed else { return }
        do {
            let data = try ProtocolCodec.encode(message)
            var writeFailed = false
            data.withUnsafeBytes { buf in
                var total = 0
                while total < buf.count {
                    let ptr = buf.baseAddress!.advanced(by: total)
                    let n = write(fd, ptr, buf.count - total)
                    if n <= 0 {
                        if errno == EAGAIN || errno == EINTR { continue }
                        // The peer is gone (EPIPE/ECONNRESET/…). Trigger the
                        // cancel handler so the fd is closed and the connection
                        // is removed, instead of silently leaking the fd.
                        writeFailed = true
                        return
                    }
                    total += n
                }
            }
            if writeFailed {
                source?.cancel()
            }
        } catch {
            // drop
        }
    }

    private func readAvailable() {
        var chunk = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = chunk.withUnsafeMutableBytes { buf -> Int in
                read(fd, buf.baseAddress, buf.count)
            }
            if n > 0 {
                buffer.append(contentsOf: chunk[0..<n])
                if buffer.count > ClientConnection.maxFrameBytes {
                    Log.error("client fd=\(fd) exceeded max frame size; closing")
                    source?.cancel()
                    return
                }
                processBuffer()
            } else if n == 0 {
                source?.cancel()
                return
            } else {
                if errno == EAGAIN { return }
                if errno == EINTR { continue }
                source?.cancel()
                return
            }
        }
    }

    private func processBuffer() {
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            handleLine(line)
        }
    }

    private func handleLine(_ data: Data) {
        guard let op = ProtocolCodec.peekOp(data) else { return }
        Log.debug("recv op=\(op) bytes=\(data.count)")
        switch op {
        case ClientOp.ping.rawValue:
            send(Pong())
        case ClientOp.dragStart.rawValue:
            do {
                let msg = try ProtocolCodec.decoder.decode(DragStartMessage.self, from: data)
                controller.beginDrag(message: msg, connection: self)
            } catch {
                send(DragResult(outcome: .error, message: "invalid drag_start: \(error)"))
            }
        case ClientOp.dragCancel.rawValue:
            controller.cancelDrag(connection: self)
        default:
            break
        }
    }

    private func finish() {
        if closed { return }
        closed = true
        controller.connectionClosed(self)
        Darwin.close(fd)
        onClose(fd)
    }
}
