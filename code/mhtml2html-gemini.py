from __future__ import annotations

import argparse
import base64
import email
import re
from email import policy
from pathlib import Path

from bs4 import BeautifulSoup
from bs4 import NavigableString


UI_HIDE_CSS = """
/* Keep only conversation content */
.boqOnegoogleliteOgbOneGoogleBar,
#gb,
side-nav-menu-button,
bard-mode-switcher,
top-bar-actions,
input-area-v2,
input-container,
chat-app-banners,
chat-app-tooltips,
chat-notifications,
file-drop-indicator,
toolbox-drawer,
auto-suggest,
at-mentions-menu,
uploader-signed-out-tooltip,
search-nav-button,
whale-quicksearch,
bot-banner,
condensed-tos-disclaimer,
hallucination-disclaimer,
freemium-rag-disclaimer,
freemium-file-upload-near-quota-disclaimer,
freemium-file-upload-quota-exceeded-disclaimer,
sensitive-memories-banner,
response-container-header,
message-actions,
copy-button,
thumb-up-button,
thumb-down-button,
tts-control,
regenerate-button,
conversation-action-menu,
conversation-actions-icon,
button.action-button,
button.main-menu-button,
deepl-input-controller,
.glasp-extension-toaster,
#extension-mmplj,
#glasp-extension-toast-container,
.glasp-ui-wrapper,
#naver_dic-window,
.gb_T,
.cdk-describedby-message-container,
.cdk-live-announcer-element,
audio#naver_dic_audio_controller {
  display: none !important;
}

chat-app,
main.chat-app,
bard-sidenav-container,
bard-sidenav-content,
chat-window,
chat-window-content,
.chat-history-scroll-container,
infinite-scroller.chat-history {
  max-width: 980px !important;
  width: 100% !important;
  margin-left: auto !important;
  margin-right: auto !important;
}

body {
  overflow-x: hidden;
}
""".strip()

MATHJAX_CONFIG = """
window.MathJax = {
  tex: {
    inlineMath: [['$', '$'], ['\\\\(', '\\\\)']],
    displayMath: [['$$', '$$'], ['\\\\[', '\\\\]']]
  },
  options: {
    skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
  }
};
""".strip()


def normalize_cid(value: str) -> str:
  cid = value[4:] if value.startswith("cid:") else value
  return cid.strip().strip("<>")


def sniff_charset_from_html(raw: bytes) -> str | None:
  head = raw[:4096].decode("ascii", errors="ignore")
  m = re.search(r"charset\s*=\s*([A-Za-z0-9._-]+)", head, flags=re.IGNORECASE)
  if m:
    return m.group(1).strip().strip("\"'")
  return None


def decode_part(part):
  raw = part.get_payload(decode=True) or b""
  if not raw:
    return ""

  charset = part.get_content_charset()
  content_type = part.get_content_type()
  if not charset and content_type == "text/html":
    charset = sniff_charset_from_html(raw)

  candidates = []
  for enc in [charset, "utf-8", "cp949", "euc-kr", "windows-1252", "latin-1"]:
    if enc and enc.lower() not in [c.lower() for c in candidates]:
      candidates.append(enc)

  for enc in candidates:
    try:
      return raw.decode(enc)
    except (LookupError, UnicodeDecodeError):
      continue

  return raw.decode("utf-8", errors="replace")


def to_data_uri(part) -> str:
  data = part.get_payload(decode=True) or b""
  mime = part.get_content_type() or "application/octet-stream"
  b64 = base64.b64encode(data).decode("ascii")
  return f"data:{mime};base64,{b64}"


def replace_cid_urls_in_css(css_text: str, cid_map: dict) -> str:
  def repl_url(match):
    cid_ref = match.group(1)
    part = cid_map.get(normalize_cid(cid_ref))
    return f"url('{to_data_uri(part)}')" if part else match.group(0)

  def repl_import(match):
    cid_ref = match.group(1)
    part = cid_map.get(normalize_cid(cid_ref))
    return f"@import url('{to_data_uri(part)}')" if part else match.group(0)

  out = re.sub(r"url\(['\"]?(cid:[^)\"']+)['\"]?\)", repl_url, css_text)
  out = re.sub(r"@import\s+['\"](cid:[^'\"\s;]+)['\"]", repl_import, out)
  return out


def strip_unrendered_markdown_bold(soup: BeautifulSoup) -> None:
  pattern = re.compile(r"\*\*([^*\n][^*\n]*?)\*\*")
  skip_tags = {"script", "style", "code", "pre", "textarea"}

  for node in soup.find_all(string=True):
    if not isinstance(node, NavigableString):
      continue
    parent = node.parent
    if parent is None or parent.name in skip_tags:
      continue
    text = str(node)
    if "**" not in text:
      continue
    cleaned = pattern.sub(r"\1", text)
    if cleaned != text:
      node.replace_with(cleaned)

  # Handle split cases such as '**text <span>...</span> more**' across child nodes.
  block_tags = ["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "td", "th"]
  for tag in soup.find_all(block_tags):
    html = tag.decode_contents()
    if "**" not in html:
      continue
    cleaned_html = re.sub(r"\*\*(.+?)\*\*", r"\1", html, flags=re.DOTALL)
    if cleaned_html == html:
      continue
    frag = BeautifulSoup(cleaned_html, "html.parser")
    tag.clear()
    for child in list(frag.contents):
      tag.append(child)


def main():
  parser = argparse.ArgumentParser(description="Convert MHTML to clean HTML")
  parser.add_argument("input", type=Path)
  parser.add_argument("-o", "--output", type=Path)
  args = parser.parse_args()

  src = args.input
  dst = args.output or src.with_suffix(".html")

  msg = email.message_from_binary_file(src.open("rb"), policy=policy.default)

  cid_map = {}
  html_text = None

  for part in msg.walk():
    content_id = (part.get("Content-ID") or "").strip()
    content_loc = (part.get("Content-Location") or "").strip()
    if content_id:
      cid_map[normalize_cid(content_id)] = part
    if content_loc.startswith("cid:"):
      cid_map[normalize_cid(content_loc)] = part
    if html_text is None and part.get_content_type() == "text/html":
      html_text = decode_part(part)

  if not html_text:
    raise RuntimeError("No text/html part found in MHTML")

  soup = BeautifulSoup(html_text, "html.parser")

  # Inline stylesheet cids.
  for link in list(soup.find_all("link", href=True)):
    href = link["href"]
    if not href.startswith("cid:"):
      continue
    part = cid_map.get(normalize_cid(href))
    if part and part.get_content_type() == "text/css":
      style_tag = soup.new_tag("style")
      style_tag.string = replace_cid_urls_in_css(decode_part(part), cid_map)
      link.replace_with(style_tag)
    else:
      link.decompose()

  # Inline cid resources in common URL attributes.
  for tag in soup.find_all(src=True):
    src_attr = tag.get("src")
    if src_attr and src_attr.startswith("cid:"):
      part = cid_map.get(normalize_cid(src_attr))
      if part:
        tag["src"] = to_data_uri(part)

  for tag in soup.find_all(href=True):
    href = tag.get("href")
    if href and href.startswith("cid:"):
      part = cid_map.get(normalize_cid(href))
      if part:
        tag["href"] = to_data_uri(part)

  for tag in soup.find_all(poster=True):
    poster = tag.get("poster")
    if poster and poster.startswith("cid:"):
      part = cid_map.get(normalize_cid(poster))
      if part:
        tag["poster"] = to_data_uri(part)

  # Replace cid(...) in inline styles.
  for tag in soup.find_all(style=True):
    style = tag.get("style") or ""

    def repl(match):
      cid_ref = match.group(1)
      part = cid_map.get(normalize_cid(cid_ref))
      return f"url('{to_data_uri(part)}')" if part else match.group(0)

    new_style = re.sub(r"url\(['\"]?(cid:[^)\"']+)['\"]?\)", repl, style)
    tag["style"] = new_style

  # Replace cid(...) in embedded <style> text blocks too.
  for style_tag in soup.find_all("style"):
    css_text = style_tag.string
    if css_text and "cid:" in css_text:
      style_tag.string = replace_cid_urls_in_css(css_text, cid_map)

  # Remove preload hints and external script references from archived app shell.
  for link in list(soup.find_all("link", rel=True)):
    rel_values = [r.lower() for r in (link.get("rel") or [])]
    if "preload" in rel_values:
      link.decompose()

  # Remove literal markdown bold markers that were not rendered.
  strip_unrendered_markdown_bold(soup)

  # Remove script execution from archived app.
  for script in list(soup.find_all("script")):
    script.decompose()

  # Keep only the conversation body to avoid hidden app-shell layouts.
  conversation = soup.find("chat-window-content")
  if conversation and soup.body:
    conversation.extract()
    new_body = soup.new_tag("body")
    content_root = soup.new_tag("main", id="content-root")
    content_root.append(conversation)
    new_body.append(content_root)
    soup.body.replace_with(new_body)

  # Inject cleanup CSS and MathJax.
  head = soup.head or soup.new_tag("head")
  if soup.head is None and soup.html is not None:
    soup.html.insert(0, head)

  cleanup_style = soup.new_tag("style", id="clean-content-style")
  cleanup_style.string = UI_HIDE_CSS
  head.append(cleanup_style)

  mj_cfg = soup.new_tag("script")
  mj_cfg.string = MATHJAX_CONFIG
  head.append(mj_cfg)

  mj_src = soup.new_tag(
      "script",
      src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js",
      id="mathjax-script",
      defer=True,
  )
  head.append(mj_src)

  # Ensure UTF-8 declaration.
  if not soup.find("meta", attrs={"charset": True}):
    meta = soup.new_tag("meta", charset="UTF-8")
    head.insert(0, meta)

  html_out = str(soup).replace("**", "")
  dst.write_text(html_out, encoding="utf-8")
  print(f"Saved: {dst}")


if __name__ == "__main__":
  main()
