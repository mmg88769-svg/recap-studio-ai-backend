# Recap Studio AI Backend

## WHK v0.28 staging prototype

This branch adds protected, isolated prototype routes to the existing Worker. The live production Worker is not changed by this branch.

- `GET /health` — staging version and boolean secret-readiness status
- `POST /api/transcribe-audio` — short AAC/MP4 audio clip transcription with clip-relative timestamps
- `POST /api/analyze-evidence` — chronological Burmese recap from timestamped transcript segments and up to eight sampled JPEG frames
- `POST /api/tts` — Burmese narrator WAV using Gemini 3.8 Flash TTS (Free Tier)
- Existing `/api/generate`, `/api/tts`, and `/api/translate` routes remain in `worker.js`

The prototype uses **Gemini 3.8 Flash** for audio transcription and transcript-plus-frame recap analysis, and **Gemini 3.8 Flash TTS** for Burmese narration. Gemini 2.5 Flash access is restricted to existing users who actively used it in the past, so new projects should migrate. Google currently lists Gemini 3.8 Flash and Gemini 3.8 Flash TTS with Free Tier access; quota/rate limits still apply. No paid billing is enabled or required by this code. Transient provider 5xx/network failures are retried up to three attempts with short backoff; If Gemini 3.8 Flash remains overloaded (HTTP 503) after up to three attempts, audio transcription and evidence-based recap make one fallback attempt using free-tier multimodal Gemini 3.5 Flash-Lite. Responses report the actual model and fallback_used. Free Tier 429 quota responses are returned without retries or model fallback to avoid wasting quota. Fallback output quality and availability are not guaranteed.

## Staging deployment

The staging Worker name is `whk-movie-recap-staging`, configured in `wrangler.toml`. Its expected Workers.dev endpoint is:

`https://whk-movie-recap-staging.mmg88769.workers.dev`

The `deploy-staging` job runs only on pushes to `dev/whk-recap-video-audio-v028`, after the test job succeeds. It requires GitHub Actions repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The staging Worker must also have Cloudflare Worker secrets configured:

- `GEMINI_API_KEY` — Gemini API key (Free Tier only)
- `APP_TOKEN` — random app-to-backend bearer token

Never put either secret in source code or in the APK. The Android prototype stores the user-provided `APP_TOKEN` encrypted using Android Keystore; the Gemini key stays on the Worker.

## Android prototype request behavior

The Android development branch extracts 30-second AAC chunks, transcribes them sequentially with a 4-second gap between calls, and saves completed transcript progress locally so completed chunks are not repeatedly sent after a quota interruption. It then submits the merged timestamped transcript plus at most eight sampled frames for recap generation.

This is a development prototype, not a guarantee that every movie will complete within Free Tier quotas. The visual input is sparse sampling, not full-frame visual understanding. Unsupported/non-AAC movie audio is rejected rather than silently misprocessed.

## Validation

The GitHub Actions workflow runs:
- Worker routing, auth, schema, evidence and quota tests
- Audio extraction/transcription tests
- Timeline merge and scene planning tests
- FFmpeg scene-cut, narration mux and offline rendering tests

The Python/FFmpeg renderer is a backend test/prototype and is not yet deployed as a Cloudflare Worker endpoint or wired as the Android final scene renderer.
