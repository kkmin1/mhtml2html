from __future__ import annotations

import email
from email import policy
from html.parser import HTMLParser
from pathlib import Path
import html as html_lib
import re
import sys


def decode_html_part(part) -> str:
    raw = part.get_payload(decode=True)
    if raw is None:
        payload = part.get_payload()
        if isinstance(payload, str):
            raw = payload.encode("utf-8", errors="replace")
        elif isinstance(payload, bytearray):
            raw = bytes(payload)
        elif isinstance(payload, bytes):
            raw = payload
        else:
            raw = b""

    for enc in (part.get_content_charset() or "utf-8", "utf-8", "cp949", "euc-kr", "latin-1"):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return raw.decode("utf-8", errors="replace")


def extract_main_html_from_mhtml(path: Path) -> str:
    msg = email.message_from_bytes(path.read_bytes(), policy=policy.default)
    candidates: list[str] = []
    for part in msg.walk():
        if part.get_content_type() == "text/html":
            candidates.append(decode_html_part(part))
    if not candidates:
        raise ValueError("No text/html part found.")
    return max(candidates, key=len)


class FragmentToMarkdown(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.out: list[str] = []
        self.list_stack: list[tuple[str, int]] = []

        self.heading_depth = 0
        self.heading_buf: list[str] = []

        self.in_table = False
        self.table_rows: list[list[str]] = []
        self.current_row: list[str] | None = None
        self.current_cell: list[str] | None = None

        self.skip_tag_depth = 0

    def _append(self, s: str) -> None:
        self.out.append(s)

    def _tail(self) -> str:
        return "".join(self.out[-4:]) if self.out else ""

    def _ensure_newlines(self, n: int = 1) -> None:
        tail = self._tail()
        cnt = 0
        for ch in reversed(tail):
            if ch == "\n":
                cnt += 1
            else:
                break
        if cnt < n:
            self._append("\n" * (n - cnt))

    def _in_heading(self) -> bool:
        return self.heading_depth > 0

    def _flush_heading(self) -> None:
        text = html_lib.unescape("".join(self.heading_buf))
        text = re.sub(r"\s+", " ", text).strip()
        self.heading_buf = []
        if not text:
            return
        self._ensure_newlines(2)
        self._append(f"#### {text}\n\n")

    def _flush_table(self) -> None:
        if not self.table_rows:
            return

        # Normalize row width.
        width = max(len(r) for r in self.table_rows)
        norm_rows: list[list[str]] = []
        for row in self.table_rows:
            cells = row[:]
            while len(cells) < width:
                cells.append("")
            norm_rows.append(cells)

        header = norm_rows[0]
        body = norm_rows[1:] if len(norm_rows) > 1 else []

        self._ensure_newlines(2)
        self._append("| " + " | ".join(header) + " |\n")
        self._append("| " + " | ".join(["---"] * width) + " |\n")
        for row in body:
            self._append("| " + " | ".join(row) + " |\n")
        self._append("\n")

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in ("script", "style", "svg", "path"):
            self.skip_tag_depth += 1
            return
        if self.skip_tag_depth > 0:
            return

        attrs_d = dict(attrs)
        style = attrs_d.get("style", "")

        if tag == "table":
            self.in_table = True
            self.table_rows = []
            self.current_row = None
            self.current_cell = None
            return
        if self.in_table:
            if tag == "tr":
                self.current_row = []
            elif tag in ("th", "td"):
                self.current_cell = []
            return

        if tag == "br":
            self._ensure_newlines(1)
            return

        if tag in ("ul", "ol"):
            self._ensure_newlines(1)
            self.list_stack.append((tag, 0))
            return

        if tag == "li":
            self._ensure_newlines(1)
            indent = "  " * max(0, len(self.list_stack) - 1)
            if self.list_stack and self.list_stack[-1][0] == "ol":
                t, idx = self.list_stack[-1]
                idx += 1
                self.list_stack[-1] = (t, idx)
                bullet = f"{idx}. "
            else:
                bullet = "- "
            self._append(indent + bullet)
            return

        if tag in ("p", "div", "section", "article", "blockquote"):
            self._ensure_newlines(1)
            return

        # Grok often renders subtitle lines as span blocks with margin-top.
        if tag == "span" and "display: block" in style and "margin-top" in style:
            self.heading_depth += 1
            if self.heading_depth == 1:
                self.heading_buf = []

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style", "svg", "path") and self.skip_tag_depth > 0:
            self.skip_tag_depth -= 1
            return
        if self.skip_tag_depth > 0:
            return

        if self.in_table:
            if tag in ("th", "td"):
                if self.current_row is not None and self.current_cell is not None:
                    cell = html_lib.unescape("".join(self.current_cell))
                    cell = re.sub(r"\s+", " ", cell).strip().replace("|", "\\|")
                    self.current_row.append(cell)
                self.current_cell = None
                return
            if tag == "tr":
                if self.current_row is not None:
                    # Keep non-empty rows.
                    if any(c.strip() for c in self.current_row):
                        self.table_rows.append(self.current_row)
                self.current_row = None
                return
            if tag == "table":
                self.in_table = False
                self._flush_table()
                self.table_rows = []
                self.current_row = None
                self.current_cell = None
                return
            return

        if tag in ("ul", "ol"):
            if self.list_stack:
                self.list_stack.pop()
            self._ensure_newlines(1)
            return

        if tag == "li":
            self._ensure_newlines(1)
            return

        if tag in ("p", "div", "section", "article", "blockquote"):
            self._ensure_newlines(1)
            return

        if tag == "span" and self.heading_depth > 0:
            self.heading_depth -= 1
            if self.heading_depth == 0:
                self._flush_heading()

    def handle_data(self, data: str) -> None:
        if self.skip_tag_depth > 0:
            return
        if not data:
            return
        if self.in_table and self.current_cell is not None:
            self.current_cell.append(data)
            return
        if self._in_heading():
            self.heading_buf.append(data)
            return
        self._append(html_lib.unescape(data))

    def get_markdown(self) -> str:
        text = "".join(self.out)
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        text = re.sub(r"[ \t]+\n", "\n", text)
        text = re.sub(r"\n[ \t]+", "\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        # Ensure obvious list headings start on new line.
        text = re.sub(r"(?<=\.)(?=\d+\.\s)", "\n", text)
        lines = [re.sub(r"[ \t]{2,}", " ", ln).rstrip() for ln in text.split("\n")]
        return "\n".join(lines).strip()


def extract_message_blocks(full_html: str) -> list[tuple[str, str]]:
    needle = '<div dir="ltr" class="'
    pos = 0
    blocks: list[tuple[str, str]] = []

    while True:
        i = full_html.find(needle, pos)
        if i == -1:
            break
        j = full_html.find('">', i)
        if j == -1:
            break

        class_attr = full_html[i + len(needle) : j]
        if "r-imh66m" not in class_attr:
            pos = i + 1
            continue

        start = j + 2
        depth = 1
        k = start
        while depth > 0:
            n_open = full_html.find("<div", k)
            n_close = full_html.find("</div>", k)
            if n_close == -1:
                k = len(full_html)
                break
            if n_open != -1 and n_open < n_close:
                depth += 1
                k = n_open + 4
            else:
                depth -= 1
                k = n_close + 6

        fragment = full_html[start : k - 6] if depth == 0 else full_html[start:k]
        role = "user" if "r-1kt6imw" in class_attr else "model"
        blocks.append((role, fragment))
        pos = k

    return blocks


def fragment_to_markdown(fragment_html: str) -> str:
    parser = FragmentToMarkdown()
    parser.feed(fragment_html)
    return parser.get_markdown()


def build_turns(blocks: list[tuple[str, str]]) -> list[tuple[str, str]]:
    turns: list[tuple[str, str]] = []
    q: str | None = None
    answers: list[str] = []

    for role, fragment in blocks:
        text = fragment_to_markdown(fragment)
        if not text:
            continue
        if text in ("키보드 단축키를 보려면 물음표를 누르세요.", "키보드 단축키 보기"):
            continue

        if role == "user":
            if q is not None:
                turns.append((q, "\n\n".join(a for a in answers if a.strip()).strip()))
            q = text
            answers = []
        else:
            if q is None:
                q = "(질문 없음)"
            answers.append(text)

    if q is not None:
        turns.append((q, "\n\n".join(a for a in answers if a.strip()).strip()))
    return turns


def make_md(turns: list[tuple[str, str]], title: str) -> str:
    lines = [f"# {title}", ""]
    for i, (q, a) in enumerate(turns, 1):
        lines += [f"## Turn {i}", "", "### 질문", "", q, "", "### 답변", "", a or "(답변 없음)", ""]
    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("Usage: python mhtml2md-grok-structured.py <file.mhtml> [out.md]")

    src = Path(sys.argv[1]).resolve()
    if not src.exists():
        raise SystemExit(f"File not found: {src}")

    out = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else src.with_suffix(".md")

    html = extract_main_html_from_mhtml(src)
    blocks = extract_message_blocks(html)
    turns = build_turns(blocks)
    md = make_md(turns, f"{src.name} 질문·답변 정리")
    out.write_text(md, encoding="utf-8")
    print(out)
    print(f"turns: {len(turns)}")


if __name__ == "__main__":
    main()

