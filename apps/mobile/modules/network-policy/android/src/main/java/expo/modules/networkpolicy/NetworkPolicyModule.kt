package expo.modules.networkpolicy

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val NETWORK_CHANGE_EVENT = "onNetworkChange"

// Unknown is a reading the module is allowed to return: no ConnectivityManager,
// or a system that refuses the query, means the application keeps normal data
// use instead of guessing.
private val UNKNOWN_SIGNALS: Map<String, Any?> = mapOf(
  "supported" to false,
  "connected" to null,
  "expensive" to null,
  "constrained" to null,
)

// Reports what ConnectivityManager already knows about the active network:
// whether it is usable, whether it is metered, and whether Data Saver
// restricts this application. The module opens no socket, sends no request,
// and downloads nothing to measure the connection, so a reading costs no
// metered bytes. Both registrations are runtime-only and are removed with the
// last listener.
class NetworkPolicyModule : Module() {
  private var networkCallback: ConnectivityManager.NetworkCallback? = null
  private var dataSaverReceiver: BroadcastReceiver? = null
  private var observing = false

  // While the default-network callback is registered, it is the source of
  // truth. Android warns that ConnectivityManager queries made inside these
  // callbacks race the callbacks themselves: in onLost, activeNetwork can
  // still return the network that was just lost, which once kept Auto on a
  // stale unmetered reading after the phone went offline. The callback's own
  // arguments are recorded here instead, and both the event and a snapshot
  // read report them.
  @Volatile private var tracking = false
  @Volatile private var defaultNetwork: Network? = null
  @Volatile private var defaultCapabilities: NetworkCapabilities? = null

  // Android can block the default network for this application (background
  // restrictions, a lockdown VPN) without changing its capabilities. The
  // synchronous query then returns no active network, so a blocked network
  // is reported as disconnected here too.
  @Volatile private var defaultBlocked = false

  // Every change to the tracked network takes this lock and advances the
  // generation, so a deferred Android 7 refresh can tell that a newer callback
  // or a stop has already replaced the state it was asked to fill in.
  private val trackingLock = Any()
  private var generation = 0L
  private val main = Handler(Looper.getMainLooper())

  private val context: Context?
    get() = appContext.reactContext

  private val connectivity: ConnectivityManager?
    get() = context?.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager

  override fun definition() = ModuleDefinition {
    Name("NetworkPolicy")

    Events(NETWORK_CHANGE_EVENT)

    Function("isSupported") { connectivity != null }

    // ConnectivityManager answers from state the system already holds, so the
    // snapshot needs no monitor and no waiting.
    AsyncFunction("getSignalsAsync") { signals() }

    OnStartObserving(NETWORK_CHANGE_EVENT) { startObserving() }

    OnStopObserving(NETWORK_CHANGE_EVENT) { stopObserving() }

    OnDestroy { stopObserving() }
  }

  private fun signals(): Map<String, Any?> {
    val manager = connectivity ?: return UNKNOWN_SIGNALS
    return try {
      reading(manager, if (tracking) trackedCapabilities() else currentCapabilities(manager))
    } catch (cause: SecurityException) {
      // Without ACCESS_NETWORK_STATE the honest answer is unknown, not a guess.
      UNKNOWN_SIGNALS
    }
  }

  private fun reading(manager: ConnectivityManager, capabilities: NetworkCapabilities?): Map<String, Any?> = mapOf(
    "supported" to true,
    "connected" to isUsable(capabilities),
    "expensive" to isMetered(capabilities),
    "constrained" to isDataSaverRestricted(manager),
  )

  // Outside the callbacks the synchronous query is the documented way to read
  // the default network.
  private fun currentCapabilities(manager: ConnectivityManager): NetworkCapabilities? =
    manager.activeNetwork?.let(manager::getNetworkCapabilities)

  // The recorded reading, with a blocked network served as no network at all.
  private fun trackedCapabilities(): NetworkCapabilities? =
    synchronized(trackingLock) { if (defaultBlocked) null else defaultCapabilities }

  // Android 7 promises no onCapabilitiesChanged after onAvailable, so the
  // network the system just named has to be asked about once. The question is
  // posted from onAvailable and asked here, after that callback has returned,
  // because a query made on the callback's own stack can return an outdated
  // reading. The answer is kept only if no newer callback and no stop has
  // replaced the tracked state, checked again after the query so a callback
  // that lands during it is not overwritten by a late result.
  private fun refreshLegacy(
    manager: ConnectivityManager,
    callback: ConnectivityManager.NetworkCallback,
    network: Network,
    expected: Long,
  ) {
    if (!isCurrent(callback, network, expected)) return
    val capabilities = try {
      manager.getNetworkCapabilities(network)
    } catch (cause: SecurityException) {
      null
    }
    val applied = synchronized(trackingLock) {
      isCurrent(callback, network, expected).also { current ->
        if (current) defaultCapabilities = capabilities
      }
    }
    if (applied) publish()
  }

  private fun isCurrent(callback: ConnectivityManager.NetworkCallback, network: Network, expected: Long): Boolean =
    synchronized(trackingLock) {
      tracking && networkCallback === callback && defaultNetwork == network && generation == expected
    }

  // A captive portal or a network that failed validation carries no usable
  // internet, which is exactly the state offline handling must see.
  private fun isUsable(capabilities: NetworkCapabilities?): Boolean = capabilities != null &&
    capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
    capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)

  private fun isMetered(capabilities: NetworkCapabilities?): Boolean? {
    // No active network is nothing to measure rather than an unmetered one.
    if (capabilities == null) return null
    // A carrier may lift metering for a window; the system reports that
    // directly and the application must not keep charging the user for it.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
      capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_TEMPORARILY_NOT_METERED)
    ) {
      return false
    }
    return !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
  }

  // Data Saver restricts this application only when it is not allowlisted.
  // A user who allowlisted Union Ground asked for its data to keep flowing,
  // so WHITELISTED is not reported as a constrained path.
  private fun isDataSaverRestricted(manager: ConnectivityManager): Boolean =
    manager.restrictBackgroundStatus == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED

  private fun startObserving() {
    val manager = connectivity ?: return
    val host = context ?: return
    observing = true

    if (networkCallback == null) {
      val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
          // A capabilities query made here can return an outdated reading, so
          // the previous network's capabilities are dropped and nothing is
          // published until the new network's own are known.
          // A new network starts unblocked; from Android Q a blocked one is
          // reported by onBlockedStatusChanged right after this callback.
          val expected = synchronized(trackingLock) {
            if (defaultNetwork != network) defaultBlocked = false
            defaultNetwork = network
            defaultCapabilities = null
            ++generation
          }
          // Android O and later always follow this callback with
          // onCapabilitiesChanged, which names them.
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) return
          val callback = this
          main.post { refreshLegacy(manager, callback, network, expected) }
        }

        override fun onLost(network: Network) {
          // A default-network callback loses only the default network. Once it
          // is gone there is nothing to measure until another one arrives.
          synchronized(trackingLock) {
            if (defaultNetwork == null || defaultNetwork == network) {
              defaultNetwork = null
              defaultCapabilities = null
              defaultBlocked = false
              generation++
            }
          }
          publish()
        }

        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
          synchronized(trackingLock) {
            if (defaultNetwork != network) defaultBlocked = false
            defaultNetwork = network
            defaultCapabilities = capabilities
            generation++
          }
          publish()
        }

        override fun onBlockedStatusChanged(network: Network, blocked: Boolean) {
          synchronized(trackingLock) {
            if (defaultNetwork == network) defaultBlocked = blocked
          }
          publish()
        }
      }
      try {
        // Seed from the documented synchronous query before the first callback
        // can land, so a read taken in between is not reported as offline.
        val seed = manager.activeNetwork
        val seedCapabilities = seed?.let(manager::getNetworkCapabilities)
        synchronized(trackingLock) {
          defaultNetwork = seed
          defaultCapabilities = seedCapabilities
          defaultBlocked = false
          generation++
          tracking = true
          networkCallback = callback
        }
        manager.registerDefaultNetworkCallback(callback)
      } catch (cause: SecurityException) {
        synchronized(trackingLock) {
          tracking = false
          networkCallback = null
          generation++
        }
      }
    }

    if (dataSaverReceiver == null) {
      val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) = emit()
      }
      // Turning Data Saver on or off changes no network capability, so this
      // protected system broadcast is the only signal for it. The receiver is
      // runtime-registered, never declared in the manifest, and never exported.
      try {
        host.registerReceiver(receiver, IntentFilter(ConnectivityManager.ACTION_RESTRICT_BACKGROUND_CHANGED))
        dataSaverReceiver = receiver
      } catch (cause: RuntimeException) {
        dataSaverReceiver = null
      }
    }
  }

  private fun stopObserving() {
    observing = false
    val callback = synchronized(trackingLock) {
      tracking = false
      defaultNetwork = null
      defaultCapabilities = null
      defaultBlocked = false
      generation++
      networkCallback.also { networkCallback = null }
    }
    // A deferred Android 7 refresh would be refused by the generation check;
    // dropping it simply spares the query.
    main.removeCallbacksAndMessages(null)

    if (callback != null) {
      try {
        connectivity?.unregisterNetworkCallback(callback)
      } catch (cause: IllegalArgumentException) {
        // The system already dropped this callback.
      }
    }

    dataSaverReceiver?.let { receiver ->
      dataSaverReceiver = null
      try {
        context?.unregisterReceiver(receiver)
      } catch (cause: IllegalArgumentException) {
        // The receiver was already unregistered with its context.
      }
    }
  }

  // System callbacks arrive on their own thread and can still fire once after
  // the listener is removed; a reading is only emitted while JavaScript is
  // actually observing.
  private fun emit() {
    if (!observing) return
    sendEvent(NETWORK_CHANGE_EVENT, signals())
  }

  // The network callbacks publish only the reading they recorded, so nothing
  // on their stack asks ConnectivityManager about the network again.
  private fun publish() {
    if (!observing || !tracking) return
    val manager = connectivity ?: return
    val signals = try {
      reading(manager, trackedCapabilities())
    } catch (cause: SecurityException) {
      UNKNOWN_SIGNALS
    }
    sendEvent(NETWORK_CHANGE_EVENT, signals)
  }
}
