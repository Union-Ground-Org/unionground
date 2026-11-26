import Darwin
import ExpoModulesCore
import Foundation

public class SecureShareIntakeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SecureShareIntake")

    AsyncFunction("getPendingAsync") {
      try SecureShareStorage.getPending()
    }

    AsyncFunction("captureCleanupTokensAsync") {
      try SecureShareStorage.captureCleanupTokens()
    }

    AsyncFunction("discardAsync") { (token: String) in
      try SecureShareStorage.discard(token: token)
    }
  }
}

private struct ShareManifest: Codable {
  let version: Int
  let token: String
  let filename: String
  let mimeType: String
  let sizeBytes: Int64
  let createdAtMs: Int64
}

private enum SecureShareStorage {
  private static let rootName = "SecureShareIntake"
  private static let lockName = ".SecureShareIntake.lock"
  private static let manifestName = "manifest.json"
  private static let payloadName = "payload"
  private static let maximumBytes: Int64 = 10 * 1024 * 1024
  private static let maximumAgeMs: Int64 = 5 * 60 * 1000
  private static let futureSkewMs: Int64 = 30 * 1000
  private static let allowedMimeExtensions: [String: Set<String>] = [
    "application/pdf": ["pdf"],
    "image/jpeg": ["jpg", "jpeg"],
    "image/png": ["png"],
    "image/webp": ["webp"],
    "text/plain": ["txt"],
    "text/csv": ["csv"],
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  ]

  static func captureCleanupTokens() throws -> [String] {
    try withStagingLock { root in
      let manager = FileManager.default
      guard manager.fileExists(atPath: root.path) else { return [] }
      let entries = try manager.contentsOfDirectory(
        at: root,
        includingPropertiesForKeys: [.isDirectoryKey],
        options: [.skipsHiddenFiles]
      )
      return try entries.map { entry in
        let values = try entry.resourceValues(forKeys: [.isDirectoryKey])
        let name = entry.lastPathComponent
        guard values.isDirectory == true,
          isDirectChild(entry, of: root),
          let parsed = UUID(uuidString: name),
          parsed.uuidString.lowercased() == name
        else { throw CocoaError(.fileReadCorruptFile) }
        return name
      }.sorted()
    }
  }

  static func getPending() throws -> [String: Any]? {
    try withStagingLock { root in
      let manager = FileManager.default
      guard manager.fileExists(atPath: root.path) else { return nil }
      let entries = try manager.contentsOfDirectory(
        at: root,
        includingPropertiesForKeys: [.isDirectoryKey],
        options: [.skipsHiddenFiles]
      )
      let now = Int64(Date().timeIntervalSince1970 * 1000)
      var selected: (ShareManifest, URL)?
      for entry in entries {
        guard let pending = try? validatedEntry(root: root, entry: entry, now: now) else {
          try removeAndVerify(entry, manager: manager)
          continue
        }
        if selected == nil || pending.0.createdAtMs > selected!.0.createdAtMs {
          if let previous = selected {
            try removeAndVerify(previous.1.deletingLastPathComponent(), manager: manager)
          }
          selected = pending
        } else {
          try removeAndVerify(entry, manager: manager)
        }
      }
      guard let selected else { return nil }
      return [
        "token": selected.0.token,
        "uri": selected.1.absoluteString,
        "filename": selected.0.filename,
        "mimeType": selected.0.mimeType,
        "sizeBytes": Double(selected.0.sizeBytes),
        "createdAtMs": Double(selected.0.createdAtMs),
      ]
    }
  }

  static func discard(token: String) throws -> Bool {
    guard let parsed = UUID(uuidString: token), parsed.uuidString.lowercased() == token.lowercased() else { return false }
    return try withStagingLock { root in
      let entry = root.appendingPathComponent(parsed.uuidString.lowercased(), isDirectory: true)
      guard isDirectChild(entry, of: root) else { return false }
      try removeAndVerify(entry)
      return true
    }
  }

  private static func removeAndVerify(_ url: URL, manager: FileManager = .default) throws {
    if manager.fileExists(atPath: url.path) {
      try manager.removeItem(at: url)
    }
    guard !manager.fileExists(atPath: url.path) else { throw CocoaError(.fileWriteUnknown) }
  }

  private static func validatedEntry(root: URL, entry: URL, now: Int64) throws -> (ShareManifest, URL) {
    guard isDirectChild(entry, of: root) else { throw CocoaError(.fileReadNoPermission) }
    let manifestURL = entry.appendingPathComponent(manifestName, isDirectory: false)
    let payloadURL = entry.appendingPathComponent(payloadName, isDirectory: false)
    let manifest = try JSONDecoder().decode(ShareManifest.self, from: Data(contentsOf: manifestURL))
    guard manifest.version == 1,
      let parsed = UUID(uuidString: manifest.token),
      parsed.uuidString.lowercased() == entry.lastPathComponent.lowercased(),
      manifest.token.lowercased() == entry.lastPathComponent.lowercased(),
      manifest.createdAtMs <= now + futureSkewMs,
      now - manifest.createdAtMs <= maximumAgeMs,
      manifest.sizeBytes >= 1,
      manifest.sizeBytes <= maximumBytes,
      validFilename(manifest.filename, mimeType: manifest.mimeType),
      isDirectChild(payloadURL, of: entry)
    else { throw CocoaError(.fileReadCorruptFile) }

    let attributes = try FileManager.default.attributesOfItem(atPath: payloadURL.path)
    guard attributes[.type] as? FileAttributeType == .typeRegular,
      (attributes[.size] as? NSNumber)?.int64Value == manifest.sizeBytes
    else { throw CocoaError(.fileReadCorruptFile) }
    return (manifest, payloadURL)
  }

  private static func validFilename(_ filename: String, mimeType: String) -> Bool {
    guard let extensions = allowedMimeExtensions[mimeType],
      !filename.isEmpty,
      filename.count <= 160,
      !filename.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
      !filename.contains("/"),
      !filename.contains("\\")
    else { return false }
    return extensions.contains((filename as NSString).pathExtension.lowercased())
  }

  private static func containerURL() throws -> URL {
    guard let appGroup = Bundle.main.object(forInfoDictionaryKey: "ExpoShareIntoAppGroupId") as? String,
      !appGroup.isEmpty,
      let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    else { throw CocoaError(.fileNoSuchFile) }
    return container
  }

  private static func withStagingLock<T>(_ operation: (URL) throws -> T) throws -> T {
    let container = try containerURL()
    let lockURL = container.appendingPathComponent(lockName, isDirectory: false)
    let descriptor = lockURL.path.withCString {
      Darwin.open($0, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, mode_t(S_IRUSR | S_IWUSR))
    }
    guard descriptor >= 0 else { throw CocoaError(.fileWriteNoPermission) }
    defer { _ = Darwin.close(descriptor) }
    guard Darwin.lockf(descriptor, F_LOCK, 0) == 0 else { throw CocoaError(.fileWriteUnknown) }
    defer { _ = Darwin.lockf(descriptor, F_ULOCK, 0) }
    guard Darwin.fchmod(descriptor, mode_t(S_IRUSR | S_IWUSR)) == 0 else {
      throw CocoaError(.fileWriteNoPermission)
    }
    try FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.complete],
      ofItemAtPath: lockURL.path
    )
    try excludeFromBackup(lockURL)
    return try operation(container.appendingPathComponent(rootName, isDirectory: true))
  }

  private static func excludeFromBackup(_ url: URL) throws {
    var mutable = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try mutable.setResourceValues(values)
  }

  private static func isDirectChild(_ child: URL, of parent: URL) -> Bool {
    child.resolvingSymlinksInPath().deletingLastPathComponent().standardizedFileURL
      == parent.resolvingSymlinksInPath().standardizedFileURL
  }
}
