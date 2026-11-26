package expo.modules.secureshareintake

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView

class SecureShareReceiverActivity : Activity() {
  private lateinit var status: TextView
  private lateinit var progress: ProgressBar
  private lateinit var done: Button
  @Volatile private var cancelled = false
  @Volatile private var handoffCommitted = false
  private val stagedTokens = linkedSetOf<String>()

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    renderShell()
    val incoming = intent
    Thread {
      val outcome = try {
        SecureShareStorage.stageFromIntent(applicationContext, incoming)
      } catch (_: Exception) {
        null
      }
      runOnUiThread {
        val pending = outcome?.pending
        if (outcome != null) {
          stagedTokens.addAll(outcome.cleanupTokens)
          if (pending != null) stagedTokens.add(pending.token)
        }
        if (cancelled || isFinishing || isDestroyed) {
          if (!cancelShare()) showCleanupFailure()
        } else if (pending == null) {
          if (outcome != null && !outcome.cleanupConfirmed) showCleanupFailure() else showFailure()
        } else {
          openUnionGround(pending)
        }
      }
    }.start()
  }

  @Deprecated("Android calls this compatibility hook for system Back on the supported activity base class")
  override fun onBackPressed() {
    if (cancelShare()) super.onBackPressed() else showCleanupFailure()
  }

  override fun onStop() {
    if (!handoffCommitted && !isChangingConfigurations) cancelShare()
    super.onStop()
  }

  override fun onDestroy() {
    if (!handoffCommitted && !isChangingConfigurations) cancelShare()
    super.onDestroy()
  }

  private fun renderShell() {
    val density = resources.displayMetrics.density
    val container = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      setPadding((32 * density).toInt(), (48 * density).toInt(), (32 * density).toInt(), (48 * density).toInt())
      setBackgroundColor(Color.rgb(244, 242, 236))
    }
    val heading = TextView(this).apply {
      text = getString(R.string.secure_share_intake_title)
      textSize = 24f
      setTextColor(Color.rgb(14, 64, 52))
      gravity = Gravity.CENTER
    }
    status = TextView(this).apply {
      text = "Preparing this item securely…"
      textSize = 16f
      setTextColor(Color.rgb(55, 65, 61))
      gravity = Gravity.CENTER
      setPadding(0, (16 * density).toInt(), 0, (24 * density).toInt())
    }
    progress = ProgressBar(this)
    done = Button(this).apply {
      text = "Done"
      visibility = Button.GONE
      setOnClickListener {
        if (cancelShare()) finishAndRemoveTask() else showCleanupFailure()
      }
    }
    container.addView(heading, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    container.addView(status, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    container.addView(progress)
    container.addView(done)
    setContentView(container)
  }

  private fun showFailure() {
    progress.visibility = ProgressBar.GONE
    status.text = "This item could not be prepared. Share one supported document or image up to 10 MB."
    done.visibility = Button.VISIBLE
  }

  private fun openUnionGround(pending: PendingShare) {
    if (cancelled || isFinishing || isDestroyed) {
      if (!discardStaged(pending)) showCleanupFailure()
      return
    }
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    if (launch == null) {
      if (discardStaged(pending)) showFailure() else showCleanupFailure()
      return
    }
    launch.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    launch.removeExtra(Intent.EXTRA_STREAM)
    launch.clipData = null
    try {
      handoffCommitted = true
      startActivity(launch)
      stagedTokens.clear()
      // MainActivity joins this task. Removing the task here would also destroy
      // the app before React can authorize or purge the staged attachment.
      finish()
    } catch (_: Exception) {
      handoffCommitted = false
      if (discardStaged(pending)) showFailure() else showCleanupFailure()
    }
  }

  private fun cancelShare(): Boolean {
    cancelled = true
    for (token in stagedTokens.toList()) {
      if (SecureShareStorage.discard(applicationContext, token)) {
        stagedTokens.remove(token)
      }
    }
    return stagedTokens.isEmpty()
  }

  private fun discardStaged(pending: PendingShare): Boolean {
    if (!SecureShareStorage.discard(applicationContext, pending.token)) {
      stagedTokens.add(pending.token)
      return false
    }
    stagedTokens.remove(pending.token)
    return true
  }

  private fun showCleanupFailure() {
    progress.visibility = ProgressBar.GONE
    status.text = "The temporary copy could not be cleared yet. Keep this screen open and try Done again."
    done.visibility = Button.VISIBLE
  }
}
