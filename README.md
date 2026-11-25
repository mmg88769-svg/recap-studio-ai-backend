# Myanmar SRT Backend

Cloud Run API and worker for generating Burmese SRT subtitles from uploaded video files.

## Architecture

- FastAPI on Cloud Run provides the mobile API.
- Google Cloud Storage stores uploaded videos, extracted audio chunks, and final SRT files.
- Firestore stores job state and real progress.
- A Cloud Run Job performs video/audio processing asynchronously.
- FFmpeg extracts mono 16 kHz audio.
- Cloud Speech-to-Text V2 Chirp 3 performs automatic-language transcription with word timestamps.
- Gemini 3.8 Flash on the Agent Platform global endpoint translates dialogue into Burmese.
- The worker validates timestamps and SRT structure before marking a job complete.

## Android API contract

The endpoints match the Android app's docs/backend-api-contract.md:

- POST /api/srt/jobs
- PUT the returned upload URL
- POST /api/srt/jobs/{job_id}/complete
- GET /api/srt/jobs/{job_id}
- GET /api/srt/jobs/{job_id}/download

All application API calls require Authorization: Bearer APP_TOKEN. The signed Storage URL is used only for the video upload and does not receive APP_TOKEN.

## AI model defaults

- Speech recognition: Chirp 3, model ID chirp_3, Speech-to-Text V2 multi-region us.
- Source language: auto.
- Target language: Burmese (my).
- Translation: gemini-3.8-flash, Agent Platform global endpoint.

The model choices are configurable through environment variables. Actual accuracy must be measured on representative Burmese, English, Chinese, Korean, Japanese, and Thai movie clips; no model can guarantee perfect transcription or translation.

## Local tests

    pip install -r requirements.txt
    pytest -q

## Google Cloud deployment

See docs/google-cloud-setup.md. Do not put API keys, service-account JSON files, or APP_TOKEN in this repository or in the APK.
