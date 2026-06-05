from __future__ import annotations

from pathlib import Path
from pypdf import PdfReader

def extract_pdf_text(file_path: str | Path) -> str:
    path = Path(file_path)
    reader = PdfReader(str(path))
    texts = []
    for page in reader.pages:
        try:
            texts.append(page.extract_text() or "")
        except Exception:
            texts.append("")
    return "\n".join(texts).strip()
