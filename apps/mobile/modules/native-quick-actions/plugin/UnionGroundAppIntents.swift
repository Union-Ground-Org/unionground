import AppIntents
import Foundation

@available(iOS 16.0, *)
enum UnionGroundQuickActionStore {
  static let pendingKey = "org.unionground.app.pending-os-quick-action"
  static let notificationName = Notification.Name("org.unionground.app.native-quick-action")

  static func stage(_ identifier: String) {
    UserDefaults.standard.set(identifier, forKey: pendingKey)
    NotificationCenter.default.post(name: notificationName, object: nil)
  }
}

@available(iOS 16.0, *)
enum UnionGroundHomeTarget: String, AppEnum {
  case home

  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Union Ground Home destination"
  static let caseDisplayRepresentations: [UnionGroundHomeTarget: DisplayRepresentation] = [.home: "Home"]
}

@available(iOS 16.0, *)
enum UnionGroundCompassTarget: String, AppEnum {
  case compass

  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Union Ground Guide destination"
  static let caseDisplayRepresentations: [UnionGroundCompassTarget: DisplayRepresentation] = [.compass: "Guide"]
}

@available(iOS 16.0, *)
enum UnionGroundMessagesTarget: String, AppEnum {
  case messages

  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Union Ground Messages destination"
  static let caseDisplayRepresentations: [UnionGroundMessagesTarget: DisplayRepresentation] = [.messages: "Messages"]
}

@available(iOS 16.0, *)
enum UnionGroundWorkTarget: String, AppEnum {
  case work

  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Union Ground Work destination"
  static let caseDisplayRepresentations: [UnionGroundWorkTarget: DisplayRepresentation] = [.work: "Work"]
}

@available(iOS 16.0, *)
protocol UnionGroundQuickActionIntent: OpenIntent {
  static var quickActionIdentifier: String { get }
}

@available(iOS 16.0, *)
extension UnionGroundQuickActionIntent {
  func perform() async throws -> some IntentResult {
    UnionGroundQuickActionStore.stage(Self.quickActionIdentifier)
    return .result()
  }
}

@available(iOS 16.0, *)
struct OpenUnionGroundHomeIntent: UnionGroundQuickActionIntent {
  static let title: LocalizedStringResource = "Open Home"
  static let description = IntentDescription("Open the Union Ground Home workspace.")
  static let quickActionIdentifier = "home"
  static let openAppWhenRun = true
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
  @Parameter(title: "Destination", default: .home) var target: UnionGroundHomeTarget

  @available(iOS 26.0, *)
  static var supportedModes: IntentModes { .foreground(.immediate) }

  init() {}
}

@available(iOS 16.0, *)
struct OpenUnionGroundCompassIntent: UnionGroundQuickActionIntent {
  static let title: LocalizedStringResource = "Open Guide"
  static let description = IntentDescription("Open the Union Ground Guide workspace.")
  static let quickActionIdentifier = "compass"
  static let openAppWhenRun = true
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
  @Parameter(title: "Destination", default: .compass) var target: UnionGroundCompassTarget

  @available(iOS 26.0, *)
  static var supportedModes: IntentModes { .foreground(.immediate) }

  init() {}
}

@available(iOS 16.0, *)
struct OpenUnionGroundMessagesIntent: UnionGroundQuickActionIntent {
  static let title: LocalizedStringResource = "Open Messages"
  static let description = IntentDescription("Open the Union Ground Messages workspace.")
  static let quickActionIdentifier = "messages"
  static let openAppWhenRun = true
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
  @Parameter(title: "Destination", default: .messages) var target: UnionGroundMessagesTarget

  @available(iOS 26.0, *)
  static var supportedModes: IntentModes { .foreground(.immediate) }

  init() {}
}

@available(iOS 16.0, *)
struct OpenUnionGroundWorkIntent: UnionGroundQuickActionIntent {
  static let title: LocalizedStringResource = "Open Work"
  static let description = IntentDescription("Open the Union Ground Work workspace.")
  static let quickActionIdentifier = "work"
  static let openAppWhenRun = true
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
  @Parameter(title: "Destination", default: .work) var target: UnionGroundWorkTarget

  @available(iOS 26.0, *)
  static var supportedModes: IntentModes { .foreground(.immediate) }

  init() {}
}

@available(iOS 16.0, *)
struct UnionGroundAppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: OpenUnionGroundHomeIntent(),
      phrases: [
        "Open Home in \(.applicationName)",
        "Open \(.applicationName) Home",
        "Go to Home in \(.applicationName)",
      ],
      shortTitle: "Home",
      systemImageName: "house"
    )
    AppShortcut(
      intent: OpenUnionGroundCompassIntent(),
      phrases: [
        "Open Guide in \(.applicationName)",
        "Open \(.applicationName) Guide",
        "Go to Guide in \(.applicationName)",
      ],
      shortTitle: "Guide",
      systemImageName: "sparkles"
    )
    AppShortcut(
      intent: OpenUnionGroundMessagesIntent(),
      phrases: [
        "Open Messages in \(.applicationName)",
        "Go to Messages in \(.applicationName)",
      ],
      shortTitle: "Messages",
      systemImageName: "message"
    )
    AppShortcut(
      intent: OpenUnionGroundWorkIntent(),
      phrases: [
        "Open \(.applicationName) Work",
        "Go to Work in \(.applicationName)",
      ],
      shortTitle: "Work",
      systemImageName: "briefcase"
    )
  }

  static let shortcutTileColor: ShortcutTileColor = .grayGreen
}
