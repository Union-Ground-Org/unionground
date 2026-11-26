package expo.modules.secureshareintake

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

internal data class PendingShare(
  val token: String,
  val uri: String,
  val filename: String,
  val mimeType: String,
  val sizeBytes: Long,
  val createdAtMs: Long,
) {
  fun toMap(): Map<String, Any> = mapOf(
    "token" to token,
    "uri" to uri,
    "filename" to filename,
    "mimeType" to mimeType,
    "sizeBytes" to sizeBytes.toDouble(),
    "createdAtMs" to createdAtMs.toDouble(),
  )
}

internal data class PendingShareStageOutcome(
  val pending: PendingShare?,
  val cleanupTokens: List<String>,
) {
  val cleanupConfirmed: Boolean
    get() = cleanupTokens.isEmpty()
}

internal object SecureShareStorage {
  private const val ROOT_NAME = "secure-share-intake"
  private const val MANIFEST_NAME = "manifest.json"
  private const val PAYLOAD_NAME = "payload"
  private const val MAX_BYTES = 10L * 1024L * 1024L
  private const val MAX_AGE_MS = 5L * 60L * 1000L
  private const val FUTURE_SKEW_MS = 30L * 1000L
  private const val BUFFER_BYTES = 32 * 1024

  private val mimeExtension = mapOf(
    "application/pdf" to "pdf",
    "image/jpeg" to "jpg",
    "image/png" to "png",
    "image/webp" to "webp",
    "text/plain" to "txt",
    "text/csv" to "csv",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document" to "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" to "xlsx",
  )

  @Synchronized
  fun stageFromIntent(context: Context, intent: Intent): PendingShareStageOutcome? {
    if (intent.action != Intent.ACTION_SEND || intent.hasExtra(Intent.EXTRA_TEXT)) return null
    if (intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION == 0) return null
    val declaredMime = intent.type?.trim()?.lowercase() ?: return null
    val uri = oneContentUri(intent) ?: return null
    val resolver = context.contentResolver
    val providerMime = try { resolver.getType(uri)?.trim()?.lowercase() } catch (_: Exception) { return null }
    if (providerMime != declaredMime) return null
    // Compare the raw sender/provider declarations before canonicalizing CSV.
    val canonicalMime = if (declaredMime == "text/comma-separated-values") "text/csv" else declaredMime
    if (!mimeExtension.containsKey(canonicalMime)) return null

    val metadata = queryMetadata(resolver, uri)
    if (metadata.second != null && (metadata.second!! < 1L || metadata.second!! > MAX_BYTES)) return null
    val filename = safeFilename(metadata.first, canonicalMime)
    val token = UUID.randomUUID().toString()
    val createdAtMs = System.currentTimeMillis()
    val root = root(context)
    val cleanupTokens = captureCleanupTokens(context)
    for (existingToken in cleanupTokens) {
      if (!discard(context, existingToken)) {
        return PendingShareStageOutcome(null, cleanupTokens)
      }
    }
    if (!root.mkdirs() && !root.isDirectory) return null
    val entry = File(root, token)
    if (!entry.mkdir()) return null
    val payload = File(entry, PAYLOAD_NAME)

    return try {
      val size = copyBounded(resolver, uri, payload) ?: throw IllegalStateException()
      val manifest = JSONObject()
        .put("version", 1)
        .put("token", token)
        .put("filename", filename)
        .put("mimeType", canonicalMime)
        .put("sizeBytes", size)
        .put("createdAtMs", createdAtMs)
      val manifestFile = File(entry, MANIFEST_NAME)
      FileOutputStream(manifestFile).use { output ->
        output.write(manifest.toString().toByteArray(Charsets.UTF_8))
        output.fd.sync()
      }
      restrictToOwner(entry, payload, manifestFile)
      PendingShareStageOutcome(
        PendingShare(token, Uri.fromFile(payload).toString(), filename, canonicalMime, size, createdAtMs),
        emptyList(),
      )
    } catch (_: Exception) {
      PendingShareStageOutcome(null, if (deleteVerified(entry)) emptyList() else listOf(token))
    }
  }

  @Synchronized
  fun captureCleanupTokens(context: Context): List<String> {
    val root = root(context)
    if (!root.exists()) return emptyList()
    val entries = root.listFiles() ?: throw IllegalStateException("Secure share snapshot failed")
    return entries.map { entry ->
      if (!entry.isDirectory || !isDirectChild(root, entry)) {
        throw IllegalStateException("Secure share snapshot failed")
      }
      val token = try { UUID.fromString(entry.name).toString() } catch (_: Exception) {
        throw IllegalStateException("Secure share snapshot failed")
      }
      if (entry.name != token) throw IllegalStateException("Secure share snapshot failed")
      token
    }.sorted()
  }

  @Synchronized
  fun getPending(context: Context): PendingShare? {
    val root = root(context)
    val now = System.currentTimeMillis()
    val entries = root.listFiles()?.filter { it.isDirectory } ?: return null
    var selected: PendingShare? = null
    for (entry in entries) {
      val pending = readEntry(root, entry, now)
      if (pending == null) {
        if (!deleteVerified(entry)) throw IllegalStateException("Secure share cleanup failed")
      } else if (selected == null || pending.createdAtMs > selected.createdAtMs) {
        selected?.let {
          if (!discard(context, it.token)) throw IllegalStateException("Secure share cleanup failed")
        }
        selected = pending
      } else {
        if (!deleteVerified(entry)) throw IllegalStateException("Secure share cleanup failed")
      }
    }
    return selected
  }

  @Synchronized
  fun discard(context: Context, token: String): Boolean {
    val parsed = try { UUID.fromString(token).toString() } catch (_: Exception) { return false }
    val root = root(context)
    val entry = File(root, parsed)
    if (!isDirectChild(root, entry)) return false
    return deleteVerified(entry)
  }

  private fun oneContentUri(intent: Intent): Uri? {
    val uris = linkedSetOf<Uri>()
    intent.clipData?.let { clip ->
      if (clip.itemCount != 1) return null
      clip.getItemAt(0).uri?.let(uris::add)
    }
    @Suppress("DEPRECATION")
    intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let(uris::add)
    return uris.singleOrNull()?.takeIf { it.scheme == ContentResolver.SCHEME_CONTENT }
  }

  private fun queryMetadata(resolver: ContentResolver, uri: Uri): Pair<String?, Long?> {
    return try {
      resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        if (!cursor.moveToFirst()) return Pair(null, null)
        val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
        val name = if (nameIndex >= 0 && !cursor.isNull(nameIndex)) cursor.getString(nameIndex) else null
        val size = if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) cursor.getLong(sizeIndex) else null
        Pair(name, size)
      } ?: Pair(null, null)
    } catch (_: Exception) {
      Pair(null, null)
    }
  }

  private fun safeFilename(providerName: String?, mimeType: String): String {
    val expectedExtension = mimeExtension.getValue(mimeType)
    val value = providerName?.trim().orEmpty()
    val allowedExtensions = if (mimeType == "image/jpeg") setOf("jpg", "jpeg") else setOf(expectedExtension)
    val safe = value.length in 1..160
      && value.none { it == '/' || it == '\\' || it.code < 32 || it.code == 127 }
      && value.substringAfterLast('.', "").lowercase() in allowedExtensions
    return if (safe) value else "shared-document.$expectedExtension"
  }

  private fun copyBounded(resolver: ContentResolver, uri: Uri, destination: File): Long? {
    val input = resolver.openInputStream(uri) ?: return null
    return input.use { source ->
      FileOutputStream(destination).use { output ->
        val buffer = ByteArray(BUFFER_BYTES)
        var total = 0L
        while (true) {
          val count = source.read(buffer)
          if (count < 0) break
          if (count == 0) continue
          total += count
          if (total > MAX_BYTES) return null
          output.write(buffer, 0, count)
        }
        if (total < 1L) return null
        output.fd.sync()
        total
      }
    }
  }

  private fun readEntry(root: File, entry: File, now: Long): PendingShare? {
    if (!isDirectChild(root, entry)) return null
    val manifestFile = File(entry, MANIFEST_NAME)
    val payload = File(entry, PAYLOAD_NAME)
    if (!manifestFile.isFile || !payload.isFile) return null
    return try {
      val manifest = JSONObject(manifestFile.readText(Charsets.UTF_8))
      if (manifest.optInt("version") != 1) return null
      val token = UUID.fromString(manifest.getString("token")).toString()
      if (token != entry.name) return null
      val createdAtMs = manifest.getLong("createdAtMs")
      if (createdAtMs > now + FUTURE_SKEW_MS || now - createdAtMs > MAX_AGE_MS) return null
      val mimeType = manifest.getString("mimeType")
      if (!mimeExtension.containsKey(mimeType)) return null
      val filename = safeFilename(manifest.getString("filename"), mimeType)
      if (filename != manifest.getString("filename")) return null
      val size = manifest.getLong("sizeBytes")
      if (size !in 1L..MAX_BYTES || payload.length() != size) return null
      PendingShare(token, Uri.fromFile(payload).toString(), filename, mimeType, size, createdAtMs)
    } catch (_: Exception) {
      null
    }
  }

  private fun restrictToOwner(vararg files: File) {
    files.forEach { file ->
      file.setReadable(false, false)
      file.setWritable(false, false)
      file.setExecutable(false, false)
      file.setReadable(true, true)
      file.setWritable(true, true)
      if (file.isDirectory) file.setExecutable(true, true)
    }
  }

  private fun root(context: Context) = File(context.cacheDir, ROOT_NAME)

  private fun deleteVerified(file: File): Boolean = !file.exists()
    || (file.deleteRecursively() && !file.exists())

  private fun isDirectChild(root: File, child: File): Boolean = try {
    child.canonicalFile.parentFile == root.canonicalFile
  } catch (_: Exception) {
    false
  }
}
