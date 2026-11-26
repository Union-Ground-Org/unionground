import XCTest

/// The iOS half of the G6 physical device-drill harness.
///
/// The 2026-09-06 drill recorded fifteen matrix rows `not_executed` because
/// `xcrun devicectl` exposes no hierarchy dump, no touch injection, no
/// screenshot and no URL-open verb (see
/// `docs/mobile/evidence/ios-g6-drill-20260906/physical-matrix-ios.csv`).
/// `DrillChannel` is the missing channel: it is the iOS counterpart of the
/// `adb` + `uiautomator` pair the Android half drove its rows with.
///
/// Every observation leaves the device twice - as an `XCTAttachment` inside the
/// result bundle, and as base64 `UGD|` lines on the test log that
/// `apps/mobile/scripts/ios-device-drill.mjs` reassembles into per-row evidence.
/// The log path is the one the Android half also relies on, and it is the path
/// the repository regression test exercises on Linux.
class DrillChannel: XCTestCase {
  /// `os_log` truncates long messages, so every payload is emitted in fixed
  /// pieces. The recipe reassembles them by index; the size is part of the
  /// channel contract and is pinned by the repository regression test.
  static let chunkSize = 600

  let app = XCUIApplication(bundleIdentifier: DrillChannel.bundleIdentifier)
  let settingsApp = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
  let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
  let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

  static var bundleIdentifier: String {
    ProcessInfo.processInfo.environment["PSG_DRILL_BUNDLE_ID"] ?? "org.example.unionground"
  }

  static var urlScheme: String {
    ProcessInfo.processInfo.environment["PSG_DRILL_URL_SCHEME"] ?? "unionground"
  }

  /// Arguments every launch this runner makes carries, so the application can
  /// report idle.
  ///
  /// XCUITest waits for the application to idle before and after every action,
  /// and gives up only after 60 seconds. The app's top chrome draws its blur
  /// with expo-blur, whose `BlurEffectView` sets a partial intensity by leaving
  /// a `UIViewPropertyAnimator` paused part-way for as long as the view lives.
  /// XCUITest counts that animation as running, so on every signed-in screen
  /// each action waited the full 60 seconds and taps landed on stale frames
  /// (#8154, measured on the store build's code with a SAMPLE member). expo-blur
  /// ships its own switch for test drivers: with these two arguments present it
  /// draws the blur on or off with no animator. Nothing else in the app reads
  /// them; screen-capture protection, the secure canvas and app-switcher
  /// protection are unchanged. The runner keeps XCUITest's idle wait.
  static let appLaunchArguments = ["-detoxServer", "none", "-detoxSessionId", "ug-drill"]

  /// Steps recorded for the row currently under test. Flushed by `finish`.
  private var steps: [[String: Any]] = []

  /// The value each Settings switch had before this process first changed it.
  /// Restoration means returning to THIS value, not to `false`: an operator
  /// who starts with Reduce Motion or Airplane Mode enabled must end that way.
  private var originalSettings: [String: Bool] = [:]

  override func setUpWithError() throws {
    // A single blocked row must not abort the rest of the drill: a row that
    // cannot be observed is reported, not silently dropped.
    continueAfterFailure = true
    app.launchArguments = DrillChannel.appLaunchArguments
    addUIInterruptionMonitor(withDescription: "system alert") { alert in
      for name in ["Open", "Allow", "Allow Once", "OK", "Not Now", "Cancel", "Don’t Allow", "Don't Allow"] {
        let button = alert.buttons[name]
        if button.exists && button.isHittable { button.tap(); return true }
      }
      return false
    }
  }

  // MARK: - evidence

  private func emit(_ kind: String, _ key: String, _ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else {
      NSLog("UGD|ERROR|%@|%@", kind, key)
      return
    }
    let encoded = Array(data.base64EncodedString())
    let size = DrillChannel.chunkSize
    let total = max(1, (encoded.count + size - 1) / size)
    for index in 0..<total {
      let start = index * size
      let end = min(start + size, encoded.count)
      NSLog("UGD|%@|%@|%03d|%03d|%@", kind, key, index, total, String(encoded[start..<end]))
    }
    let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
    attachment.name = "\(kind.lowercased())-\(key)"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  /// Record one drill step. `observed` carries whatever the step actually saw;
  /// nothing is inferred and nothing from the Android half is copied in.
  func step(_ name: String, _ outcome: String, _ observed: [String: Any] = [:]) {
    steps.append(["step": name, "outcome": outcome, "observed": observed])
    NSLog("UGD|STEP|%@|%@", name, outcome)
  }

  /// Flush the row. `status` uses the committed matrix vocabulary
  /// (`pass`, `partial`, `fail`, `not_executed`) and nothing else.
  func finish(row: String, status: String, notes: String) {
    emit("ROW", row, ["case": row, "status": status, "notes": notes, "steps": steps])
    steps = []
  }

  // MARK: - hierarchy

  private func traits(of snapshot: XCUIElementSnapshot) -> UInt64 {
    let object = snapshot as AnyObject
    guard object.responds(to: NSSelectorFromString("traits")),
          let number = object.value(forKey: "traits") as? NSNumber else { return 0 }
    return number.uint64Value
  }

  private func traitNames(_ value: UInt64) -> [String] {
    let map: [(UInt64, String)] = [
      (1, "button"), (2, "link"), (4, "image"), (8, "selected"), (16, "playsSound"),
      (32, "keyboardKey"), (64, "staticText"), (128, "summary"), (256, "notEnabled"),
      (512, "updatesFrequently"), (1024, "searchField"), (2048, "startsMedia"),
      (4096, "adjustable"), (8192, "directInteraction"), (16384, "pageTurn"),
      (32768, "tabBar"), (65536, "header"), (1 << 20, "toggleButton"), (1 << 21, "zoom"),
    ]
    var names = map.filter { value & $0.0 != 0 }.map { $0.1 }
    let known = map.reduce(UInt64(0)) { $0 | $1.0 }
    if value & ~known != 0 { names.append("0x" + String(value & ~known, radix: 16)) }
    return names
  }

  private func node(_ snapshot: XCUIElementSnapshot) -> [String: Any] {
    let frame = snapshot.frame
    return [
      "type": snapshot.elementType.rawValue,
      "identifier": snapshot.identifier,
      "label": snapshot.label,
      "value": snapshot.value.map { "\($0)" } ?? "",
      "placeholder": snapshot.placeholderValue ?? "",
      "traits": traitNames(traits(of: snapshot)),
      "enabled": snapshot.isEnabled,
      "selected": snapshot.isSelected,
      "frame": ["x": Int(frame.minX), "y": Int(frame.minY),
                "w": Int(frame.width), "h": Int(frame.height)],
      "children": snapshot.children.map { node($0) },
    ]
  }

  /// The iOS equivalent of `uiautomator dump`: the whole accessibility tree of
  /// the application under test, as JSON, with traits and geometry preserved.
  @discardableResult
  func hierarchy(_ screen: String) -> [String: Any] {
    guard let root = try? app.snapshot() else {
      step("hierarchy:\(screen)", "snapshot-failed")
      return [:]
    }
    let tree = node(root)
    emit("TREE", screen, ["screen": screen, "root": tree])
    step("hierarchy:\(screen)", "captured", ["nodes": DrillChannel.count(tree)])
    return tree
  }

  /// Ask whether a label is on screen **without** serialising the tree.
  ///
  /// `hierarchy` writes every label and value it walks to the test log and to
  /// an attachment. A surface whose state has not yet been classified may be an
  /// authenticated session restored from the Keychain, so the drill classifies
  /// it with this query first and only emits a hierarchy once the surface is
  /// known to be the PREVIEW demo.
  func probe(_ needle: String, timeout: TimeInterval = 10) -> Bool {
    let match = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS %@", needle)).firstMatch
    let found = match.waitForExistence(timeout: timeout)
    step("probe:\(needle)", found ? "present" : "absent")
    return found
  }

  static func count(_ tree: [String: Any]) -> Int {
    let children = tree["children"] as? [[String: Any]] ?? []
    return 1 + children.reduce(0) { $0 + count($1) }
  }

  /// Flatten a captured tree so a row can assert on labels without re-walking.
  static func flatten(_ tree: [String: Any]) -> [[String: Any]] {
    let children = tree["children"] as? [[String: Any]] ?? []
    return [tree] + children.flatMap { flatten($0) }
  }

  // MARK: - screenshots

  /// Screenshot policy for this drill.
  ///
  /// Union Ground deliberately protects authenticated surfaces. When a screen
  /// is protected the runner files the reason and the accessibility tree
  /// instead of pixels; it never disables, downgrades or works around the
  /// protection, and it never captures the app switcher.
  func shot(_ name: String, protected: Bool = false, reason: String = "") {
    if protected {
      step("shot:\(name)", "withheld-by-policy", ["reason": reason])
      return
    }
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = "shot-\(name)"
    attachment.lifetime = .keepAlways
    add(attachment)
    step("shot:\(name)", "captured")
  }

  // MARK: - input

  func element(id: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: id).firstMatch
  }

  func element(label: String) -> XCUIElement {
    app.descendants(matching: .any)
      .matching(NSPredicate(format: "label == %@", label)).firstMatch
  }

  @discardableResult
  func tap(id: String, timeout: TimeInterval = 15) -> Bool {
    tap(element(id: id), name: "id=\(id)", timeout: timeout)
  }

  @discardableResult
  func tap(label: String, timeout: TimeInterval = 15) -> Bool {
    tap(element(label: label), name: "label=\(label)", timeout: timeout)
  }

  @discardableResult
  private func tap(_ target: XCUIElement, name: String, timeout: TimeInterval) -> Bool {
    guard target.waitForExistence(timeout: timeout) else {
      step("tap:\(name)", "missing")
      return false
    }
    // Tapping a non-hittable element raises a non-continuable XCTest error and
    // would kill the whole drill, so fall back to the element's centre point.
    if target.isHittable {
      target.tap()
    } else {
      target.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }
    step("tap:\(name)", "tapped")
    return true
  }

  @discardableResult
  func type(_ text: String, into id: String, timeout: TimeInterval = 15) -> Bool {
    let field = element(id: id)
    guard field.waitForExistence(timeout: timeout) else {
      step("type:\(id)", "missing")
      return false
    }
    field.tap()
    field.typeText(text)
    step("type:\(id)", "typed", ["characters": text.count])
    return true
  }

  // MARK: - surfaces outside the application under test

  /// `app.snapshot()` only ever contains the application under test, so a row
  /// must not read "the app is still up" as "the system surface appeared". A
  /// permission alert and another application's hand-off are observed here,
  /// where they actually live.
  func systemSurface(labels: [String], timeout: TimeInterval = 10) -> String? {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
      for label in labels {
        let inSpringboard = springboard.descendants(matching: .any)
          .matching(NSPredicate(format: "label == %@", label)).firstMatch
        if inSpringboard.exists {
          step("system-surface", "springboard:\(label)")
          return "springboard:\(label)"
        }
      }
      if app.state != .runningForeground && app.state != .notRunning {
        step("system-surface", "app-left-foreground")
        return "app-left-foreground"
      }
      Thread.sleep(forTimeInterval: 0.5)
    } while Date() < deadline
    step("system-surface", "none")
    return nil
  }

  /// Tap a control on a surface that belongs to SpringBoard rather than to the
  /// application under test, falling back to the application's own tree.
  @discardableResult
  func tapSystem(label: String, timeout: TimeInterval = 6) -> Bool {
    let target = springboard.descendants(matching: .any)
      .matching(NSPredicate(format: "label == %@", label)).firstMatch
    if target.waitForExistence(timeout: timeout) {
      if target.isHittable {
        target.tap()
      } else {
        target.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
      }
      step("tap-system:\(label)", "tapped")
      return true
    }
    step("tap-system:\(label)", "missing")
    return tap(label: label, timeout: 2)
  }

  // MARK: - custom-scheme routing

  /// Open `<scheme>://<path>` through Safari, which is the only public channel
  /// XCUITest has for handing a custom-scheme URL to another application.
  /// `cold` terminates the app first, so the row can distinguish a cold launch
  /// from a warm resume exactly as the Android half did with `am start`. A cold
  /// open is launched by iOS, so it cannot carry `appLaunchArguments`: actions
  /// on that launch wait out XCUITest's idle timeout until the next
  /// `launchApp(cold: true)`.
  @discardableResult
  func openScheme(_ path: String, cold: Bool) -> Bool {
    if cold { app.terminate() }
    let url = "\(DrillChannel.urlScheme)://\(path)"
    safari.terminate()
    safari.activate()
    guard safari.wait(for: .runningForeground, timeout: 20) else {
      step("open:\(url)", "safari-unavailable")
      return false
    }
    var field: XCUIElement?
    for name in ["URL", "Address", "Search or enter website name"] {
      let candidate = safari.textFields[name].firstMatch
      if candidate.waitForExistence(timeout: 4) { field = candidate; break }
      let searchField = safari.searchFields[name].firstMatch
      if searchField.waitForExistence(timeout: 1) { field = searchField; break }
    }
    guard let bar = field ?? (safari.textFields.firstMatch.exists ? safari.textFields.firstMatch : nil) else {
      step("open:\(url)", "address-bar-missing")
      return false
    }
    bar.tap()
    bar.typeText(url + "\n")
    // The "Open in ..." confirmation belongs to SpringBoard on current iOS.
    for host in [springboard, safari] {
      let confirm = host.buttons["Open"].firstMatch
      if confirm.waitForExistence(timeout: 5) && confirm.isHittable { confirm.tap(); break }
    }
    let opened = app.wait(for: .runningForeground, timeout: 25)
    step("open:\(url)", opened ? (cold ? "cold-opened" : "warm-opened") : "not-foregrounded")
    return opened
  }

  // MARK: - device settings

  /// XCUITest cannot change a system accessibility or radio setting directly.
  /// It can drive Settings.app, which is a separate application it is allowed
  /// to automate, and that is what these helpers do. Every one of them reports
  /// failure rather than assuming the setting took, so a row blocked by an
  /// unreachable control is recorded `not_executed`, never fabricated.
  private func openSettings(path: [String]) -> Bool {
    settingsApp.terminate()
    settingsApp.activate()
    guard settingsApp.wait(for: .runningForeground, timeout: 20) else { return false }
    // Reactivating Settings restores whatever page it was left on, and every
    // path below - including the empty airplane-mode path - is written from the
    // root. Walk back and scroll up first so the phone's prior Settings state
    // cannot turn a valid row into `not_executed`.
    var pops = 0
    while !settingsApp.navigationBars["Settings"].exists && pops < 12 {
      let back = settingsApp.navigationBars.buttons.element(boundBy: 0)
      guard back.exists && back.isHittable else { break }
      back.tap()
      pops += 1
    }
    let atRoot = settingsApp.navigationBars["Settings"].exists
    step("settings:root", atRoot ? "at-root" : "unknown", ["pops": pops])
    guard atRoot else { return false }
    for _ in 0..<4 where !settingsApp.switches["Airplane Mode"].firstMatch.exists {
      settingsApp.swipeDown()
    }
    for label in path {
      let cell = settingsApp.descendants(matching: .any)
        .matching(NSPredicate(format: "label == %@", label)).firstMatch
      var attempts = 0
      while !(cell.exists && cell.isHittable) && attempts < 8 {
        settingsApp.swipeUp()
        attempts += 1
      }
      guard cell.exists && cell.isHittable else {
        step("settings:\(label)", "unreachable")
        return false
      }
      cell.tap()
    }
    return true
  }

  /// A switch value is recognised only as "1" or "0". Anything else (nil, a
  /// mid-animation value, an unexpected accessibility value) is unknown, and
  /// an unknown value is never defaulted to `false`: nothing is mutated on it
  /// and nothing is recorded as its original.
  private func switchValue(_ control: XCUIElement) -> Bool? {
    guard let raw = control.value as? String else { return nil }
    if raw == "1" { return true }
    if raw == "0" { return false }
    return nil
  }

  /// Bounded wait for a recognised value that holds across two consecutive
  /// reads. A value that never settles is unknown.
  private func stableSwitchValue(_ control: XCUIElement, timeout: TimeInterval = 4) -> Bool? {
    let deadline = Date().addingTimeInterval(timeout)
    var last: Bool? = nil
    repeat {
      let current = switchValue(control)
      if let current = current, current == last { return current }
      last = current
      Thread.sleep(forTimeInterval: 0.25)
    } while Date() < deadline
    return nil
  }

  /// Mutations that were injected and whose outcome has not yet been confirmed
  /// or restored. Recorded before the tap so an early return can never leave
  /// an unaccounted change behind.
  private var pendingSettings: Set<String> = []

  @discardableResult
  private func setSwitch(path: [String], label: String, on: Bool) -> Bool {
    guard openSettings(path: path) else { return false }
    let control = settingsApp.switches[label].firstMatch
    var attempts = 0
    while !control.exists && attempts < 8 {
      settingsApp.swipeUp()
      attempts += 1
    }
    guard control.waitForExistence(timeout: 5) else {
      step("settings:\(label)", "control-missing")
      return false
    }
    guard let previous = stableSwitchValue(control) else {
      // Unknown is unknown: no tap, no original recorded, no restoration claimed.
      step("settings:\(label)", "value-unknown", ["requested": on])
      return false
    }
    if originalSettings[label] == nil {
      originalSettings[label] = previous
      step("settings-initial:\(label)", previous ? "on" : "off")
    }
    let original = originalSettings[label] ?? previous
    if previous == on {
      step("settings:\(label)", "already", ["requested": on, "observed": previous, "original": original])
      if pendingSettings.contains(label) && on == original {
        pendingSettings.remove(label)
        step("settings-restored", label)
      }
      return true
    }
    // The pending record precedes the injection: from here on the phone may
    // differ from its original until a restoration is confirmed.
    pendingSettings.insert(label)
    step("settings-pending", label)
    control.tap()
    let settled = stableSwitchValue(control)
    step("settings:\(label)", settled == on ? "set" : (settled == nil ? "readback-unknown" : "unchanged"),
         ["requested": on, "observed": settled as Any, "previous": previous, "original": original])
    guard settled == on else {
      // The tap was injected but its effect was not observed; the setting
      // stays pending (and so unrestored) until a restoration confirms it.
      step("settings-unproven", label)
      return false
    }
    // The recipe derives `settings_restored` chronologically from these steps:
    // a value that differs from the original is a touch, a value equal to the
    // original after a touch is a restoration. `false` is not "restored".
    if settled != original {
      step("settings-touched", label)
    } else {
      pendingSettings.remove(label)
      step("settings-restored", label)
    }
    return true
  }

  /// Put a switch back to the value it had before this process first changed
  /// it. Nothing to do, and nothing claimed, when it was never attempted. A
  /// restoration that does not settle on the original value is reported as
  /// such so the row, and the operator header, never certify it restored.
  @discardableResult
  private func restoreSwitch(path: [String], label: String) -> Bool {
    guard let original = originalSettings[label] else { return true }
    if setSwitch(path: path, label: label, on: original) { return true }
    step("settings-restore-failed", label)
    return false
  }

  /// Airplane mode. The drill must be driven over USB: switching the radios off
  /// drops a Wi-Fi-attached test session and would end the run mid-row.
  @discardableResult
  func setAirplaneMode(_ on: Bool) -> Bool {
    setSwitch(path: [], label: "Airplane Mode", on: on)
  }

  @discardableResult
  func restoreAirplaneMode() -> Bool {
    restoreSwitch(path: [], label: "Airplane Mode")
  }

  @discardableResult
  func setReduceMotion(_ on: Bool) -> Bool {
    setSwitch(path: ["Accessibility", "Motion"], label: "Reduce Motion", on: on)
  }

  @discardableResult
  func restoreReduceMotion() -> Bool {
    restoreSwitch(path: ["Accessibility", "Motion"], label: "Reduce Motion")
  }

  /// Dynamic Type. Unlike Reduce Motion there is a deterministic per-process
  /// override, so the runner relaunches the application under test with the
  /// requested content size category instead of dragging the Settings slider.
  /// This exercises the application's response to the category; it does not
  /// change the system setting, and the runbook says so.
  @discardableResult
  func relaunchWithContentSizeCategory(_ category: String) -> Bool {
    app.terminate()
    app.launchArguments = DrillChannel.appLaunchArguments + ["-UIPreferredContentSizeCategoryName", category]
    app.launch()
    let running = app.wait(for: .runningForeground, timeout: 30)
    step("content-size:\(category)", running ? "applied" : "launch-failed")
    return running
  }

  // MARK: - lifecycle

  /// `launch()` is the call documented to apply `launchArguments`, so a launch
  /// goes through it whenever the application is not already running.
  @discardableResult
  func launchApp(cold: Bool = true) -> Bool {
    if cold { app.terminate() }
    if app.state == .notRunning { app.launch() } else { app.activate() }
    let running = app.wait(for: .runningForeground, timeout: 30)
    step("launch", running ? "foreground" : "not-foregrounded")
    return running
  }

  /// Send the application to the background without capturing the app switcher.
  @discardableResult
  func background(seconds: TimeInterval = 3) -> Bool {
    XCUIDevice.shared.press(.home)
    Thread.sleep(forTimeInterval: seconds)
    let backgrounded = app.state != .runningForeground
    step("background", backgrounded ? "backgrounded" : "still-foreground")
    return backgrounded
  }
}
