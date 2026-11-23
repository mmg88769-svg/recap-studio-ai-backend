# Recap Studio AI Backend

## WHK v0.28 staging prototype

This branch adds protected, isolated prototype routes to the existing Worker. The live production Worker is not changed by this branch.

- `GET /health` — staging version and boolean secret-readiness status
- `POST /api/transcribe-audio` — short AAC/MP4 audio clip transcription with clip-relative timestamps
- `POST /api/analyze-evidence` — chronological Burmese recap from timestamped transcript segments and up to eight sampled JPEG frames
- Existing `/api/generate`, `/api/tts`, and `/api/translate` routes remain in `worker.js`

The prototype uses **Gemini 2.5 Flash** for analysis to avoid the previously rate-limited preview model. No paid billing is enabled or required by this code. Free-tier quotas still apply; requests return a retryable 429 when quota/rate limits are reached.

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
