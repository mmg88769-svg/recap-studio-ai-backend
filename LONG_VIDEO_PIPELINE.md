# W.H.K Movie Recap long-video pipeline — development design

## Current status
- Legacy sampled-JPEG `/api/analyze-video` endpoint has been removed from this development branch because still images are insufficient for the requested full-movie recap.
- Draft branch has POST /api/analyze-long-video accepting an ACTIVE Gemini Files API video file URI. The endpoint sends the VIDEO AND AUDIO file to Gemini for a scene timeline and recap script.
- Android v0.11 source now has a draft upload-session -> direct resumable upload -> file-status -> long-video-analysis flow. **Not built, deployed, or validated** against live Gemini. Do not describe it as a finished app feature.
- Existing production worker is not modified/deployed by this branch.

## Immediate production work
1. Android draft: local MP4 import, size validation <=500 MB, upload progress and streaming from ContentResolver without loading the whole video into RAM. Verify on a real phone; handle interrupted uploads in the next iteration.
2. Secure resumable upload for large videos to Gemini Files API through a protected backend workflow, or a private R2 bucket with short-lived signed URLs and Gemini HTTPS file inputs. Do not expose GEMINI_API_KEY to clients.
3. Poll file PROCESSING / ACTIVE / FAILED. Only call /api/analyze-long-video with an ACTIVE URI obtained securely.
4. For 30-minute videos, validate model context and video size limits; request visual+audio temporal scene timeline with timestamps then draft recap.
5. For feature films that exceed limits, split at scene/time boundaries, process chunks independently, then make a global chronological synthesis. Preserve source timecodes and uncertainty; do not invent missing events.
6. Review script before TTS; generate narration; map narration sections to the actual scene timeline; render only user-selected edits; enable final preview and MP4/MP3 save.
7. Security: validate formats, enforce duration/size/quota ceilings and rate limits, delete expired uploads, avoid logging media/credentials. Support only footage user may process.
8. Acceptance tests: 30-second video; 30-minute video with dialogue; feature-length divided into chunks; both languages and silent footage; verify chronology and timestamps; check TTS/translation still works after deploy.

## JSON contract for prepared-video route
POST /api/analyze-long-video
Authorization: Bearer APP_TOKEN
Content-Type: application/json

{
  "file_uri": "https://generativelanguage.googleapis.com/v1beta/files/FILE_ID",
  "mime_type": "video/mp4",
  "language": "my"
}

The route intentionally does not accept the full video binary. It requires a separate authenticated upload orchestration.

## Documentation
- https://ai.google.dev/gemini-api/docs/video-understanding
- https://developers.cloudflare.com/r2/objects/upload-objects/
- https://developers.cloudflare.com/workers/platform/limits/

## v0.11 draft endpoint sequence
1. POST /api/upload-session {size_bytes,mime_type} with APP_TOKEN => {upload_url}
2. Android streams bytes via POST upload_url, X-Goog-Upload-Offset:0, X-Goog-Upload-Command:upload, finalize
3. POST /api/video-status {file_name} until ACTIVE, receive file_uri
4. POST /api/analyze-long-video {file_uri,mime_type,language} => script

Current beta limit: 500 MB and no resume-after-disconnect UI. No automatic chunking for a feature film yet.
