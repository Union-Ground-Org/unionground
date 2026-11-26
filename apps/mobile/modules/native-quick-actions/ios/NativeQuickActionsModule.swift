import ExpoModulesCore
import Foundation

private let quickActionEvent = "onQuickAction"
private let quickActionNotification = Notification.Name("org.unionground.app.native-quick-action")
private let pendingQuickActionKey = "org.unionground.app.pending-os-quick-action"
private let allowedQuickActions: Set<String> = ["home", "compass", "messages", "work"]

public final class NativeQuickActionsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NativeQuickActions")

    Events(quickActionEvent)

    OnStartObserving(quickActionEvent) {
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(self.handleQuickActionNotification),
        name: quickActionNotification,
        object: nil
      )
    }

    OnStopObserving(quickActionEvent) {
      NotificationCenter.default.removeObserver(
        self,
        name: quickActionNotification,
        object: nil
      )
    }

    OnDestroy {
      NotificationCenter.default.removeObserver(self)
    }

    AsyncFunction("consumePendingAsync") { () -> String? in
      let defaults = UserDefaults.standard
      let pending = defaults.string(forKey: pendingQuickActionKey)
      defaults.removeObject(forKey: pendingQuickActionKey)
      guard let pending, allowedQuickActions.contains(pending) else { return nil }
      return pending
    }
  }

  @objc
  private func handleQuickActionNotification() {
    sendEvent(quickActionEvent)
  }
}
