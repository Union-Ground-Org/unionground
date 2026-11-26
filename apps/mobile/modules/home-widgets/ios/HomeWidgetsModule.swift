import ExpoModulesCore
import Foundation
import WidgetKit

// Written by app.plugin.js from the build's application identifier.
private let widgetGroup = Bundle.main.object(forInfoDictionaryKey: "UGHomeWidgetsAppGroup") as? String ?? ""

public final class HomeWidgetsModule: Module {
  private var generation: String? = nil

  private func snapshotURL() throws -> URL {
    guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: widgetGroup) else {
      throw NSError(domain: "HomeWidgets", code: 1)
    }
    return root.appendingPathComponent("counts.json")
  }

  public func definition() -> ModuleDefinition {
    Name("HomeWidgets")

    AsyncFunction("resetAsync") { (generation: String) in
      self.generation = generation
      let url = try self.snapshotURL()
      if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
      WidgetCenter.shared.reloadAllTimelines()
    }.runOnQueue(.main)

    AsyncFunction("publishAsync") { (generation: String, today: Int, unread: Int, updatedAt: Double, expiresAt: Double) in
      guard self.generation == generation else { return }
      let now = Date().timeIntervalSince1970 * 1000
      guard today >= 0, unread >= 0, today <= Int(Int32.max), unread <= Int(Int32.max),
        updatedAt.isFinite, expiresAt.isFinite, updatedAt <= now, expiresAt > now,
        expiresAt > updatedAt, expiresAt - updatedAt <= 300_000 else {
        throw NSError(domain: "HomeWidgets", code: 2)
      }
      let payload: [String: Any] = ["today": today, "unread": unread, "updatedAt": updatedAt, "expiresAt": expiresAt]
      let data = try JSONSerialization.data(withJSONObject: payload)
      var url = try self.snapshotURL()
      try data.write(to: url, options: [.atomic, .completeFileProtection])
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try url.setResourceValues(values)
      WidgetCenter.shared.reloadAllTimelines()
    }.runOnQueue(.main)
  }
}
