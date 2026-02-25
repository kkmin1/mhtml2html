#!/usr/bin/env python
import re
from pathlib import Path
import email
from email import policy
from typing import cast
import html as html_lib


def extract_html_from_mhtml(mhtml_path: Path) -> str:
    raw = mhtml_path.read_bytes()
    msg = email.message_from_bytes(raw, policy=policy.default)

    html_bytes: bytes | None = None
    html_part = None
    for part in msg.walk():
        if part.get_content_type() == "text/html":
            html_bytes = cast(bytes | None, part.get_payload(decode=True))
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
            html_part = part
            break

    if html_bytes is None:
        raise ValueError("No text/html part found in MHTML.")

    charset = html_part.get_content_charset() if html_part else None
    for enc in (charset, "utf-8", "cp949", "euc-kr"):
        if not enc:
            continue
        try:
            return html_bytes.decode(enc)
        except Exception:
            continue

    return html_bytes.decode("utf-8", errors="replace")


def html_to_text(fragment: str) -> str:
    text = re.sub(r"(?i)<br\s*/?>", "\n", fragment)
    text = re.sub(r"(?i)</(p|div|li|ul|ol|blockquote|h[1-6]|tr|table|section|article)>", "\n", text)
    text = re.sub(r"(?i)<(p|div|li|ul|ol|blockquote|h[1-6]|tr|table|section|article)[^>]*>", "\n", text)
    text = re.sub(r"(?i)<td[^>]*>", "\t", text)
    text = re.sub(r"(?i)</td>", "\t", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = html_lib.unescape(text)
    text = re.sub(r"\r\n?", "\n", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_main_paragraphs(html: str) -> list[str]:
    html = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", "", html)

    paras: list[str] = []
    for m in re.finditer(r"(?is)<p[^>]*>(.*?)</p>", html):
        txt = re.sub(r"<[^>]+>", "", m.group(1))
        txt = html_lib.unescape(txt)
        txt = re.sub(r"\s+", " ", txt).strip()
        if txt:
            paras.append(txt)

    bad_re = re.compile(
        r"(微信|支付宝|VIP|恢复|商户|扫码|支付|个人图书馆|收藏|阅读|转藏|来源|展开全文|登录|注册|分享|猜你喜欢|相关推荐|热门|关注|回复|评论|举报|版权|免责声明|360doc)",
        re.I,
    )
    stop_re = re.compile(r"(\|\||客服工作时间)", re.I)

    main_paras: list[str] = []
    seen = set()
    for p in paras:
        if stop_re.search(p):
            break
        if len(p) < 30:
            continue
        if bad_re.search(p):
            continue
        if p in seen:
            continue
        seen.add(p)
        main_paras.append(p)

    if len(main_paras) < 3:
        m = re.search(r'(?is)name="360docabstract" content="(.*?)"', html)
        if m:
            abstract = html_lib.unescape(m.group(1).strip())
            if abstract:
                main_paras.append(abstract)

    return main_paras


def mhtml_to_md(mhtml_path: Path, out_path: Path | None = None) -> Path:
    html = extract_html_from_mhtml(mhtml_path)
    title_match = re.search(r"(?is)<title[^>]*>(.*?)</title>", html)
    title = html_lib.unescape(title_match.group(1).strip()) if title_match else "문서"

    paras = extract_main_paragraphs(html)

    md_lines = [f"# {title}", ""]
    md_lines.extend(paras)
    md = "\n\n".join(md_lines).strip() + "\n"

    if out_path is None:
        out_path = mhtml_path.with_suffix(".md")

    out_path.write_text(md, encoding="utf-8")
    return out_path


def main() -> None:
    import sys

    if len(sys.argv) < 2:
        raise SystemExit("Usage: python mhtml_to_md.py <file.mhtml> [out.md]")

    mhtml_path = Path(sys.argv[1]).resolve()
    out_path = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else None
    if not mhtml_path.exists():
        raise SystemExit(f"MHTML not found: {mhtml_path}")

    result = mhtml_to_md(mhtml_path, out_path)
    print(result)


if __name__ == "__main__":
    main()
