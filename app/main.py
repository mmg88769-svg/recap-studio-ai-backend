import hmac
import re
import uuid
from datetime import timedelta
from pathlib import Path
from typing import Literal

import google.auth
from google.auth.transport.requests import AuthorizedSession, Request as GoogleAuthRequest
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import Response
from google.cloud import firestore, storage
from pydantic import BaseModel, ConfigDict, Field

from app.config import settings

app = FastAPI(title="Myanmar SRT API", version="1.0.0")


class CreateJobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    filename: str = Field(min_length=1, max_length=255)
    content_type: str = Field(min_length=3, max_length=120)
    size_bytes: int = Field(gt=0)
    source_language: str = Field(default="auto", max_length=32)
    target_language: Literal["my"] = "my"
    output_format: Literal["srt"] = "srt"


def require_app_token(authorization: str | None = Header(default=None)) -> None:
    expected = settings.app_token
    if not expected:
        raise HTTPException(status_code=503, detail="Server authentication is not configured.")
    scheme, separator, supplied = (authorization or "").partition(" ")
    if not separator or scheme.lower() != "bearer" or not hmac.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="Invalid or missing access token.")


def get_firestore() -> firestore.Client:
    return firestore.Client(project=settings.project_id or None)


def get_storage() -> storage.Client:
    return storage.Client(project=settings.project_id or None)


def safe_filename(value: str) -> str:
    name = Path(value.replace("\\\\", "/")).name
    name = re.sub(r"[^A-Za-z0-9._() -]", "_", name).strip(" .")
    return (name or "video.mp4")[:180]


def create_upload_url(blob: storage.Blob, content_type: str) -> str:
    if not settings.signing_service_account_email:
        raise RuntimeError("SIGNING_SERVICE_ACCOUNT_EMAIL is not configured.")

    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )
    credentials.refresh(GoogleAuthRequest())
    return blob.generate_signed_url(
        version="v4",
        expiration=timedelta(minutes=settings.upload_url_ttl_minutes),
        method="PUT",
        content_type=content_type,
        service_account_email=settings.signing_service_account_email,
        access_token=credentials.token,
    )


def start_worker_execution(job_id: str) -> str | None:
    if not settings.project_id:
        raise RuntimeError("PROJECT_ID is not configured.")

    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )
    session = AuthorizedSession(credentials)
    job_resource = (
        f"projects/{settings.project_id}/locations/{settings.run_region}"
        f"/jobs/{settings.run_job_name}"
    )
    url = f"https://run.googleapis.com/v2/{job_resource}:run"
    payload = {
        "overrides": {
            "containerOverrides": [
                {"env": [{"name": "JOB_ID", "value": job_id}]}
            ],
            "taskCount": 1,
        }
    }
    response = session.post(url, json=payload, timeout=30)
    if not response.ok:
        raise RuntimeError(f"Could not start processing job (Cloud Run returned {response.status_code}).")
    return response.json().get("name")


@app.get("/health")
def health() -> dict:
    return {"status": "online", "service": "myanmar-srt-api", "version": "1.0.0"}


@app.post("/api/srt/jobs", status_code=201, dependencies=[Depends(require_app_token)])
def create_srt_job(payload: CreateJobRequest) -> dict:
    if not settings.project_id or not settings.gcs_bucket:
        raise HTTPException(status_code=503, detail="Cloud Storage is not configured.")
    if payload.size_bytes > settings.max_video_bytes:
        raise HTTPException(status_code=413, detail="Video file exceeds the configured upload limit.")
    if not (payload.content_type.startswith("video/") or payload.content_type == "application/octet-stream"):
        raise HTTPException(status_code=415, detail="Please select a supported video file.")

    job_id = uuid.uuid4().hex
    filename = safe_filename(payload.filename)
    object_name = f"jobs/{job_id}/source/{filename}"
    blob = get_storage().bucket(settings.gcs_bucket).blob(object_name)

    try:
        upload_url = create_upload_url(blob, payload.content_type)
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Could not prepare secure video upload.") from exc

    job = {
        "job_id": job_id,
        "filename": filename,
        "content_type": payload.content_type,
        "size_bytes": payload.size_bytes,
        "source_language": payload.source_language,
        "target_language": payload.target_language,
        "output_format": payload.output_format,
        "source_object": object_name,
        "status": "upload_pending",
        "progress": 0,
        "stage": "Video upload is ready.",
        "error": None,
        "created_at": firestore.SERVER_TIMESTAMP,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }
    get_firestore().collection(settings.job_collection).document(job_id).set(job)

    return {
        "job_id": job_id,
        "status": "upload_pending",
        "upload": {
            "method": "PUT",
            "url": upload_url,
            "headers": {"Content-Type": payload.content_type},
        },
    }


@app.post(
    "/api/srt/jobs/{job_id}/complete",
    status_code=202,
    dependencies=[Depends(require_app_token)],
)
def complete_srt_upload(job_id: str) -> dict:
    db = get_firestore()
    job_ref = db.collection(settings.job_collection).document(job_id)
    snapshot = job_ref.get()
    if not snapshot.exists:
        raise HTTPException(status_code=404, detail="SRT job was not found.")

    job = snapshot.to_dict() or {}
    status = job.get("status", "")
    if status in {"queued", "processing", "completed"}:
        return {"job_id": job_id, "status": status}

    if status != "upload_pending":
        raise HTTPException(status_code=409, detail="This SRT job cannot be started.")

    blob = get_storage().bucket(settings.gcs_bucket).blob(job["source_object"])
    try:
        blob.reload()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Video upload is not complete or the file is missing.") from exc

    if int(blob.size or 0) != int(job.get("size_bytes", -1)):
        raise HTTPException(status_code=400, detail="Uploaded video size does not match the requested file size.")

    job_ref.update({
        "status": "queued",
        "progress": 1,
        "stage": "Video uploaded. Waiting for the AI worker.",
        "updated_at": firestore.SERVER_TIMESTAMP,
    })

    try:
        execution_name = start_worker_execution(job_id)
        if execution_name:
            job_ref.update({"execution_name": execution_name, "updated_at": firestore.SERVER_TIMESTAMP})
    except Exception as exc:
        job_ref.update({
            "status": "failed",
            "error": "The processing service could not be started.",
            "stage": "Processing could not be started.",
            "updated_at": firestore.SERVER_TIMESTAMP,
        })
        raise HTTPException(status_code=503, detail="The processing service could not be started.") from exc

    return {"job_id": job_id, "status": "queued"}


@app.get(
    "/api/srt/jobs/{job_id}",
    dependencies=[Depends(require_app_token)],
)
def get_srt_job(job_id: str) -> dict:
    snapshot = get_firestore().collection(settings.job_collection).document(job_id).get()
    if not snapshot.exists:
        raise HTTPException(status_code=404, detail="SRT job was not found.")
    job = snapshot.to_dict() or {}
    return {
        "job_id": job_id,
        "status": job.get("status", "failed"),
        "progress": int(job.get("progress", 0)),
        "stage": job.get("stage", ""),
        "error": job.get("error"),
    }


@app.get(
    "/api/srt/jobs/{job_id}/download",
    dependencies=[Depends(require_app_token)],
)
def download_srt(job_id: str) -> Response:
    snapshot = get_firestore().collection(settings.job_collection).document(job_id).get()
    if not snapshot.exists:
        raise HTTPException(status_code=404, detail="SRT job was not found.")
    job = snapshot.to_dict() or {}
    if job.get("status") != "completed" or not job.get("srt_object"):
        raise HTTPException(status_code=409, detail="The SRT file is not ready yet.")

    blob = get_storage().bucket(settings.gcs_bucket).blob(job["srt_object"])
    try:
        content = blob.download_as_bytes()
    except Exception as exc:
        raise HTTPException(status_code=503, detail="The generated SRT file could not be read.") from exc

    filename = safe_filename(Path(job.get("filename", "subtitle.mp4")).stem + ".srt")
    return Response(
        content=content,
        media_type="text/plain; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "private, no-store",
        },
    )
