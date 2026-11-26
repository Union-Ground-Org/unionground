import Darwin
import UIKit

final class ShareIntoViewController: UIViewController {
  private struct AllowedType {
    let identifier: String
    let mime: String
    let extensions: Set<String>
    let fallback: String
  }

  private struct StageOutcome {
    let token: String
    let ready: Bool
    let cleanupTokens: Set<String>

    var cleanupConfirmed: Bool { cleanupTokens.isEmpty }
  }

  private let maximumBytes: Int64 = 10 * 1024 * 1024
  private let rootName = "SecureShareIntake"
  private let lockName = ".SecureShareIntake.lock"
  private let manifestName = "manifest.json"
  private let payloadName = "payload"
  private var started = false
  private var cancelled = false
  private var handoffCommitted = false
  private var readyForHandoff = false
  private var stagedTokens = Set<String>()
  private let statusLabel = UILabel()
  private let spinner = UIActivityIndicatorView(style: .medium)
  private let doneButton = UIButton(type: .system)

  // Keep this order and identifier set synchronized with the activation rule.
  private let allowedTypes: [AllowedType] = [
    AllowedType(identifier: "com.adobe.pdf", mime: "application/pdf", extensions: ["pdf"], fallback: "shared-document.pdf"),
    AllowedType(identifier: "public.jpeg", mime: "image/jpeg", extensions: ["jpg", "jpeg"], fallback: "shared-document.jpg"),
    AllowedType(identifier: "public.png", mime: "image/png", extensions: ["png"], fallback: "shared-document.png"),
    AllowedType(identifier: "org.webmproject.webp", mime: "image/webp", extensions: ["webp"], fallback: "shared-document.webp"),
    AllowedType(identifier: "public.plain-text", mime: "text/plain", extensions: ["txt"], fallback: "shared-document.txt"),
    AllowedType(identifier: "public.comma-separated-values-text", mime: "text/csv", extensions: ["csv"], fallback: "shared-document.csv"),
    AllowedType(identifier: "org.openxmlformats.wordprocessingml.document", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extensions: ["docx"], fallback: "shared-document.docx"),
    AllowedType(identifier: "org.openxmlformats.spreadsheetml.sheet", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extensions: ["xlsx"], fallback: "shared-document.xlsx"),
  ]

  private var appGroupID: String? {
    Bundle.main.object(forInfoDictionaryKey: "AppGroupId") as? String
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = UIColor(red: 244 / 255, green: 242 / 255, blue: 236 / 255, alpha: 1)
    configureView()
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    guard !started else { return }
    started = true
    processShare()
  }

  override func viewWillDisappear(_ animated: Bool) {
    if !handoffCommitted {
      cancelled = true
      _ = discardStagedEntries()
    }
    super.viewWillDisappear(animated)
  }

  deinit {
    if !handoffCommitted {
      _ = discardStagedEntries()
    }
  }

  private func configureView() {
    let titleLabel = UILabel()
    titleLabel.text = "Save to Union Ground"
    titleLabel.font = .preferredFont(forTextStyle: .title2)
    titleLabel.textColor = UIColor(red: 14 / 255, green: 64 / 255, blue: 52 / 255, alpha: 1)
    titleLabel.textAlignment = .center
    titleLabel.adjustsFontForContentSizeCategory = true

    statusLabel.text = "Preparing this item securely…"
    statusLabel.font = .preferredFont(forTextStyle: .body)
    statusLabel.textColor = .secondaryLabel
    statusLabel.textAlignment = .center
    statusLabel.numberOfLines = 0
    statusLabel.adjustsFontForContentSizeCategory = true

    spinner.startAnimating()
    doneButton.setTitle("Done", for: .normal)
    doneButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
    doneButton.isHidden = true
    doneButton.accessibilityHint = "Closes the share sheet"
    doneButton.addTarget(self, action: #selector(closeExtension), for: .touchUpInside)

    let stack = UIStackView(arrangedSubviews: [titleLabel, statusLabel, spinner, doneButton])
    stack.axis = .vertical
    stack.alignment = .fill
    stack.spacing = 18
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 28),
      stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -28),
      stack.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
      doneButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
    ])
  }

  private func processShare() {
    guard let items = extensionContext?.inputItems as? [NSExtensionItem] else {
      showFailure()
      return
    }
    let providers = items.flatMap { $0.attachments ?? [] }
    guard providers.count == 1,
      let provider = providers.first,
      let match = firstAllowedType(for: provider)
    else {
      showFailure()
      return
    }

    provider.loadFileRepresentation(forTypeIdentifier: match.registeredIdentifier) { [weak self] sourceURL, _ in
      guard let self, let sourceURL else {
        DispatchQueue.main.async { self?.showFailure() }
        return
      }
      // NSItemProvider owns this temporary URL and may delete it as soon as
      // the completion handler returns. Copy it into our protected app-group
      // staging area before returning; only the UI result crosses queues.
      let outcome = self.stage(sourceURL: sourceURL, type: match.allowed)
      DispatchQueue.main.async {
        if let outcome {
          self.stagedTokens.formUnion(outcome.cleanupTokens)
          if outcome.ready { self.stagedTokens.insert(outcome.token) }
        }
        if self.cancelled {
          _ = self.discardStagedEntries()
        } else if let outcome, outcome.ready && outcome.cleanupConfirmed {
          self.showReady()
        } else if let outcome, !outcome.cleanupConfirmed {
          self.showCleanupFailure()
        } else {
          self.showFailure()
        }
      }
    }
  }

  private func firstAllowedType(for provider: NSItemProvider) -> (registeredIdentifier: String, allowed: AllowedType)? {
    for registeredIdentifier in provider.registeredTypeIdentifiers {
      if let allowed = allowedTypes.first(where: { $0.identifier == registeredIdentifier }) {
        return (registeredIdentifier, allowed)
      }
    }
    return nil
  }

  private func stage(sourceURL: URL, type: AllowedType) -> StageOutcome? {
    guard let appGroupID,
      let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupID)
    else { return nil }
    let manager = FileManager.default
    let root = container.appendingPathComponent(rootName, isDirectory: true)
    let token = UUID().uuidString.lowercased()
    let entry = root.appendingPathComponent(token, isDirectory: true)
    let payload = entry.appendingPathComponent(payloadName, isDirectory: false)
    let manifest = entry.appendingPathComponent(manifestName, isDirectory: false)
    return try? withStagingLock(in: container) {
      var cleanupTokens = Set<String>()
      do {
        try manager.createDirectory(
          at: root,
          withIntermediateDirectories: true,
          attributes: [.protectionKey: FileProtectionType.complete, .posixPermissions: 0o700]
        )
        try manager.createDirectory(
          at: entry,
          withIntermediateDirectories: false,
          attributes: [.protectionKey: FileProtectionType.complete, .posixPermissions: 0o700]
        )
        guard manager.createFile(
          atPath: payload.path,
          contents: nil,
          attributes: [.protectionKey: FileProtectionType.complete, .posixPermissions: 0o600]
        ) else { throw CocoaError(.fileWriteUnknown) }
        let size = try copyBounded(from: sourceURL, to: payload)
        let filename = safeFilename(sourceURL.lastPathComponent, type: type)
        let record: [String: Any] = [
          "version": 1,
          "token": token,
          "filename": filename,
          "mimeType": type.mime,
          "sizeBytes": size,
          "createdAtMs": Int64(Date().timeIntervalSince1970 * 1000),
        ]
        let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
        try data.write(to: manifest, options: [.atomic, .completeFileProtection])
        try excludeFromBackup(root)
        try excludeFromBackup(entry)
        try excludeFromBackup(payload)
        try excludeFromBackup(manifest)
        try removeOtherStagedEntries(in: root, keeping: token, cleanupTokens: &cleanupTokens)
        cleanupTokens.removeAll()
        guard manager.fileExists(atPath: payload.path), manager.fileExists(atPath: manifest.path) else {
          throw CocoaError(.fileNoSuchFile)
        }
        return StageOutcome(token: token, ready: true, cleanupTokens: [])
      } catch {
        if (try? removeAndVerify(entry, manager: manager)) == nil {
          cleanupTokens.insert(token)
        }
        return StageOutcome(token: token, ready: false, cleanupTokens: cleanupTokens)
      }
    }
  }

  private func withStagingLock<T>(in container: URL, operation: () throws -> T) throws -> T {
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
    return try operation()
  }

  private func copyBounded(from source: URL, to destination: URL) throws -> Int64 {
    let input = try FileHandle(forReadingFrom: source)
    let output = try FileHandle(forWritingTo: destination)
    defer {
      try? input.close()
      try? output.close()
    }
    var total: Int64 = 0
    while let data = try input.read(upToCount: 32 * 1024), !data.isEmpty {
      total += Int64(data.count)
      guard total <= maximumBytes else { throw CocoaError(.fileWriteOutOfSpace) }
      try output.write(contentsOf: data)
    }
    guard total >= 1 else { throw CocoaError(.fileReadCorruptFile) }
    try output.synchronize()
    return total
  }

  private func safeFilename(_ source: String, type: AllowedType) -> String {
    let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
    let extensionName = (trimmed as NSString).pathExtension.lowercased()
    let safe = !trimmed.isEmpty
      && trimmed.count <= 160
      && !trimmed.contains("/")
      && !trimmed.contains("\\")
      && !trimmed.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
      && type.extensions.contains(extensionName)
    return safe ? trimmed : type.fallback
  }

  private func excludeFromBackup(_ url: URL) throws {
    var mutable = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try mutable.setResourceValues(values)
  }

  private func removeOtherStagedEntries(
    in root: URL,
    keeping token: String,
    cleanupTokens: inout Set<String>
  ) throws {
    let manager = FileManager.default
    let siblings = try manager.contentsOfDirectory(
      at: root,
      includingPropertiesForKeys: nil,
      options: [.skipsHiddenFiles]
    ).filter { $0.lastPathComponent != token }
    cleanupTokens = Set(siblings.map(\.lastPathComponent))
    for sibling in siblings {
      try removeAndVerify(sibling, manager: manager)
    }
  }

  private func discardStagedEntries() -> Bool {
    guard !stagedTokens.isEmpty else { return true }
    guard let appGroupID,
      let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupID)
    else { return false }
    let root = container.appendingPathComponent(rootName, isDirectory: true)
    var remaining = stagedTokens
    let removed = (try? withStagingLock(in: container) {
      for token in stagedTokens.sorted() {
        guard let parsed = UUID(uuidString: token),
          parsed.uuidString.lowercased() == token.lowercased()
        else { continue }
        let entry = root.appendingPathComponent(parsed.uuidString.lowercased(), isDirectory: true)
        do {
          try removeAndVerify(entry)
          remaining.remove(token)
        } catch {
          // Keep the exact token latched so Done can retry without deleting a
          // sibling created by a later share operation.
        }
      }
      return remaining.isEmpty
    }) ?? false
    stagedTokens = remaining
    return removed
  }

  private func removeAndVerify(_ url: URL, manager: FileManager = .default) throws {
    if manager.fileExists(atPath: url.path) {
      try manager.removeItem(at: url)
    }
    guard !manager.fileExists(atPath: url.path) else { throw CocoaError(.fileWriteUnknown) }
  }

  private func showReady() {
    readyForHandoff = true
    spinner.stopAnimating()
    statusLabel.text = "Ready to finish in Union Ground. Open the app to choose an issue or task."
    doneButton.isHidden = false
    UIAccessibility.post(notification: .announcement, argument: statusLabel.text)
  }

  private func showFailure() {
    readyForHandoff = false
    spinner.stopAnimating()
    statusLabel.text = "This item could not be prepared. Share one supported document or image up to 10 MB."
    doneButton.isHidden = false
    UIAccessibility.post(notification: .announcement, argument: statusLabel.text)
  }

  private func showCleanupFailure() {
    readyForHandoff = false
    spinner.stopAnimating()
    statusLabel.text = "The temporary copy could not be cleared yet. Keep this sheet open and try Done again."
    doneButton.isHidden = false
    UIAccessibility.post(notification: .announcement, argument: statusLabel.text)
  }

  @objc private func closeExtension() {
    if !readyForHandoff && !discardStagedEntries() {
      showCleanupFailure()
      return
    }
    handoffCommitted = readyForHandoff
    extensionContext?.completeRequest(returningItems: nil)
  }
}
