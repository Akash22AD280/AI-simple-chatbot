from __future__ import annotations

from pathlib import Path

from flask import Blueprint, Response, jsonify, request
from fpdf import FPDF
from werkzeug.utils import secure_filename

from .providers import DEFAULT_MODELS, PROVIDER_LABELS, ProviderError, request_non_stream, stream_response
from .pdf_handler import extract_pdf_text
from .utils import build_prompt_from_messages, normalize_whitespace, safe_json_dumps, estimate_usage

bp = Blueprint("chatbot", __name__)

ALLOWED_UPLOADS = {".txt", ".md", ".csv", ".json", ".log", ".pdf"}


def _error(message: str, status: int = 400):
    return jsonify({"success": False, "error": message}), status


@bp.route("/api/providers", methods=["GET"])
def providers():
    return jsonify({"success": True, "providers": PROVIDER_LABELS, "models": DEFAULT_MODELS})


@bp.route("/extract", methods=["POST"])
def extract():
    files = request.files.getlist("files")
    if not files:
        return _error("No files uploaded.", 400)

    extracted = []
    for f in files:
        filename = secure_filename(f.filename or "")
        ext = Path(filename).suffix.lower()
        if ext not in ALLOWED_UPLOADS:
            continue

        raw = f.read()
        if not raw:
            continue

        try:
            if ext == ".pdf":
                from tempfile import NamedTemporaryFile
                with NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
                    tmp.write(raw)
                    tmp_path = tmp.name
                text = extract_pdf_text(tmp_path)
            else:
                text = raw.decode("utf-8", errors="ignore")
        except Exception as e:
            text = f"[Could not extract {filename}: {e}]"

        text = normalize_whitespace(text)
        if text:
            extracted.append({"filename": filename, "text": text})

    return jsonify({"success": True, "files": extracted})


@bp.route("/chat", methods=["POST"])
def chat():
    data = request.get_json(silent=True) or {}
    provider = (data.get("provider") or "").lower().strip()
    api_key = (data.get("api_key") or "").strip()
    model = (data.get("model") or "").strip()
    system_prompt = data.get("system_prompt") or ""
    language = data.get("language") or "Auto"
    attachments_text = data.get("attachments_text") or ""
    messages = data.get("messages") or []
    stream = bool(data.get("stream", True))
    temperature = float(data.get("temperature", 0.7))
    max_tokens = int(data.get("max_tokens", 1200))

    if provider not in DEFAULT_MODELS:
        return _error("Please select a supported provider.", 400)
    if not api_key:
        return _error("API key is required.", 400)
    if not model:
        model = DEFAULT_MODELS[provider][0]
    if not messages:
        return _error("Message list is empty.", 400)

    if attachments_text.strip():
        system_prompt = (system_prompt + "\n\nAttached files:\n" + attachments_text.strip()).strip()

    messages = [m for m in messages if m.get("content")]
    prompt_for_stats = build_prompt_from_messages(messages, system_prompt, "", language)

    if not stream:
        try:
            reply, _ = request_non_stream(provider, api_key, model, messages, system_prompt, temperature, max_tokens)
            usage = estimate_usage(prompt_for_stats, reply)
            return jsonify({"success": True, "response": reply, "usage": usage, "provider": provider, "model": model})
        except ProviderError as e:
            return _error(str(e), e.status_code or 500)
        except Exception as e:
            return _error(f"Unexpected error: {e}", 500)

    def generate():
        collected = []
        try:
            for token in stream_response(provider, api_key, model, messages, system_prompt, temperature, max_tokens):
                collected.append(token)
                yield safe_json_dumps({"type": "chunk", "content": token}) + "\n"
        except ProviderError as e:
            yield safe_json_dumps({"type": "error", "error": str(e), "status": e.status_code or 500}) + "\n"
            return
        except Exception as e:
            yield safe_json_dumps({"type": "error", "error": f"Unexpected error: {e}", "status": 500}) + "\n"
            return

        reply = "".join(collected)
        usage = estimate_usage(prompt_for_stats, reply)
        yield safe_json_dumps({"type": "meta", "usage": usage, "provider": provider, "model": model}) + "\n"

    return Response(generate(), mimetype="application/x-ndjson")


@bp.route("/compare", methods=["POST"])
def compare():
    data = request.get_json(silent=True) or {}
    api_key_a = (data.get("api_key_a") or "").strip()
    provider_a = (data.get("provider_a") or "").lower().strip()
    model_a = (data.get("model_a") or "").strip()

    api_key_b = (data.get("api_key_b") or "").strip()
    provider_b = (data.get("provider_b") or "").lower().strip()
    model_b = (data.get("model_b") or "").strip()

    messages = data.get("messages") or []
    system_prompt = data.get("system_prompt") or ""
    language = data.get("language") or "Auto"
    attachments_text = data.get("attachments_text") or ""
    temperature = float(data.get("temperature", 0.7))
    max_tokens = int(data.get("max_tokens", 1200))

    if not messages:
        return _error("No messages to compare.", 400)

    if attachments_text.strip():
        system_prompt = (system_prompt + "\n\nAttached files:\n" + attachments_text.strip()).strip()

    try:
        reply_a, _ = request_non_stream(provider_a, api_key_a, model_a, messages, system_prompt, temperature, max_tokens)
        reply_b, _ = request_non_stream(provider_b, api_key_b, model_b, messages, system_prompt, temperature, max_tokens)
        return jsonify({
            "success": True,
            "comparison": [
                {"provider": provider_a, "model": model_a, "response": reply_a},
                {"provider": provider_b, "model": model_b, "response": reply_b},
            ]
        })
    except ProviderError as e:
        return _error(str(e), e.status_code or 500)
    except Exception as e:
        return _error(f"Unexpected error: {e}", 500)


@bp.route("/export/txt", methods=["POST"])
def export_txt():
    data = request.get_json(silent=True) or {}
    title = data.get("title") or "ai_chatbot_export"
    messages = data.get("messages") or []

    content = [f"AI Chatbot Export - {title}", "=" * 48, ""]
    for m in messages:
        role = m.get("role", "user").capitalize()
        text = m.get("content", "")
        content.append(f"{role}:\n{text}\n")
    payload = "\n".join(content)

    return Response(
        payload,
        mimetype="text/plain; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename={secure_filename(title)}.txt"},
    )


@bp.route("/export/pdf", methods=["POST"])
def export_pdf():
    data = request.get_json(silent=True) or {}
    title = data.get("title") or "ai_chatbot_export"
    messages = data.get("messages") or []

    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()
    pdf.set_font("Arial", "B", 16)
    pdf.multi_cell(0, 10, f"AI Chatbot Export - {title}")
    pdf.ln(2)
    pdf.set_font("Arial", size=11)

    for m in messages:
        role = m.get("role", "user").capitalize()
        text = m.get("content", "")
        pdf.set_font("Arial", "B", 12)
        pdf.multi_cell(0, 8, f"{role}:")
        pdf.set_font("Arial", size=11)
        for line in str(text).splitlines():
            pdf.multi_cell(0, 7, line)
        pdf.ln(2)

    out = pdf.output(dest="S").encode("latin-1")
    return Response(
        out,
        mimetype="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={secure_filename(title)}.pdf"},
    )
