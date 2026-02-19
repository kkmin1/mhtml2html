#!/usr/bin/env python
from __future__ import annotations

import argparse
import email
from email import policy
import os
from pathlib import Path
import re
from typing import Any

from bs4 import BeautifulSoup, NavigableString, Tag


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert chat MHTML to cleaned Q/A Markdown."
    )
    parser.add_argument("src", type=Path, help="Input .mhtml path")
    parser.add_argument(
        "out",
        type=Path,
        nargs="?",
        help="Output .md path (default: <src>.md)",
    )
    parser.add_argument(
        "--assets-dir",
        type=Path,
        default=None,
        help="Directory to store extracted assets (default: output file directory)",
    )
    return parser.parse_args()


def decode_part(part: Any) -> bytes:
    payload = part.get_payload(decode=True)
    if payload is not None:
        return payload
    raw = part.get_payload()
    if isinstance(raw, str):
        return raw.encode("utf-8", errors="replace")
    if isinstance(raw, bytes):
        return raw
    return b""


def extract_html_and_resources(mhtml_path: Path) -> tuple[str, dict[str, tuple[str, bytes]]]:
    msg = email.message_from_bytes(mhtml_path.read_bytes(), policy=policy.default)
    html_candidates: list[str] = []
    resources: dict[str, tuple[str, bytes]] = {}

    for part in msg.walk():
        ctype = part.get_content_type()
        data = decode_part(part)

        if ctype == "text/html":
            charset = part.get_content_charset() or "utf-8"
            decoded = None
            for enc in (charset, "utf-8", "cp949", "euc-kr", "latin-1"):
                try:
                    decoded = data.decode(enc)
                    break
                except Exception:
                    continue
            html_candidates.append(decoded if decoded is not None else data.decode("utf-8", errors="replace"))

        for key in (part.get("Content-ID"), part.get("Content-Location")):
            if not key:
                continue
            resources[key] = (ctype, data)
            resources[key.strip("<>")] = (ctype, data)

    if not html_candidates:
        raise ValueError("No text/html part found in MHTML.")

    # Longest html part is generally the main captured document.
    return max(html_candidates, key=len), resources


def text_of(el: Tag) -> str:
    txt = el.get_text(" ", strip=True).replace("\xa0", " ")
    return re.sub(r"\s+", " ", txt).strip()


def is_hidden_thinking(node: Tag) -> bool:
    for anc in [node, *node.parents]:
        if not isinstance(anc, Tag):
            continue
        classes = anc.get("class", [])
        cls = " ".join(classes)
        if "thinking-chain-container" in cls:
            return True
        if "thinking-block" in cls:
            return True
        if "overflow-hidden" in classes and "h-0" in classes:
            return True
    return False


def table_to_md(table: Tag) -> str:
    rows: list[list[str]] = []
    for tr in table.find_all("tr"):
        cells = tr.find_all(["th", "td"])
        if not cells:
            continue
        row = [text_of(c).replace("|", r"\|") for c in cells]
        rows.append(row)

    if not rows:
        return ""

    width = max(len(r) for r in rows)
    for r in rows:
        if len(r) < width:
            r.extend([""] * (width - len(r)))

    out = [
        "| " + " | ".join(rows[0]) + " |",
        "| " + " | ".join(["---"] * width) + " |",
    ]
    out.extend("| " + " | ".join(r) + " |" for r in rows[1:])
    return "\n".join(out)


def normalize_svg_markup(svg_markup: str) -> str:
    # Some HTML parsers lowercase SVG attribute names; restore common camelCase names
    # used by diagram.svg-compatible renderers.
    fixed = svg_markup
    attr_map = {
        "viewbox=": "viewBox=",
        "markerwidth=": "markerWidth=",
        "markerheight=": "markerHeight=",
        "refx=": "refX=",
        "refy=": "refY=",
        "preserveaspectratio=": "preserveAspectRatio=",
        "baseprofile=": "baseProfile=",
        "clippathunits=": "clipPathUnits=",
        "gradientunits=": "gradientUnits=",
        "gradienttransform=": "gradientTransform=",
        "patternunits=": "patternUnits=",
        "patterncontentunits=": "patternContentUnits=",
        "patterntransform=": "patternTransform=",
        "maskunits=": "maskUnits=",
        "maskcontentunits=": "maskContentUnits=",
        "contentscripttype=": "contentScriptType=",
        "contentstyletype=": "contentStyleType=",
    }
    for low, camel in attr_map.items():
        fixed = re.sub(rf"(?i)\b{re.escape(low)}", camel, fixed)

    if "<?xml" not in fixed[:80]:
        fixed = '<?xml version="1.0" encoding="UTF-8"?>\n' + fixed
    return fixed


class Converter:
    def __init__(self, resources: dict[str, tuple[str, bytes]], assets_dir: Path, out_dir: Path) -> None:
        self.resources = resources
        self.assets_dir = assets_dir
        self.out_dir = out_dir
        self.image_seq = 1
        self.inline_svg_seq = 1

    def save_cid_image(self, src_value: str) -> str | None:
        key = src_value[4:] if src_value.startswith("cid:") else src_value
        item = self.resources.get(key)
        if item is None:
            return None
        ctype, data = item
        ext = {
            "image/jpeg": ".jpg",
            "image/png": ".png",
            "image/gif": ".gif",
            "image/webp": ".webp",
            "image/svg+xml": ".svg",
        }.get(ctype, ".bin")
        filename = f"img{self.image_seq:03d}{ext}"
        self.image_seq += 1
        path = self.assets_dir / filename
        path.write_bytes(data)
        return Path(os.path.relpath(path, self.out_dir)).as_posix()

    def save_inline_svg(self, svg_markup: str) -> str:
        filename = f"svg{self.inline_svg_seq:03d}.svg"
        self.inline_svg_seq += 1
        path = self.assets_dir / filename
        path.write_text(normalize_svg_markup(svg_markup), encoding="utf-8")
        return Path(os.path.relpath(path, self.out_dir)).as_posix()

    def node_to_md(self, node: Any, depth: int = 0) -> str:
        if isinstance(node, NavigableString):
            return str(node).replace("\xa0", " ")
        if not isinstance(node, Tag):
            return ""

        if is_hidden_thinking(node):
            return ""

        cls = " ".join(node.get("class", []))
        if any(x in cls for x in ("citations", "tooltip", "edit-user-message-button")):
            return ""
        if node.name in ("script", "style", "noscript", "button"):
            return ""

        if node.name == "svg":
            svg_path = self.save_inline_svg(str(node))
            return f"![svg]({svg_path})\n\n"

        if node.name == "img":
            src = node.get("src", "")
            if not src:
                return ""
            if "icon.z.ai" in src:
                return ""
            if src.startswith("cid:"):
                local = self.save_cid_image(src)
                return f"![image]({local})\n\n" if local else ""
            if src.startswith("data:image/svg"):
                svg_path = self.save_inline_svg(src)
                return f"![svg]({svg_path})\n\n"
            # External web images in this export are mostly citation favicons.
            return ""

        if node.name == "br":
            return "\n"

        if node.name in ("h1", "h2", "h3", "h4", "h5", "h6"):
            level = int(node.name[1])
            return "\n" + ("#" * level) + " " + text_of(node) + "\n\n"

        if node.name == "p":
            body = "".join(self.node_to_md(c, depth) for c in node.children).strip()
            return (body + "\n\n") if body else ""

        if node.name in ("div", "section", "article", "blockquote"):
            body = "".join(self.node_to_md(c, depth) for c in node.children).strip()
            return (body + "\n\n") if body else ""

        if node.name == "ul":
            items = []
            for li in node.find_all("li", recursive=False):
                content = "".join(self.node_to_md(c, depth + 1) for c in li.children).strip()
                if content:
                    items.append("  " * depth + "- " + content)
            return ("\n".join(items) + "\n\n") if items else ""

        if node.name == "ol":
            items = []
            idx = 1
            for li in node.find_all("li", recursive=False):
                content = "".join(self.node_to_md(c, depth + 1) for c in li.children).strip()
                if content:
                    items.append("  " * depth + f"{idx}. " + content)
                    idx += 1
            return ("\n".join(items) + "\n\n") if items else ""

        if node.name == "table":
            md_table = table_to_md(node)
            return (md_table + "\n\n") if md_table else ""

        if node.name == "a":
            return "".join(self.node_to_md(c, depth) for c in node.children)

        return "".join(self.node_to_md(c, depth) for c in node.children)


def clean_markdown(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)

    lines: list[str] = []
    for line in text.split("\n"):
        s = line.strip()
        if not s:
            lines.append("")
            continue
        if s.lower() in {"sources", "thought process"}:
            continue
        if re.fullmatch(r"\d{1,3}", s):
            continue
        if re.fullmatch(r"(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}", s):
            continue
        lines.append(s)

    out = "\n".join(lines)
    out = re.sub(r"(?<!\()\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b(?!\))", "", out)
    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r"\n{3,}", "\n\n", out).strip()
    return out + "\n" if out else ""


def build_turns(html: str, converter: Converter) -> list[tuple[str, str]]:
    soup = BeautifulSoup(html, "html.parser")
    turns: list[tuple[str, str]] = []
    pending_question: str | None = None

    for message in soup.select('div[id^="message-"]'):
        classes = message.get("class", [])
        is_user = "user-message" in classes

        if is_user:
            content = message.select_one(".chat-user .rounded-xl") or message.select_one(".chat-user")
            if content is None:
                continue
            q = clean_markdown(converter.node_to_md(content)).strip()
            if not q:
                continue
            if pending_question is not None:
                turns.append((pending_question, "(답변 없음)"))
            pending_question = q
            continue

        content = message.select_one(".chat-assistant .markdown-prose") or message.select_one(".chat-assistant")
        if content is None:
            continue
        a = clean_markdown(converter.node_to_md(content)).strip()
        if not a:
            continue

        if pending_question is None:
            pending_question = "(질문 없음)"
        turns.append((pending_question, a))
        pending_question = None

    if pending_question is not None:
        turns.append((pending_question, "(답변 없음)"))
    return turns


def make_markdown(turns: list[tuple[str, str]]) -> str:
    lines = ["# 질의응답 추출", ""]
    for i, (q, a) in enumerate(turns, 1):
        lines += [f"## Turn {i}", "", "### 질문", "", q, "", "### 답변", "", a, ""]
    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    args = parse_args()
    src = args.src.resolve()
    if not src.exists():
        raise SystemExit(f"Input file not found: {src}")

    out = args.out.resolve() if args.out else src.with_suffix(".md")
    assets_dir = args.assets_dir.resolve() if args.assets_dir else out.parent
    assets_dir.mkdir(parents=True, exist_ok=True)

    html, resources = extract_html_and_resources(src)
    converter = Converter(resources=resources, assets_dir=assets_dir, out_dir=out.parent)
    turns = build_turns(html, converter)
    md = make_markdown(turns)
    out.write_text(md, encoding="utf-8")

    print(out)
    print(f"turns: {len(turns)}")
    print(f"assets: {assets_dir}")


if __name__ == "__main__":
    main()
