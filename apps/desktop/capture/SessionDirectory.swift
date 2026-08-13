import Darwin
import Foundation

final class SessionDirectory {
    let root: URL
    private let fileManager = FileManager.default

    init(path: String) throws {
        guard path.hasPrefix("/"), !path.contains("\0") else {
            throw HelperFailure(code: "invalid-session-directory", message: "Session directory must be absolute.", recoverable: true)
        }
        let requested = URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
        try fileManager.createDirectory(
            at: requested,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let resolved = requested.resolvingSymlinksInPath().standardizedFileURL
        guard requested.path == resolved.path else {
            throw HelperFailure(code: "unsafe-session-path", message: "Session directory may not traverse symlinks.", recoverable: false)
        }
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: resolved.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw HelperFailure(code: "invalid-session-directory", message: "Session path is not a directory.", recoverable: true)
        }
        try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: resolved.path)
        root = resolved
        try prepareDirectory("segments")
        try prepareDirectory("events")
    }

    func prepareDirectory(_ relativePath: String) throws {
        let url = try outputURL(relativePath, requireAbsent: false)
        try fileManager.createDirectory(
            at: url,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700]
        )
        try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true else {
            throw HelperFailure(code: "unsafe-session-path", message: "Session output directory is not a plain directory.", recoverable: false)
        }
        let attributes = try fileManager.attributesOfItem(atPath: url.path)
        guard (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700 else {
            throw HelperFailure(code: "unsafe-session-mode", message: "Session output directory is not private.", recoverable: false)
        }
    }

    func outputURL(_ relativePath: String, requireAbsent: Bool = true) throws -> URL {
        let parts = relativePath.split(separator: "/", omittingEmptySubsequences: false)
        guard !relativePath.isEmpty,
              !relativePath.hasPrefix("/"),
              !relativePath.contains("\\"),
              !relativePath.contains("\0"),
              parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            throw HelperFailure(code: "unsafe-output-path", message: "Capture output path is not session-relative.", recoverable: false)
        }
        let candidate = root.appendingPathComponent(relativePath, isDirectory: false).standardizedFileURL
        let rootPrefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
        guard candidate.path.hasPrefix(rootPrefix) else {
            throw HelperFailure(code: "unsafe-output-path", message: "Capture output escaped the session directory.", recoverable: false)
        }

        var current = root
        for part in parts.dropLast() {
            current.appendPathComponent(String(part), isDirectory: true)
            if fileManager.fileExists(atPath: current.path) {
                let values = try current.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                guard values.isDirectory == true, values.isSymbolicLink != true else {
                    throw HelperFailure(code: "unsafe-output-path", message: "Capture output parent contains a symlink or non-directory.", recoverable: false)
                }
            }
        }
        if requireAbsent && fileManager.fileExists(atPath: candidate.path) {
            throw HelperFailure(code: "output-already-exists", message: "Capture refuses to overwrite an existing output file.", recoverable: true)
        }
        return candidate
    }

    func createExclusiveFile(_ relativePath: String) throws -> FileHandle {
        let url = try outputURL(relativePath)
        let descriptor = Darwin.open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else {
            throw HelperFailure(code: "output-create-failed", message: "Could not create a capture metadata file (errno \(errno)).", recoverable: true)
        }
        guard Darwin.fchmod(descriptor, S_IRUSR | S_IWUSR) == 0 else {
            Darwin.close(descriptor)
            try? fileManager.removeItem(at: url)
            throw HelperFailure(code: "output-mode-failed", message: "Could not make a capture metadata file private.", recoverable: false)
        }
        return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    }
}

func secureFinalizedCaptureFile(_ url: URL) throws {
    let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else {
        throw HelperFailure(code: "output-open-failed", message: "Finalized capture output could not be opened safely.", recoverable: false)
    }
    defer { Darwin.close(descriptor) }
    var details = stat()
    guard Darwin.fstat(descriptor, &details) == 0, details.st_mode & S_IFMT == S_IFREG else {
        throw HelperFailure(code: "unsafe-output-file", message: "Finalized capture output is not a regular file.", recoverable: false)
    }
    guard Darwin.fchmod(descriptor, S_IRUSR | S_IWUSR) == 0 else {
        throw HelperFailure(code: "output-mode-failed", message: "Finalized capture output could not be made private.", recoverable: false)
    }
    var secured = stat()
    guard Darwin.fstat(descriptor, &secured) == 0, secured.st_mode & 0o777 == 0o600 else {
        throw HelperFailure(code: "unsafe-output-mode", message: "Finalized capture output is not private.", recoverable: false)
    }
}
