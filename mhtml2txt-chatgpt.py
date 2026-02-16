from __future__ import annotations

import email
from email import policy
from pathlib import Path
import re
from typing import Optional, cast
import sys
import html as html_lib


def decode_html_part(part) -> str:
    html_bytes = cast(Optional[bytes], part.get_payload(decode=True))
    if html_bytes is None:
        payload = part.get_payload()
        if isinstance(payload, bytes):
            html_bytes = payload
        elif isinstance(payload, bytearray):
            html_bytes = bytes(payload)
        elif isinstance(payload, str):
            html_bytes = payload.encode("utf-8", errors="replace")
        else:
            html_bytes = b""

    charset = part.get_content_charset()
    for enc in (charset, "utf-8", "cp949", "euc-kr", "latin-1"):
        if not enc:
            continue
        try:
            return html_bytes.decode(enc)
        except Exception:
            continue

    return html_bytes.decode("utf-8", errors="replace")


def extract_html_from_mhtml(mhtml_path: Path) -> str:
    raw = mhtml_path.read_bytes()
    msg = email.message_from_bytes(raw, policy=policy.default)

    html_candidates: list[str] = []
    for part in msg.walk():
        if part.get_content_type() == "text/html":
            html_candidates.append(decode_html_part(part))

    if not html_candidates:
        raise ValueError("No text/html part found in MHTML.")

    markers = (
        "data-message-author-role",
        "<user-query",
        "<message-content",
    )
    for candidate in html_candidates:
        lower = candidate.lower()
        if any(marker in lower for marker in markers):
            return candidate

    return max(html_candidates, key=len)


def html_to_text(fragment: str) -> str:
    text = re.sub(r"(?i)<br\s*/?>", "\n", fragment)
    text = re.sub(r"(?i)</(p|div|li|ul|ol|blockquote|h[1-6]|tr|table|section)>", "\n", text)
    text = re.sub(r"(?i)<(p|div|li|ul|ol|blockquote|h[1-6]|tr|table|section)[^>]*>", "\n", text)
    text = re.sub(r"(?i)<td[^>]*>", "\t", text)
    text = re.sub(r"(?i)</td>", "\t", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = html_lib.unescape(text)
    text = re.sub(r"\r\n?", "\n", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def clean_dialog_text(role: str, text: str) -> str:
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            lines.append("")
            continue
        if stripped in ("ChatGPT said:", "You said:", "사용자 said:"):
            continue
        if re.fullmatch(r"\d+", stripped):
            continue
        lines.append(line)

    text = "\n".join(lines).strip()
    if role == "model":
        text = re.sub(r"^\d{4}-\d{2}-\d{2}\n+", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_blocks(html: str) -> list[tuple[str, int, str]]:
    items: list[tuple[str, int, str]] = []
    for match in re.finditer(
        r"<user-query[^>]*>(.*?)</user-query>",
        html,
        re.DOTALL | re.IGNORECASE,
    ):
        items.append(("user", match.start(), match.group(1)))
    for match in re.finditer(
        r"<message-content[^>]*>(.*?)</message-content>",
        html,
        re.DOTALL | re.IGNORECASE,
    ):
        items.append(("model", match.start(), match.group(1)))

    if items:
        items.sort(key=lambda item: item[1])
        return items

    role_matches = list(
        re.finditer(
            r'<div[^>]*data-message-author-role="(user|assistant)"[^>]*>',
            html,
            re.IGNORECASE,
        )
    )
    for i, match in enumerate(role_matches):
        role = match.group(1).lower()
        start = match.start()
        end = role_matches[i + 1].start() if i + 1 < len(role_matches) else len(html)
        fragment = html[start:end]
        items.append(("user" if role == "user" else "model", start, fragment))

    items.sort(key=lambda item: item[1])
    return items


def main() -> None:
    if len(sys.argv) > 1:
        mhtml_path = Path(sys.argv[1]).resolve()
    else:
        mhtml_path = Path(__file__).with_name("a.mhtml")
    if not mhtml_path.exists():
        raise SystemExit(f"MHTML not found: {mhtml_path}")

    html = extract_html_from_mhtml(mhtml_path)
    items = extract_blocks(html)

    pairs: list[tuple[str, str]] = []
    current_question: str | None = None
    current_answers: list[str] = []

    for role, _, fragment in items:
        text = clean_dialog_text(role, html_to_text(fragment))
        if not text:
            continue
        if role == "user":
            if current_question is not None:
                pairs.append((current_question, "\n\n".join(current_answers).strip()))
            current_question = text
            current_answers = []
        else:
            if current_question is None:
                current_question = "(질문 없음)"
            current_answers.append(text)

    if current_question is not None:
        pairs.append((current_question, "\n\n".join(current_answers).strip()))

    out_path = mhtml_path.with_suffix(".qa.txt")
    with out_path.open("w", encoding="utf-8") as f:
        for i, (question, answer) in enumerate(pairs, 1):
            f.write(f"[Turn {i}]\n")
            f.write("질문:\n")
            f.write(question)
            f.write("\n\n")
            f.write("답변:\n")
            f.write(answer)
            f.write("\n\n")

    print(out_path)
    print(f"turns: {len(pairs)}")


if __name__ == "__main__":
    main()
