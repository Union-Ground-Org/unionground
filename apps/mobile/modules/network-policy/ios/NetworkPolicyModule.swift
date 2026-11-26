import ExpoModulesCore
import Foundation
import Network

private let networkChangeEvent = "onNetworkChange"

// Reports what the operating system already knows about the current network
// path: whether it is usable, whether it is expensive (cellular or a personal
// hotspot), and whether Low Data Mode constrains it. The module opens no
// socket, sends no request, and times no download to guess at the connection,
// so a reading costs nothing on a metered plan. One shared NWPathMonitor
// serves both the snapshot read and the change event.
public final class NetworkPolicyModule: Module {
  private let monitorQueue = DispatchQueue(label: "org.unionground.app.network-policy")
  private let state = NSLock()
  private var monitor: NWPathMonitor?
  private var latestPath: NWPath?
  private var observing = false

  public func definition() -> ModuleDefinition {
    Name("NetworkPolicy")

    Events(networkChangeEvent)

    // NWPathMonitor and NWPath.isConstrained exist on every system version
    // this application supports, so the reading is always available here.
    Function("isSupported") { () -> Bool in true }

    AsyncFunction("getSignalsAsync") { () -> [String: Any?] in
      self.startMonitorIfNeeded()
      return self.currentSignals()
    }

    OnStartObserving(networkChangeEvent) {
      self.state.lock()
      self.observing = true
      self.state.unlock()
      self.startMonitorIfNeeded()
    }

    // Only delivery stops with the last listener. The path observer itself is
    // a single system registration with no polling, and it is kept so a later
    // snapshot read answers from the reading already in hand.
    OnStopObserving(networkChangeEvent) {
      self.state.lock()
      self.observing = false
      self.state.unlock()
    }

    OnDestroy {
      self.state.lock()
      let retired = self.monitor
      self.monitor = nil
      self.latestPath = nil
      self.observing = false
      self.state.unlock()
      retired?.cancel()
    }
  }

  private func startMonitorIfNeeded() {
    state.lock()
    guard monitor == nil else {
      state.unlock()
      return
    }
    let started = NWPathMonitor()
    monitor = started
    state.unlock()

    started.pathUpdateHandler = { [weak self] path in
      self?.handle(path: path)
    }
    started.start(queue: monitorQueue)
  }

  private func handle(path: NWPath) {
    state.lock()
    // An update already queued when the module was destroyed must not revive
    // the reading or emit after the listeners are gone.
    guard monitor != nil else {
      state.unlock()
      return
    }
    latestPath = path
    let shouldSend = observing
    let signals = signalsWhileLocked()
    state.unlock()

    if shouldSend {
      sendEvent(networkChangeEvent, signals)
    }
  }

  private func currentSignals() -> [String: Any?] {
    state.lock()
    defer { state.unlock() }
    return signalsWhileLocked()
  }

  // Before the first path update the reading is honestly unknown: the three
  // values stay null and JavaScript keeps normal data use.
  private func signalsWhileLocked() -> [String: Any?] {
    guard let path = latestPath else {
      return ["supported": true, "connected": nil, "expensive": nil, "constrained": nil]
    }
    return [
      "supported": true,
      "connected": path.status == .satisfied,
      "expensive": path.isExpensive,
      "constrained": path.isConstrained,
    ]
  }
}
