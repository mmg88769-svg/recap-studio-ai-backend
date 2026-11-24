# W.H.K v0.29 — Evidence-grounded story map

## What changed

- The evidence endpoint now requires a structured `story_map` before accepting a Burmese recap.
- The character ledger tracks stable IDs, names, supported roles, first-seen timestamps, and evidence references.
- The story arc records the opening, central conflict, supported turning points, climax, and resolution. Unsupported arc fields may remain empty.
- Each event records its supported cause, consequence, involved character IDs, timestamps, and evidence references.
- Server validation rejects unknown character references, duplicate character IDs, unsupported timestamps, and missing evidence fields.
- The response keeps the Android-consumed `narration_my`, `events`, `start_ms`, and `end_ms` fields; the added fields are additive.

## Important limitations

- The Android client still transcribes the full AAC audio track in 30-second chunks, but visual input remains limited to at most eight sampled still frames.
- This is not full-video visual understanding. A still frame cannot establish motion or prove an unseen action.
- The recap remains capped at 2,500 Unicode characters to preserve the current voice and export limits.
- The current Android cache check does not yet require `analysis_contract: story-map-v1`. An already cached analysis for the same video URI and duration may be reused without calling the upgraded backend. A later non-UI Android cache-version change is needed to guarantee re-analysis of old cached movies.

## Compatibility and rollout

- This branch is isolated from the existing staging deployment and production worker.
- No Android UI or APK code is changed in this step.
- Do not deploy until the feature-branch tests pass and the response contract is reviewed.
- The existing scene renderer continues to use event timestamps; it ignores the additional story-map fields.

## Response contract

- `analysis_contract`: `story-map-v1`
- `story_map.characters[]`: `id`, `name`, `role_my`, `first_seen_ms`, `evidence[]`
- `story_map.story_arc`: `opening_my`, `central_conflict_my`, `turning_points[]`, `climax_my`, `resolution_my`
- `events[]`: `start_ms`, `end_ms`, `summary_my`, `cause_my`, `consequence_my`, `character_ids[]`, `evidence[]`
- `narration_my`: natural Burmese narration, maximum 2,500 characters
