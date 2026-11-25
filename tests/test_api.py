from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import main


class FakeSnapshot:
    def __init__(self, data):
        self._data = data
        self.exists = data is not None

    def to_dict(self):
        return self._data


class FakeDocument:
    def __init__(self):
        self.data = None

    def set(self, data):
        self.data = dict(data)

    def get(self):
        return FakeSnapshot(self.data)

    def update(self, fields):
        if self.data is None:
            raise AssertionError("Cannot update a missing fake document.")
        self.data.update(fields)


class FakeCollection:
    def __init__(self):
        self.documents = {}

    def document(self, document_id):
        return self.documents.setdefault(document_id, FakeDocument())


class FakeFirestore:
    def __init__(self):
        self.collections = {}

    def collection(self, name):
        return self.collections.setdefault(name, FakeCollection())


class FakeBlob:
    def __init__(self, name):
        self.name = name
        self.size = None
        self.content = b""

    def reload(self):
        if self.size is None:
            raise FileNotFoundError(self.name)

    def download_as_bytes(self):
        return self.content


class FakeBucket:
    def __init__(self):
        self.blobs = {}

    def blob(self, name):
        return self.blobs.setdefault(name, FakeBlob(name))


class FakeStorage:
    def __init__(self):
        self.fake_bucket = FakeBucket()

    def bucket(self, name):
        assert name == "test-bucket"
        return self.fake_bucket


@pytest.fixture
def api(monkeypatch):
    db = FakeFirestore()
    storage = FakeStorage()
    monkeypatch.setattr(
        main,
        "settings",
        SimpleNamespace(
            app_token="test-token",
            project_id="test-project",
            gcs_bucket="test-bucket",
            max_video_bytes=1_000_000,
            job_collection="srt_jobs",
        ),
    )
    monkeypatch.setattr(main, "get_firestore", lambda: db)
    monkeypatch.setattr(main, "get_storage", lambda: storage)
    monkeypatch.setattr(main, "create_upload_url", lambda blob, content_type: "https://upload.example/signed")
    monkeypatch.setattr(main, "start_worker_execution", lambda job_id: "execution/test")
    with TestClient(main.app) as client:
        yield client, db, storage


def auth_headers():
    return {"Authorization": "Bearer test-token"}


def create_payload(**overrides):
    payload = {
        "filename": "movie.mp4",
        "content_type": "video/mp4",
        "size_bytes": 1234,
        "source_language": "auto",
        "target_language": "my",
        "output_format": "srt",
    }
    payload.update(overrides)
    return payload


def test_health_endpoint_does_not_require_app_token(api):
    client, _, _ = api
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "online"


def test_create_job_requires_valid_bearer_token(api):
    client, _, _ = api
    response = client.post("/api/srt/jobs", json=create_payload())
    assert response.status_code == 401


def test_create_job_matches_android_upload_contract(api):
    client, db, storage = api
    response = client.post(
        "/api/srt/jobs",
        json=create_payload(),
        headers=auth_headers(),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "upload_pending"
    assert body["upload"]["method"] == "PUT"
    assert body["upload"]["url"] == "https://upload.example/signed"
    assert body["upload"]["headers"]["Content-Type"] == "video/mp4"

    job = db.collection("srt_jobs").document(body["job_id"]).data
    assert job["status"] == "upload_pending"
    assert job["size_bytes"] == 1234
    assert storage.fake_bucket.blob(job["source_object"]).name == job["source_object"]


def test_create_job_rejects_oversized_video(api):
    client, _, _ = api
    response = client.post(
        "/api/srt/jobs",
        json=create_payload(size_bytes=1_000_001),
        headers=auth_headers(),
    )
    assert response.status_code == 413


def test_complete_upload_verifies_object_and_queues_worker(api):
    client, db, storage = api
    created = client.post(
        "/api/srt/jobs",
        json=create_payload(),
        headers=auth_headers(),
    )
    job_id = created.json()["job_id"]
    job = db.collection("srt_jobs").document(job_id).data
    storage.fake_bucket.blob(job["source_object"]).size = 1234

    response = client.post(
        f"/api/srt/jobs/{job_id}/complete",
        json={},
        headers=auth_headers(),
    )

    assert response.status_code == 202
    assert response.json()["status"] == "queued"
    assert job["status"] == "queued"
    assert job["execution_name"] == "execution/test"


def test_status_and_download_require_completed_job(api):
    client, db, storage = api
    created = client.post(
        "/api/srt/jobs",
        json=create_payload(),
        headers=auth_headers(),
    )
    job_id = created.json()["job_id"]
    job = db.collection("srt_jobs").document(job_id).data
    job["status"] = "completed"
    job["progress"] = 100
    job["srt_object"] = f"jobs/{job_id}/output/subtitle.srt"
    output = storage.fake_bucket.blob(job["srt_object"])
    output.content = b"1\n00:00:01,000 --> 00:00:02,000\nHello\n"

    status = client.get(f"/api/srt/jobs/{job_id}", headers=auth_headers())
    assert status.status_code == 200
    assert status.json()["progress"] == 100
    assert status.json()["status"] == "completed"

    downloaded = client.get(
        f"/api/srt/jobs/{job_id}/download",
        headers=auth_headers(),
    )
    assert downloaded.status_code == 200
    assert downloaded.content.startswith(b"1\n00:00:01,000")
    assert "movie.srt" in downloaded.headers["content-disposition"]
