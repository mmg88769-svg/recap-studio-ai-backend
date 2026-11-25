from __future__ import annotations

import json
import math
import os
import subprocess
import tempfile
from collections import Counter
from pathlib import Path

import google.auth
from google.api_core.client_options import ClientOptions
from google.cloud import firestore, speech_v2, storage
from google.cloud.speech_v2.types import cloud_speech
from google import genai
from google.genai import types

from app.config import settings
from app.subtitles import build_srt, group_words


CHUNK_SECONDS = 900
CHUNK_OVERLAP_SECONDS = 1
TRANSLATION_BATCH_SIZE = 25


def _update_job(job_ref, **fields) -> None:
    fields["updated_at"] = firestore.SERVER_TIMESTAMP
    job_ref.update(fields)


def _run(command: list[str], timeout: int = 7200) -> str:
    completed = subprocess.run(
        command,
        check=True,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return completed.stdout.strip()


def _probe_duration(video_path: str) -> float:
    value = _run([
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        video_path,
    ], timeout=120)
    duration = float(value)
    if duration <= 0 or duration > settings.max_video_duration_seconds:
        raise ValueError("Video duration is outside the allowed limit.")
    return duration


def _extract_audio(video_path: str, audio_path: str) -> None:
    _run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", video_path,
        "-vn", "-ac", "1", "-ar", "16000",
        "-c:a", "flac", audio_path,
    ], timeout=7200)


def _make_audio_chunk(audio_path: str, chunk_path: str, start: float, duration: float) -> None:
    _run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-ss", f"{start:.3f}", "-i", audio_path,
        "-t", f"{duration:.3f}",
        "-ac", "1", "-ar", "16000", "-c:a", "flac",
        chunk_path,
    ], timeout=1800)


def _duration_seconds(value) -> float:
    if value is None:
        return 0.0
    return float(getattr(value, "seconds", 0)) + float(getattr(value, "nanos", 0)) / 1_000_000_000.0


def _transcribe_chunk(
    speech_client: speech_v2.SpeechClient,
    audio_uri: str,
) -> tuple[list[dict], list[str]]:
    recognizer = (
        f"projects/{settings.project_id}/locations/{settings.stt_location}/recognizers/_"
    )
    config = cloud_speech.RecognitionConfig(
        auto_decoding_config=cloud_speech.AutoDetectDecodingConfig(),
        language_codes=["auto"],
        model=settings.stt_model,
        features=cloud_speech.RecognitionFeatures(enable_word_time_offsets=True),
    )
    request = cloud_speech.BatchRecognizeRequest(
        recognizer=recognizer,
        config=config,
        files=[cloud_speech.BatchRecognizeFileMetadata(uri=audio_uri)],
        recognition_output_config=cloud_speech.RecognitionOutputConfig(
            inline_response_config=cloud_speech.InlineOutputConfig()
        ),
    )
    operation = speech_client.batch_recognize(request=request)
    response = operation.result(timeout=1800)
    file_result = response.results.get(audio_uri)
    if file_result is None or file_result.transcript is None:
        raise RuntimeError("Speech recognition returned no transcript.")

    words: list[dict] = []
    languages: list[str] = []
    for speech_result in file_result.transcript.results:
        if not speech_result.alternatives:
            continue
        if getattr(speech_result, "language_code", ""):
            languages.append(speech_result.language_code)
        alternative = speech_result.alternatives[0]
        for word in alternative.words:
            start = _duration_seconds(word.start_offset)
            end = _duration_seconds(word.end_offset) if word.end_offset else start
            if end <= start:
                continue
            words.append({
                "text": word.word,
                "start_local_ms": int(start * 1000),
                "end_local_ms": int(end * 1000),
                "speaker": getattr(word, "speaker_label", None),
            })

    return words, languages


def _translate_batch(
    client: genai.Client,
    source_language: str,
    batch: list[dict],
    context_lines: list[str],
) -> dict[int, str]:
    items = [
        {"id": cue["id"], "text": cue["source_text"]}
        for cue in batch
    ]
    prompt = (
        "You are a professional film subtitle translator. Translate the dialogue into "
        "natural, concise Myanmar Burmese (Unicode). Preserve the exact meaning, intent, "
        "emotion, names, relationships, and plot facts. Do not add explanations, summaries, "
        "or information that is not in the source. Keep each subtitle concise enough for "
        "one or two short lines (prefer at most 42 Burmese grapheme clusters per line). "
        "Use natural spoken Burmese, not stiff word-for-word translation. Preserve profanity "
        "and emotional tone appropriately. The source language code is: "
        + (source_language or "auto-detected")
        + ". Use nearby context only to understand references; do not add context to the translation.\n"
        + "Previous context (not to translate): "
        + json.dumps(context_lines, ensure_ascii=False)
        + "\nTranslate these items and return JSON only in this exact shape: "
        + '{"translations":[{"id":1,"text":"မြန်မာဘာသာပြန်"}]}'
        + "\nItems: "
        + json.dumps(items, ensure_ascii=False)
    )
    response = client.models.generate_content(
        model=settings.gemini_model,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            thinking_config=types.ThinkingConfig(
                thinking_level=settings.gemini_thinking_level,
            ),
        ),
    )
    if not response.text:
        raise RuntimeError("Translation model returned an empty response.")
    data = json.loads(response.text)
    translations = data.get("translations")
    if not isinstance(translations, list):
        raise RuntimeError("Translation response has an invalid structure.")

    result: dict[int, str] = {}
    for item in translations:
        if not isinstance(item, dict):
            continue
        cue_id = int(item.get("id", 0))
        translated = str(item.get("text", "")).strip()
        if cue_id and translated:
            result[cue_id] = translated

    expected = {int(cue["id"]) for cue in batch}
    if set(result) != expected:
        raise RuntimeError("Translation response omitted or duplicated subtitle items.")
    return result


def _translate_cues(cues: list[dict], source_language: str, project_id: str) -> list[dict]:
    language = (source_language or "").lower()
    if language.startswith("my"):
        return [{**cue, "text": cue["source_text"]} for cue in cues]

    client = genai.Client(enterprise=True, project=project_id, location=settings.gemini_location)
    translated: list[dict] = []
    total_batches = math.ceil(len(cues) / TRANSLATION_BATCH_SIZE)

    for batch_index in range(total_batches):
        start = batch_index * TRANSLATION_BATCH_SIZE
        batch = cues[start:start + TRANSLATION_BATCH_SIZE]
        context_lines = [
            cue["source_text"]
            for cue in cues[max(0, start - 2):start]
        ]
        translations = _translate_batch(client, source_language, batch, context_lines)
        translated.extend({**cue, "text": translations[int(cue["id"])]} for cue in batch)

    return translated


def process_job(job_id: str) -> None:
    if not settings.project_id or not settings.gcs_bucket:
        raise RuntimeError("Google Cloud project or storage bucket is not configured.")

    db = firestore.Client(project=settings.project_id)
    job_ref = db.collection(settings.job_collection).document(job_id)
    snapshot = job_ref.get()
    if not snapshot.exists:
        raise RuntimeError("SRT job record was not found.")
    job = snapshot.to_dict() or {}

    bucket = storage.Client(project=settings.project_id).bucket(settings.gcs_bucket)
    source_blob = bucket.blob(job["source_object"])
    audio_chunk_blobs: list[str] = []
    succeeded = False

    _update_job(
        job_ref,
        status="processing",
        progress=3,
        stage="Video ကို စစ်ဆေးနေသည်...",
        error=None,
    )

    try:
        with tempfile.TemporaryDirectory(prefix="myanmar-srt-") as temp_dir:
            video_path = str(Path(temp_dir) / "source-video")
            audio_path = str(Path(temp_dir) / "audio.flac")
            source_blob.download_to_filename(video_path)

            duration = _probe_duration(video_path)
            _update_job(
                job_ref,
                progress=8,
                stage="Video အသံကို ထုတ်ယူနေသည်...",
                duration_seconds=duration,
            )
            _extract_audio(video_path, audio_path)

            speech_client = speech_v2.SpeechClient(
                client_options=ClientOptions(
                    api_endpoint=f"{settings.stt_location}-speech.googleapis.com"
                )
            )

            chunk_count = max(1, math.ceil(duration / CHUNK_SECONDS))
            all_words: list[dict] = []
            detected_languages: list[str] = []

            for index in range(chunk_count):
                logical_start = index * CHUNK_SECONDS
                chunk_start = max(0, logical_start - (CHUNK_OVERLAP_SECONDS if index else 0))
                logical_end = min(duration, (index + 1) * CHUNK_SECONDS)
                chunk_duration = logical_end - chunk_start
                chunk_path = str(Path(temp_dir) / f"audio-{index:04d}.flac")
                _make_audio_chunk(audio_path, chunk_path, chunk_start, chunk_duration)

                object_name = f"jobs/{job_id}/audio/chunk-{index:04d}.flac"
                chunk_blob = bucket.blob(object_name)
                chunk_blob.upload_from_filename(chunk_path, content_type="audio/flac")
                audio_chunk_blobs.append(object_name)

                audio_uri = f"gs://{settings.gcs_bucket}/{object_name}"
                chunk_words, languages = _transcribe_chunk(speech_client, audio_uri)
                detected_languages.extend(languages)

                for word in chunk_words:
                    local_start = word["start_local_ms"]
                    if index > 0 and local_start < CHUNK_OVERLAP_SECONDS * 1000:
                        continue
                    all_words.append({
                        "text": word["text"],
                        "start_ms": int(chunk_start * 1000) + local_start,
                        "end_ms": int(chunk_start * 1000) + word["end_local_ms"],
                        "speaker": word.get("speaker"),
                    })

                chunk_blob.delete()
                audio_chunk_blobs.remove(object_name)
                _update_job(
                    job_ref,
                    progress=10 + int(48 * (index + 1) / chunk_count),
                    stage=f"အသံကို စာသားအဖြစ် ပြောင်းလဲနေသည်... ({index + 1}/{chunk_count})",
                )

            if not all_words:
                raise RuntimeError("Speech recognition did not detect any spoken words.")

            source_language = Counter(detected_languages).most_common(1)[0][0] if detected_languages else "auto"
            _update_job(
                job_ref,
                progress=60,
                stage="စကားပြောစာသားကို မြန်မာဘာသာပြန်နေသည်...",
                detected_source_language=source_language,
            )

            source_cues = group_words(all_words, source_language)
            if not source_cues:
                raise RuntimeError("No subtitle segments could be created from the transcript.")

            translated_cues: list[dict] = []
            total_batches = math.ceil(len(source_cues) / TRANSLATION_BATCH_SIZE)
            translation_client = None
            if not source_language.lower().startswith("my"):
                translation_client = genai.Client(
                    enterprise=True,
                    project=settings.project_id,
                    location=settings.gemini_location,
                )
            for batch_index in range(total_batches):
                start = batch_index * TRANSLATION_BATCH_SIZE
                batch = source_cues[start:start + TRANSLATION_BATCH_SIZE]
                context_lines = [cue["source_text"] for cue in source_cues[max(0, start - 2):start]]
                if source_language.lower().startswith("my"):
                    translated_cues.extend({**cue, "text": cue["source_text"]} for cue in batch)
                else:
                    translations = _translate_batch(translation_client, source_language, batch, context_lines)
                    translated_cues.extend(
                        {**cue, "text": translations[int(cue["id"])]}
                        for cue in batch
                    )
                _update_job(
                    job_ref,
                    progress=60 + int(27 * (batch_index + 1) / total_batches),
                    stage=f"မြန်မာစာတန်းထိုး ပြင်ဆင်နေသည်... ({batch_index + 1}/{total_batches})",
                )

            _update_job(
                job_ref,
                progress=90,
                stage="SRT Timestamp နဲ့ စာကြောင်းတွေကို စစ်ဆေးနေသည်...",
            )
            srt_content = build_srt(translated_cues)
            output_name = f"jobs/{job_id}/output/subtitle.srt"
            output_blob = bucket.blob(output_name)
            output_blob.upload_from_string(
                srt_content.encode("utf-8"),
                content_type="text/plain; charset=utf-8",
            )

            _update_job(
                job_ref,
                status="completed",
                progress=100,
                stage="SRT ဖိုင် အဆင်သင့်ဖြစ်ပါပြီ။",
                srt_object=output_name,
                detected_source_language=source_language,
                completed_at=firestore.SERVER_TIMESTAMP,
                error=None,
            )
            succeeded = True
    except Exception as exc:
        _update_job(
            job_ref,
            status="failed",
            stage="လုပ်ဆောင်မှု မအောင်မြင်ပါ။",
            error=str(exc)[:400],
        )
        raise
    finally:
        for object_name in audio_chunk_blobs:
            try:
                bucket.blob(object_name).delete()
            except Exception:
                pass
        if succeeded:
            try:
                source_blob.delete()
            except Exception:
                pass
