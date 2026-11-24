# W.H.K Movie Recap — v0.28 Recovery Audit (2026-11-23)

## Verified inputs
- The linked GitHub repository is `mmg88769-svg/recap-studio-ai-backend`, default branch `main`.
- `main/worker.js` identifies itself as v0.6. It provides text recap, translation and TTS, but **not** `/api/analyze-long-video`.
- A separately preserved v0.10 worker from earlier work accepts up to eight JPEG frames for `/api/analyze-video`; it explicitly does **not** analyze audio/dialogue.
- The Android APK supplied in the conversation is `app-debug.apk`. The exact Android source project is not in this backend repository.
- No production deployment or APK build has been performed as part of this audit.

## Required end-to-end behavior
1. Import a user-provided video.
2. Analyze **both** moving visuals and speech/dialogue (not just a few still frames). Preserve evidence and timestamps.
3. Produce a coherent, chronological Myanmar movie recap with no invented plot events.
4. Generate natural male/female narration, align chosen scenes to narration, and mix optional smart BGM.
5. Offer One Click Auto Recap and Advanced Edit, including subtitle/branding controls.
6. Run quality checks, flag uncertainty, allow review, then export playable MP4 in 9:16/16:9 and available resolution choices.
7. Preserve settings, use Gemini free-tier limits where feasible, and handle 429/quota errors without false success.

## Important architecture constraints
- Never expose `GEMINI_API_KEY` or `APP_TOKEN` in client apps or source control.
- Never claim that a visual-only analysis has listened to dialogue.
- Avoid sending entire long videos as base64 JSON through a Cloudflare Worker. Design an upload/segmentation/storage strategy with explicit size, privacy and cost limits.
- Keep the existing production Worker and `main` unchanged until separate tests and user acceptance.
- Do not assume a consumer Gemini subscription changes API free-tier quotas.

## Immediate implementation order
1. Locate the current Android source/build workflow (GitHub repos, release artifacts, or reconstruct from APK as needed).
2. Specify and test an evidence-backed multimodal analysis contract (timestamped scenes + transcript + confidence/uncertainty).
3. Implement staged backend endpoints on this development branch; add request validation, auth, safe error handling, rate limits and tests.
4. Integrate Android app, narration-to-video alignment and MP4 export.
5. Test on a short sample video and compare script/voice/MP4 with expected behavior.
6. Only after validation, build a test APK and request user phone testing.

This file is a recovery checkpoint, not evidence that these features have been implemented.
