import EventKit
import EventKitUI
import ExpoModulesCore
import Foundation

// One in-flight system composer at a time. The session retains the event
// store and the JavaScript promise until the user saves or cancels inside
// the out-of-process EventKitUI sheet; the app never touches the calendar
// database directly and never requests calendar authorization.
private final class CalendarComposerSession: NSObject, EKEventEditViewDelegate {
  static var active: CalendarComposerSession?

  private let store: EKEventStore
  private let promise: Promise

  init(store: EKEventStore, promise: Promise) {
    self.store = store
    self.promise = promise
    super.init()
  }

  func eventEditViewController(
    _ controller: EKEventEditViewController,
    didCompleteWith action: EKEventEditViewAction
  ) {
    controller.dismiss(animated: true)
    promise.resolve(action == .saved ? "saved" : "canceled")
    CalendarComposerSession.active = nil
  }
}

public final class NativeCalendarExportModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NativeCalendarExport")

    // The permission-free edit sheet runs out of process starting with
    // iOS 17; older systems would demand full calendar authorization,
    // which this integration deliberately never requests.
    Function("isAvailable") { () -> Bool in
      if #available(iOS 17.0, *) { return true }
      return false
    }

    AsyncFunction("presentEventComposerAsync") {
      (title: String, startMs: Double, endMs: Double, location: String?, promise: Promise) in
      guard #available(iOS 17.0, *) else {
        promise.reject("E_UNAVAILABLE", "The system event composer requires iOS 17.")
        return
      }
      guard CalendarComposerSession.active == nil else {
        promise.reject("E_BUSY", "A system event composer is already open.")
        return
      }
      let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmedTitle.isEmpty, endMs > startMs else {
        promise.reject("E_INVALID", "The composer needs a title and a forward time range.")
        return
      }
      guard let host = self.appContext?.utilities?.currentViewController() else {
        promise.reject("E_NO_HOST", "No foreground screen can present the composer.")
        return
      }

      let store = EKEventStore()
      let event = EKEvent(eventStore: store)
      event.title = trimmedTitle
      event.startDate = Date(timeIntervalSince1970: startMs / 1000)
      event.endDate = Date(timeIntervalSince1970: endMs / 1000)
      if let location = location?.trimmingCharacters(in: .whitespacesAndNewlines), !location.isEmpty {
        event.location = location
      }

      let editor = EKEventEditViewController()
      editor.eventStore = store
      editor.event = event
      let session = CalendarComposerSession(store: store, promise: promise)
      CalendarComposerSession.active = session
      editor.editViewDelegate = session
      host.present(editor, animated: true)
    }.runOnQueue(.main)
  }
}
