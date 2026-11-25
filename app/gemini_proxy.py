from __future__ import annotations

import time
from typing import Any

import requests

from app.config import settings


_RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}


def _extract_error(data: Any, status_code: int) -> tuple[int, str]:
    error = data.get("error") if isinstance(data, dict) else None
    if isinstance(error, dict):
        try:
            code = int(error.get("code") or status_code or 0)
        except (TypeError, ValueError):
            code = status_code
        message = str(error.get("message") or "Gemini request failed.")
        return code, message[:400]
    if error:
        return status_code, str(error)[:400]
    return status_code, f"Gemini proxy returned HTTP {status_code}."


def generate_content_text(payload: dict[str, Any]) -> str:
    """Call Gemini through the Google Apps Script web-app proxy.

    Preferred mode: the API key is stored in Apps Script Script Properties and
    this worker sends only GEMINI_PROXY_TOKEN. Legacy mode is also supported:
    when GEMINI_API_KEY is configured, it is included in the request body for
    compatibility with the previous proxy contract.
    """
    proxy_url = settings.gemini_proxy_url.strip()
    if not proxy_url:
        raise RuntimeError("GEMINI_PROXY_URL is not configured.")

    request_body: dict[str, Any] = {
        "model": settings.gemini_model,
        "payload": payload,
    }
    if settings.gemini_proxy_token:
        request_body["proxyToken"] = settings.gemini_proxy_token
    if settings.gemini_api_key:
        request_body["apiKey"] = settings.gemini_api_key
    if not settings.gemini_proxy_token and not settings.gemini_api_key:
        raise RuntimeError(
            "Configure GEMINI_PROXY_TOKEN or the legacy GEMINI_API_KEY secret."
        )

    attempts = max(1, int(settings.gemini_max_retries))
    last_error = "Gemini proxy request failed."
    for attempt in range(attempts):
        try:
            response = requests.post(
                proxy_url,
                json=request_body,
                headers={"Content-Type": "application/json"},
                timeout=max(10, int(settings.gemini_timeout_seconds)),
                allow_redirects=True,
            )
        except requests.RequestException as exc:
            last_error = f"Gemini proxy network error ({type(exc).__name__})."
            if attempt + 1 < attempts:
                time.sleep(min(2 ** attempt, 6))
                continue
            raise RuntimeError(last_error) from exc

        try:
            data = response.json()
        except ValueError as exc:
            if response.status_code in _RETRYABLE_STATUS_CODES and attempt + 1 < attempts:
                last_error = f"Gemini proxy temporarily returned HTTP {response.status_code}."
                time.sleep(min(2 ** attempt, 6))
                continue
            raise RuntimeError(
                f"Gemini proxy returned a non-JSON response (HTTP {response.status_code})."
            ) from exc

        if not isinstance(data, dict):
            raise RuntimeError("Gemini proxy returned an invalid response.")

        error = data.get("error")
        if error:
            code, message = _extract_error(data, response.status_code)
            if (code in _RETRYABLE_STATUS_CODES or response.status_code in _RETRYABLE_STATUS_CODES) and attempt + 1 < attempts:
                last_error = f"Gemini API temporarily unavailable (code {code})."
                time.sleep(min(2 ** attempt, 6))
                continue
            raise RuntimeError(f"Gemini API error ({code}): {message}")

        if not response.ok:
            if response.status_code in _RETRYABLE_STATUS_CODES and attempt + 1 < attempts:
                last_error = f"Gemini proxy temporarily returned HTTP {response.status_code}."
                time.sleep(min(2 ** attempt, 6))
                continue
            raise RuntimeError(f"Gemini proxy returned HTTP {response.status_code}.")

        candidates = data.get("candidates")
        if not isinstance(candidates, list) or not candidates:
            raise RuntimeError("Gemini returned no translation candidate.")

        content = candidates[0].get("content") if isinstance(candidates[0], dict) else None
        parts = content.get("parts") if isinstance(content, dict) else None
        if not isinstance(parts, list):
            raise RuntimeError("Gemini returned an invalid candidate structure.")

        text = "".join(
            str(part.get("text", ""))
            for part in parts
            if isinstance(part, dict) and part.get("text") is not None
        ).strip()
        if not text:
            raise RuntimeError("Gemini returned an empty translation response.")
        return text

    raise RuntimeError(last_error)
