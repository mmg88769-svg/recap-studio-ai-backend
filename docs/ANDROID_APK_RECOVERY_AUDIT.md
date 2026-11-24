# Android APK recovery audit — 2026-11-23

## Evidence inspected directly
- Local user-provided file: `app-debug.apk`, about 15 MB, valid ZIP/APK.
- Contains `AndroidManifest.xml`, `classes.dex` through `classes5.dex`, native AndroidX libraries and shader assets.
- Embedded Gradle metadata: `androidGradlePluginVersion=8.13.2`.
- Repository `mmg88769-svg/RecapStudioAI` currently exposes a README, but conventional Android project paths `settings.gradle`, `app/build.gradle`, `gradlew` are absent on default branch.
- Direct ASCII URL scan across DEX files did not establish the application's API endpoint. This does NOT prove there is no endpoint: DEX strings may be encoded, split, or assembled at runtime.

## What can and cannot be recovered
An APK is compiled application output, not the original Android Studio project. Recovering resources and approximate decompiled code is possible, but is not equivalent to recovering the original Kotlin/Java source, Gradle setup, signing key, or exact build behavior.

## Safe next actions
1. Preserve the supplied APK as a reference and never overwrite it.
2. Inspect Android manifest/resources and DEX using an appropriate APK analyzer, without extracting credentials into GitHub.
3. Find the original Android source or build a separate clean Android project and integrate the tested backend behind a staging configuration.
4. Verify complete integration on an emulator/device and build a new installable APK; do not claim the existing APK has been updated.
5. Keep the production Cloudflare Worker unchanged until staging tests pass.

## Current status
No new APK built, no Android source recovered, no real Gemini request tested, and no staging deployment verified.
