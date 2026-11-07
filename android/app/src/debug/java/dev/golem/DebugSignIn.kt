package dev.golem

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * Signs a debug build in to a local Golem without Google, as the iOS tests seed the Keychain:
 * `adb shell am start -n dev.golem.android/dev.golem.DebugSignIn --es server http://localhost:3100 --es token <token>`.
 * Release builds do not have it.
 */
class DebugSignIn : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val session = (application as GolemApp).session
        intent.getStringExtra("server")?.let(session::setServer)
        intent.getStringExtra("token")?.let(session::finishSignIn)
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK))
        finish()
    }
}
