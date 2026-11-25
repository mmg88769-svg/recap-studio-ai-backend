import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    project_id: str = os.getenv("PROJECT_ID") or os.getenv("GOOGLE_CLOUD_PROJECT", "")
    gcs_bucket: str = os.getenv("GCS_BUCKET", "")
    app_token: str = os.getenv("APP_TOKEN", "")
    signing_service_account_email: str = os.getenv("SIGNING_SERVICE_ACCOUNT_EMAIL", "")
    run_region: str = os.getenv("RUN_REGION", "us-central1")
    run_job_name: str = os.getenv("RUN_JOB_NAME", "myanmar-srt-worker")
    stt_location: str = os.getenv("STT_LOCATION", "us")
    stt_model: str = os.getenv("STT_MODEL", "chirp_3")
    gemini_location: str = os.getenv("GEMINI_LOCATION", "global")
    gemini_model: str = os.getenv("GEMINI_MODEL", "gemini-4-argon")
    gemini_thinking_level: str = os.getenv("GEMINI_THINKING_LEVEL", "HIGH")
    max_video_bytes: int = int(os.getenv("MAX_VIDEO_BYTES", str(2 * 1024 * 1024 * 1024)))
    max_video_duration_seconds: int = int(os.getenv("MAX_VIDEO_DURATION_SECONDS", "14400"))
    upload_url_ttl_minutes: int = int(os.getenv("UPLOAD_URL_TTL_MINUTES", "60"))
    job_collection: str = os.getenv("JOB_COLLECTION", "srt_jobs")


settings = Settings()
