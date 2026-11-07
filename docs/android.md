# The Android app

The Android app in `android/` gives a person the same Golem as the iPhone app, in Android's own idioms. It is a Kotlin
app with Jetpack Compose and Material 3, and it uses only the JSON API of [api.md](api.md). You build it yourself and
install it on your family's phones; it is not in Google Play.

## What you need

- Android 13 (API 33) or later. The minimum keeps one code path for the notification permission, the photo picker,
  and the per-app media permissions, which Android 13 brought; most phones in use have it.
- Chrome, or another browser with Auth Tabs, for the Google sign-in.
- Google Play services, for the geofences of reminders and routines at a place.
- On the computer: JDK 17 and the Android SDK command-line tools. On a Mac:

```sh
brew install openjdk@17 android-commandlinetools
sdkmanager "platform-tools" "platforms;android-37.0" "build-tools;36.0.0"
```

## Build and install

```sh
cd android
echo "sdk.dir=$(brew --prefix)/share/android-commandlinetools" > local.properties
export JAVA_HOME=$(brew --prefix)/opt/openjdk@17
./gradlew :app:assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:installDebug         # on the phone that adb sees (USB debugging on)
./gradlew :app:testDebugUnitTest    # the unit tests
```

`android/local.properties`, which git ignores, can also hold `golem.serverUrl=https://golem.example.com`, the address
the sign-in screen starts with, and `golem.applicationId`, when you want another package name.

### A release build

A release build is signed with your own key. Make one once and keep it safe; every update must have the same key:

```sh
keytool -genkeypair -v -keystore golem.jks -alias golem -keyalg RSA -keysize 4096 -validity 10000
```

Put the key in `android/` and its values in `android/keystore.properties`, which git ignores:

```properties
storeFile=golem.jks
storePassword=…
keyAlias=golem
keyPassword=…
```

Then `./gradlew :app:assembleRelease` makes `app/build/outputs/apk/release/app-release.apk`; install it with
`adb install` or open it on the phone.

## Sign-in

The app signs in as the iPhone app does: Google in an Auth Tab, with PKCE, and the token in the Android Keystore. The
Auth Tab returns to the server's https address only for an app that the server's Digital Asset Links name, so add the
app to `config/golem.toml` and restart Golem:

```toml
[android]
package = "dev.golem.android"
cert_sha256 = ["AB:CD:…"]
```

`cert_sha256` holds the SHA-256 fingerprint of each key that signs the app: `keytool -list -v -keystore golem.jks`
for the release key, and `keytool -list -v -keystore ~/.android/debug.keystore -storepass android` for debug builds.
Check `https://<server>/.well-known/assetlinks.json` afterwards.

The app accepts only an https server, or `localhost`, as the iPhone app does.

## Notifications

Golem sends pushes only through APNs, so the Android app has no pushes yet. While the app runs, it follows the event
streams and shows each new unread notification as a notification of the phone; a tap opens its thread. When Android
stops the app in the background, notifications wait in Activity.

## Phone tools

While the app is open, it answers the agents' `phone_*` tools as the iPhone app does, with the same names, arguments,
and answers. Android cannot do some of them, and those answer with an error that says why:

- Reminders (`reminder_*`): Android has no reminders store that other apps can use. Agents use Golem's own reminders
  or the calendar.
- Home (`home`, `home_scene`, `home_power`) and `wallet_add`: Apple Home and Wallet are only on the iPhone.
- `alarm_set` with a date sets an alarm only within the next 24 hours, `alarms` lists only the alarms that Golem set,
  and timers do not pause or resume: the Clock app takes alarms only by the time of day and lets no app read them.
- `message`, `mail`, and `call` open the app, and cannot tell whether the person sent or called.

Health Connect gives the health metrics, and the photo, camera, contacts, calendar, location, music, and device tools
use Android's own providers.

## Try it on an emulator

`test/harness.ts` gives a signed-in Golem with invented data. A script outside the repository can start it, add
channels and threads, and serve `golem.handler` with `Bun.serve` on port 3100, with the request's `Origin` header
changed to `http://golem.test` and `idleTimeout: 0` for the event streams. Then:

```sh
sdkmanager "emulator" "system-images;android-36;google_apis_playstore;arm64-v8a"
avdmanager create avd -n golem -k "system-images;android-36;google_apis_playstore;arm64-v8a" -d pixel_8
emulator -avd golem &
adb reverse tcp:3100 tcp:3100
./gradlew :app:installDebug
adb shell am start -n dev.golem.android/dev.golem.DebugSignIn --es server http://localhost:3100 --es token <token>
```

`DebugSignIn` is only in debug builds: it keeps the server and a session token, as the iOS tests seed the Keychain.
`adb shell cmd uimode night yes` switches to the dark theme, and `adb exec-out screencap -p > screen.png` takes a
screenshot.

## Code

- `api/`: the API client (OkHttp and kotlinx.serialization), the models, and `Session`, which holds the signed-in
  person and the open workspace as Compose state.
- `design/`: `Tokens.kt`, which `bun run tokens` writes from `design/tokens.json`, and the components of
  `design/components.md` in Compose.
- `views/`: the screens. `PhoneShell` holds the bottom bar and a Navigation 3 back stack for each tab.
- `voice/`: dictation with Android's speech recognition.
- `phone/`, `places/`, and `share/`: the phone tools, the places that start reminders and routines, and the share
  target.
