# Android APK ↔ Backend API compatibility matrix (2026-11-23)

The uploaded app-debug.apk contains these route strings in classes3.dex (binary inspection), but that **does not** establish which URLs are used at runtime or whether the corresponding calls succeed.

| APK route | main/worker.js v0.6 | v0.28 experimental worker | Next requirement |
|---|---|---|---|
| POST /api/analyze-long-video | missing | missing | Determine Android request/response contract; implement authenticated job workflow |
| POST /api/upload-session | missing | missing | Define upload limits and storage/session lifecycle |
| GET /api/video-status | missing | missing | Define polling response and job expiry |
| POST /api/tts | present | not in prototype | Preserve and verify voice compatibility |
| POST /api/analyze-evidence | not present | present | Prototype only: client-supplied timestamped transcript and <=8 JPEG frames |

## Verified limits
- The prototype does not extract audio or transcribe speech itself. It requires the client to supply timestamped transcript segments.
- It does not accept or process complete video files.
- It does not create an MP4.
- It is not deployed to Cloudflare and has not been exercised against a real Gemini API.
- Existing production worker.js on main remains unchanged.

## Next technical checkpoint
Recover Android client request models, app URL configuration, and Android source/build pipeline; then implement a compatible upload/analyze/status workflow on a staging Worker. Do not redirect the existing APK to an incompatible prototype endpoint. Validate real API calls before attempting voice+MP4 synchronization.
