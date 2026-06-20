package expo.modules.knotvaultdir

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class KnotVaultDirModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("KnotVaultDir")

    // Returns a file:// URI to Android/data/<package>/files/vault/
    // (Context#getExternalFilesDir) — app-private but visible to file
    // managers and other apps without root, unlike the internal
    // documentDirectory sandbox. Creates the vault/ folder if missing.
    // Returns null if external storage isn't currently mounted/available
    // (e.g. removed SD card) — caller should fall back to documentDirectory.
    Function("getExternalVaultDir") {
      val context = appContext.reactContext ?: return@Function null
      val base = context.getExternalFilesDir(null) ?: return@Function null
      val vault = File(base, "vault")
      if (!vault.exists()) vault.mkdirs()
      "file://${vault.absolutePath}/"
    }
  }
}
