// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "hux-drag-daemon",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "hux-drag-daemon", targets: ["HuxDragDaemon"])
    ],
    targets: [
        .executableTarget(
            name: "HuxDragDaemon",
            path: "Sources/HuxDragDaemon",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("Carbon"),
            ]
        )
    ]
)
