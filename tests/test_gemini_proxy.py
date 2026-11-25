from types import SimpleNamespace

import pytest

from app import gemini_proxy


class FakeResponse:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body
        self.ok = 200 <= status_code < 300

    def json(self):
        return self._body


def proxy_settings(**overrides):
    values = {
        "gemini_proxy_url": "https://script.google.com/macros/s/test/exec",
        "gemini_proxy_token": "shared-proxy-token",
        "gemini_api_key": "",
        "gemini_model": "gemini-3.5-flash-lite",
        "gemini_timeout_seconds": 120,
        "gemini_max_retries": 3,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def success_response(text='{"translations":[]}'):
    return FakeResponse(200, {
        "candidates": [{
            "content": {"parts": [{"text": text}]}
        }]
    })


def test_generate_content_uses_proxy_token_and_preserves_payload(monkeypatch):
    monkeypatch.setattr(gemini_proxy, "settings", proxy_settings())
    captured = {}

    def fake_post(url, **kwargs):
        captured["url"] = url
        captured.update(kwargs)
        return success_response("translated JSON")

    monkeypatch.setattr(gemini_proxy.requests, "post", fake_post)

    result = gemini_proxy.generate_content_text({"contents": [{"role": "user"}]})

    assert result == "translated JSON"
    assert captured["url"] == "https://script.google.com/macros/s/test/exec"
    assert captured["json"]["proxyToken"] == "shared-proxy-token"
    assert captured["json"]["model"] == "gemini-3.5-flash-lite"
    assert captured["json"]["payload"] == {"contents": [{"role": "user"}]}
    assert "apiKey" not in captured["json"]
    assert captured["allow_redirects"] is True


def test_legacy_proxy_contract_can_send_api_key(monkeypatch):
    monkeypatch.setattr(
        gemini_proxy,
        "settings",
        proxy_settings(gemini_proxy_token="", gemini_api_key="test-api-key"),
    )
    captured = {}

    def fake_post(url, **kwargs):
        captured.update(kwargs)
        return success_response("ok")

    monkeypatch.setattr(gemini_proxy.requests, "post", fake_post)

    assert gemini_proxy.generate_content_text({"contents": []}) == "ok"
    assert captured["json"]["apiKey"] == "test-api-key"
    assert "proxyToken" not in captured["json"]


def test_generate_content_retries_rate_limit(monkeypatch):
    monkeypatch.setattr(
        gemini_proxy,
        "settings",
        proxy_settings(gemini_max_retries=2),
    )
    responses = iter([
        FakeResponse(200, {"error": {"code": 429, "message": "rate limited"}}),
        success_response("recovered"),
    ])
    calls = []

    def fake_post(url, **kwargs):
        calls.append(url)
        return next(responses)

    monkeypatch.setattr(gemini_proxy.requests, "post", fake_post)
    monkeypatch.setattr(gemini_proxy.time, "sleep", lambda _seconds: None)

    assert gemini_proxy.generate_content_text({"contents": []}) == "recovered"
    assert len(calls) == 2


def test_generate_content_rejects_provider_error(monkeypatch):
    monkeypatch.setattr(gemini_proxy, "settings", proxy_settings())
    monkeypatch.setattr(
        gemini_proxy.requests,
        "post",
        lambda *_args, **_kwargs: FakeResponse(
            200,
            {"error": {"code": 403, "message": "API key is not authorized"}},
        ),
    )

    with pytest.raises(RuntimeError, match="Gemini API error \(403\)"):
        gemini_proxy.generate_content_text({"contents": []})


def test_generate_content_requires_proxy_and_auth(monkeypatch):
    monkeypatch.setattr(
        gemini_proxy,
        "settings",
        proxy_settings(gemini_proxy_url="", gemini_proxy_token="", gemini_api_key=""),
    )

    with pytest.raises(RuntimeError, match="GEMINI_PROXY_URL"):
        gemini_proxy.generate_content_text({"contents": []})

    monkeypatch.setattr(
        gemini_proxy,
        "settings",
        proxy_settings(gemini_proxy_token="", gemini_api_key=""),
    )
    with pytest.raises(RuntimeError, match="GEMINI_PROXY_TOKEN"):
        gemini_proxy.generate_content_text({"contents": []})
