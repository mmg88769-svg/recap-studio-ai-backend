# W.H.K v0.29 — Evidence-grounded story map

## What changed

- The evidence endpoint now requires a structured `story_map` before accepting a Burmese recap.
- The endpoint accepts either timestamped audio transcript segments, sampled video frames, or both. When no usable audio transcript exists, it switches to a visual-only recap mode.
- The character ledger tracks stable IDs, names, supported roles, first-seen timestamps, and evidence references.
- The story arc records the opening, central conflict, supported turning points, climax, and resolution. Unsupported arc fields may remain empty.
- Each event records its supported cause, consequence, involved character IDs, timestamps, and evidence references.
- Server validation rejects unknown character references, duplicate character IDs, unsupported timestamps, and missing evidence fields.
- The response keeps the Android-consumed `narration_my`, `events`, `start_ms`, and `end_ms` fields; the added fields are additive.

## Important limitations

- The Android client still transcribes the full AAC audio track in 30-second chunks, but visual input remains limited to at most eight sampled still frames.
- This is not full-video visual understanding. A still frame cannot establish motion or prove an unseen action.
- Visual-only mode currently relies on up to eight sampled still frames. It can produce a cautious visual recap, but it cannot reliably reconstruct complex plots, dialogue, or off-screen events without audio evidence.
- The narration is capped at 1,400 characters to match the existing Android voice-generation limit.
- The Android cache-version and response-contract integration is being implemented separately in `RecapStudioAI` PR #4. Until that PR is merged and its APK is installed, older cached results may still be reused.

## Compatibility and rollout

- This branch is isolated from the existing staging deployment and production worker.
- No Android UI is redesigned. The Android integration is a separate feature branch/PR; no APK has been released.
- Do not deploy until the feature-branch tests pass and the response contract is reviewed.
- The existing scene renderer continues to use event timestamps; it ignores the additional story-map fields.

## Response contract

- `analysis_contract`: `story-map-v1`
- `evidence_mode`: `audio_and_visual` or `visual_only`
- `story_map.characters[]`: `id`, `name`, `role_my`, `first_seen_ms`, `evidence[]`
- `story_map.story_arc`: `opening_my`, `central_conflict_my`, `turning_points[]`, `climax_my`, `resolution_my`
- `events[]`: `start_ms`, `end_ms`, `summary_my`, `cause_my`, `consequence_my`, `character_ids[]`, `evidence[]`
- `narration_my`: natural Burmese narration, maximum 1,400 characters
