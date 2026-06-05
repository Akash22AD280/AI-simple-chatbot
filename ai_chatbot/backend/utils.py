from __future__ import annotations

import json
import math
import re
from typing import Any, Dict, List

def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, math.ceil(len(text) / 4))

def estimate_usage(prompt: str, completion: str) -> dict:
    prompt_tokens = estimate_tokens(prompt)
    completion_tokens = estimate_tokens(completion)
    return {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": prompt_tokens + completion_tokens,
        "estimated": True,
    }

def build_prompt_from_messages(messages: List[Dict[str, str]], system_prompt: str = "", attachments_text: str = "", language: str = "Auto") -> str:
    parts = []
    if system_prompt:
        parts.append(f"System prompt:\n{system_prompt.strip()}")
    if language and language != "Auto":
        parts.append(f"Response language: {language}")
    if attachments_text.strip():
        parts.append(f"Attached file content:\n{attachments_text.strip()}")
    for msg in messages:
        role = msg.get("role", "user")
        content = (msg.get("content") or "").strip()
        if content:
            parts.append(f"{role.capitalize()}: {content}")
    return "\n\n".join(parts).strip()

def safe_json_dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))

def normalize_whitespace(text: str) -> str:
    if not text:
        return ""
    return re.sub(r"\n{3,}", "\n\n", text).strip()
