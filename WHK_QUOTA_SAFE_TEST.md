# W.H.K Movie Recap — safe Gemini model test (2026-11-23)

## State
This is a **development-only** branch. It does not deploy to Cloudflare and does not change the W.H.K Android APK.

- Parent: `feature/whk-video-analysis-v010` (includes Gemini Files upload, file status, and full-video analysis endpoint).
- Default text/video/recap model for this test branch: `gemini-2.5-flash`.
- Existing voice model default preserved: `gemini-3.8-flash-tts`; may need separate entitlement/capacity checks.
- Optional Cloudflare **non-secret** environment variables: `TEXT_MODEL`, `VOICE_MODEL`.
- Provider HTTP 429 is reported as HTTP 429 on translation, long-video analysis, recap, and TTS endpoints; other provider failures remain 502.
- Automated GitHub Actions checks validate JavaScript syntax and confirm the upload, status, long-analysis, and TTS routes still exist. They do **not** prove provider success.

## Critical cautions
1. The live `whk-movie-recap-staging` Worker is *not* updated or backed up by this repository branch. Before making any live changes, obtain and store the **exact live Worker source** or create a Cloudflare rollback version. Version `32956fd5` was shown active in user screenshot, but this is **not** a code-content checksum.
2. Do not point an existing live Worker at this source until its deployed route contracts, secrets, bindings, and upload flow are reviewed; live code may differ.
3. Never paste `GEMINI_API_KEY`, `APP_TOKEN`, Gemini upload URLs, or billing information into git, screenshots or chat.
4. A successful Playground response does not guarantee API Free Tier quota. Use a short authorized sample and an isolated staging Worker to test 2.5 Flash with the actual server key and project.
5. Preserve structured source timestamps and narration durations before advertising cinematic auto scene editing. Current video exporter is NOT an automatic scene selection engine.
6. Voice generation currently limits text to 1400 characters per request, and long recap scripts will still require chunking/stitching with timing validation.
7. When 429 persists, distinguish rate limits from exhausted quota; do not retry indefinitely or auto-switch models to bypass restrictions.

## Next acceptance checks (not yet executed)
- Safely copy current live Worker into a private rollback backup without leaking secrets.
- Deploy this test branch only to a **new isolated Worker** with a permitted test configuration.
- Test GET health and authenticated endpoints with **no** source token exposure.
- Test 10-second video upload -> ACTIVE file -> analysis using a permitted video clip.
- Confirm a 429 displays clearly in the Android app and does not claim success.
- Test recap script length, TTS response format, final media audio track and proper recap visuals.
- Compare outputs and errors. Only then consider controlled promotion to staging.
