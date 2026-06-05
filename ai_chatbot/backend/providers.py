from __future__ import annotations

import json
from typing import Iterable, List

import requests

from .utils import estimate_usage

OPENAI_BASE = "https://api.openai.com/v1"
XAI_BASE = "https://api.x.ai/v1"
GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"

PROVIDER_LABELS = {
    "openai": "OpenAI",
    "gemini": "Google Gemini",
    "xai": "xAI / Grok",
}

DEFAULT_MODELS = {
    "openai": ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4.1"],
    "gemini": ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-3.5-pro"],
    "xai": ["grok-4", "grok-4-fast", "grok-3"],
}

class ProviderError(RuntimeError):
    def __init__(self, message: str, status_code: int | None = None, provider: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.provider = provider

def _headers(provider: str, api_key: str) -> dict:
    if provider == "gemini":
        return {"Content-Type": "application/json"}
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }

def build_request(provider: str, api_key: str, model: str, messages: List[dict], system_prompt: str = "", temperature: float = 0.7, max_tokens: int = 1200):
    provider = provider.lower().strip()

    if provider == "openai":
        url = f"{OPENAI_BASE}/chat/completions"
        payload = {"model": model, "messages": [], "temperature": temperature, "max_tokens": max_tokens}
        if system_prompt:
            payload["messages"].append({"role": "system", "content": system_prompt})
        payload["messages"].extend(messages)
        return url, _headers(provider, api_key), payload

    if provider == "xai":
        url = f"{XAI_BASE}/chat/completions"
        payload = {"model": model, "messages": [], "temperature": temperature, "max_tokens": max_tokens}
        if system_prompt:
            payload["messages"].append({"role": "system", "content": system_prompt})
        payload["messages"].extend(messages)
        return url, _headers(provider, api_key), payload

    if provider == "gemini":
        url = f"{GEMINI_BASE}/models/{model}:generateContent"
        payload = {
            "contents": [],
            "generationConfig": {
                "temperature": temperature,
                "maxOutputTokens": max_tokens,
            },
        }
        if system_prompt:
            payload["systemInstruction"] = {"parts": [{"text": system_prompt}]}
        for m in messages:
            role = "user" if m.get("role") == "user" else "model"
            payload["contents"].append({"role": role, "parts": [{"text": m.get("content", "")}]})
        return url, _headers(provider, api_key), payload

    raise ProviderError(f"Unsupported provider: {provider}")

def _extract_openai_delta(line_json: dict) -> str:
    try:
        return line_json["choices"][0].get("delta", {}).get("content", "") or ""
    except Exception:
        return ""

def _extract_gemini_text(line_json: dict) -> str:
    try:
        candidates = line_json.get("candidates") or []
        if candidates:
            c0 = candidates[0]
            content = c0.get("content") or {}
            parts = content.get("parts") or []
            if parts:
                txt = parts[0].get("text")
                if txt:
                    return txt
        for cand in candidates:
            content = cand.get("content") or {}
            for part in content.get("parts") or []:
                if part.get("text"):
                    return part["text"]
    except Exception:
        pass
    return ""

def _parse_sse_lines(resp: requests.Response, provider: str) -> Iterable[str]:
    for raw_line in resp.iter_lines(decode_unicode=True):
        if not raw_line:
            continue
        line = raw_line.strip()
        if not line:
            continue

        if line.startswith("data:"):
            data = line[len("data:"):].strip()
        elif line.startswith("event:"):
            continue
        else:
            data = line

        if data in ("[DONE]", "data: [DONE]"):
            break

        try:
            obj = json.loads(data)
        except Exception:
            continue

        if provider == "gemini":
            chunk = _extract_gemini_text(obj)
        else:
            chunk = _extract_openai_delta(obj)

        if chunk:
            yield chunk

def _api_error(provider: str, response: requests.Response) -> ProviderError:
    status = response.status_code
    try:
        body = response.json()
        detail = body.get("error", {}).get("message") or body.get("message") or str(body)
    except Exception:
        detail = response.text[:500]

    if status in (401, 403):
        msg = f"Invalid or unauthorized API key for {PROVIDER_LABELS.get(provider, provider)}."
    elif status == 429:
        msg = f"Rate limit reached for {PROVIDER_LABELS.get(provider, provider)}."
    else:
        msg = f"{PROVIDER_LABELS.get(provider, provider)} API error ({status})."
    return ProviderError(f"{msg} {detail}", status_code=status, provider=provider)

def request_non_stream(provider: str, api_key: str, model: str, messages: List[dict], system_prompt: str = "", temperature: float = 0.7, max_tokens: int = 1200):
    url, headers, payload = build_request(provider, api_key, model, messages, system_prompt, temperature, max_tokens)

    if provider == "gemini":
        response = requests.post(f"{url}?key={api_key}", headers={"Content-Type": "application/json"}, json=payload, timeout=90)
    else:
        response = requests.post(url, headers=headers, json=payload, timeout=90)

    if response.status_code >= 400:
        raise _api_error(provider, response)

    data = response.json()
    if provider in ("openai", "xai"):
        return data["choices"][0]["message"]["content"] or "", {"status_code": response.status_code}
    if provider == "gemini":
        candidates = data.get("candidates") or []
        if candidates:
            content = candidates[0].get("content") or {}
            parts = content.get("parts") or []
            if parts:
                return parts[0].get("text", "") or "", {"status_code": response.status_code}
    return "", {"status_code": response.status_code}

def stream_response(provider: str, api_key: str, model: str, messages: List[dict], system_prompt: str = "", temperature: float = 0.7, max_tokens: int = 1200):
    url, headers, payload = build_request(provider, api_key, model, messages, system_prompt, temperature, max_tokens)

    if provider == "gemini":
        req_url = f"{url}:streamGenerateContent?alt=sse&key={api_key}"
        response = requests.post(req_url, headers={"Content-Type": "application/json"}, json=payload, stream=True, timeout=120)
    else:
        payload = dict(payload)
        payload["stream"] = True
        response = requests.post(url, headers=headers, json=payload, stream=True, timeout=120)

    if response.status_code >= 400:
        raise _api_error(provider, response)

    for chunk in _parse_sse_lines(response, provider):
        yield chunk
