#!/usr/bin/env python3
"""
Claude 대화 MHTML → HTML 변환기
-------------------------------
claude.ai에서 저장한 .mhtml 파일을 사이드바·입력창 없이
순수 질의/응답 내용만의 HTML 파일로 변환합니다.

사용법:
    python claude_mhtml_to_html.py <입력파일.mhtml> [출력파일.html]

    출력파일을 생략하면 입력파일명과 같은 이름의 .html 파일을 생성합니다.

요구사항:
    pip install beautifulsoup4
"""

import re
import sys
import os
from bs4 import BeautifulSoup


# ─────────────────────────────────────────────
#  HTML 템플릿 (CSS 포함)
# ─────────────────────────────────────────────

CSS = """
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: 'Apple SD Gothic Neo', 'Noto Sans KR', 'Malgun Gothic', sans-serif;
  background: #f5f4ef;
  color: #1a1a1a;
  line-height: 1.7;
  padding: 2rem 1rem 4rem;
}

.chat-wrapper {
  max-width: 780px;
  margin: 0 auto;
}

.chat-title {
  text-align: center;
  font-size: 1.1rem;
  font-weight: 600;
  color: #5a5a5a;
  padding: 1.5rem 0 2.5rem;
  letter-spacing: -0.01em;
}

.turn {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin-bottom: 2.5rem;
}

.message {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
}

.avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 700;
  margin-top: 2px;
}

.user-avatar  { background: #e0dbd0; color: #5a5450; }
.claude-avatar { background: #d4704a; color: white; }

.bubble {
  border-radius: 1rem;
  padding: 0.85rem 1.1rem;
  max-width: calc(100% - 44px);
  line-height: 1.7;
  font-size: 0.95rem;
}

/* 사용자 메시지 — 오른쪽 정렬 */
.user-message { flex-direction: row-reverse; }
.user-bubble {
  background: #e8e4dc;
  border-radius: 1rem 0.25rem 1rem 1rem;
  color: #2a2520;
}
.user-text { white-space: pre-wrap; word-break: break-word; }

/* Claude 메시지 — 왼쪽 정렬 */
.claude-message { flex-direction: row; }
.claude-bubble {
  background: #ffffff;
  border: 1px solid #e8e4dc;
  border-radius: 0.25rem 1rem 1rem 1rem;
  color: #1a1a1a;
  box-shadow: 0 1px 3px rgba(0,0,0,0.06);
}

/* Claude 버블 내부 타이포그래피 */
.claude-bubble h1,
.claude-bubble h2 {
  font-size: 1.05rem;
  font-weight: 700;
  color: #1a1a1a;
  margin: 1rem 0 0.4rem;
  padding-bottom: 0.3rem;
  border-bottom: 1px solid #ece8e0;
}
.claude-bubble h2:first-child,
.claude-bubble h1:first-child { margin-top: 0; }

.claude-bubble h3 {
  font-size: 0.95rem;
  font-weight: 700;
  color: #333;
  margin: 0.8rem 0 0.3rem;
}

.claude-bubble p {
  margin-bottom: 0.6rem;
  word-break: break-word;
}
.claude-bubble p:last-child { margin-bottom: 0; }

.claude-bubble ul,
.claude-bubble ol {
  padding-left: 1.4rem;
  margin-bottom: 0.6rem;
}
.claude-bubble li {
  margin-bottom: 0.25rem;
  word-break: break-word;
}

.claude-bubble blockquote {
  border-left: 3px solid #d4704a;
  padding: 0.4rem 0 0.4rem 1rem;
  margin: 0.5rem 0;
  color: #555;
  font-style: italic;
}

.claude-bubble hr {
  border: none;
  border-top: 1px solid #ece8e0;
  margin: 0.8rem 0;
}

.claude-bubble strong { font-weight: 700; color: #111; }
.claude-bubble em     { font-style: italic; color: #444; }

/* 참고 링크 */
.claude-bubble a {
  color: #b85c30;
  text-decoration: underline;
  text-underline-offset: 2px;
  word-break: break-all;
}
.claude-bubble a:hover { color: #8a3d1e; }

/* 표 */
.claude-bubble table {
  border-collapse: collapse;
  width: 100%;
  font-size: 0.88rem;
  margin: 0.6rem 0;
  overflow-x: auto;
  display: block;
}
.claude-bubble th {
  background: #f5f2ec;
  font-weight: 700;
  text-align: left;
  padding: 0.45rem 0.7rem;
  border-bottom: 2px solid #d8d2c6;
  white-space: nowrap;
}
.claude-bubble td {
  padding: 0.4rem 0.7rem;
  border-bottom: 1px solid #ece8e0;
  vertical-align: top;
}
.claude-bubble tr:last-child td { border-bottom: none; }

/* 코드 */
.claude-bubble code {
  font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 0.85em;
  background: #f0ede6;
  padding: 0.1em 0.35em;
  border-radius: 3px;
}
.claude-bubble pre {
  background: #f0ede6;
  border-radius: 6px;
  padding: 0.85rem 1rem;
  overflow-x: auto;
  margin: 0.6rem 0;
}
.claude-bubble pre code {
  background: none;
  padding: 0;
  font-size: 0.85rem;
}

@media (max-width: 600px) {
  body { padding: 1rem 0.5rem 3rem; }
  .bubble { font-size: 0.9rem; }
  .avatar { width: 28px; height: 28px; }
}
"""

CLAUDE_ICON_SVG = """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"
     width="18" height="18" fill="currentColor" aria-hidden="true">
  <path d="M22 9c.4-1.1 1.6-1.1 2 0l3 8.5h9c1 0 1.4 1.3.6 1.9
           l-7.3 5.3 2.8 8.5c.3 1-.8 1.7-1.6 1.1L20 29l-10.5 5.3
           c-.8.6-1.9-.1-1.6-1.1l2.8-8.5L3.4 19.4c-.8-.6-.4-1.9.6-1.9
           h9L16 9z"/>
</svg>
"""

HTML_TEMPLATE = """\
<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<style>
{css}
</style>
</head>
<body>
<div class="chat-wrapper">
  <div class="chat-title">{title}</div>
  {turns}
</div>
</body>
</html>
"""


# ─────────────────────────────────────────────
#  파싱 / 변환 함수
# ─────────────────────────────────────────────

def load_html_from_mhtml(path: str) -> str:
    """MHTML 파일에서 첫 번째 HTML 파트를 추출합니다."""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        raw = f.read()

    boundary_match = re.search(r'boundary="([^"]+)"', raw)
    if not boundary_match:
        raise ValueError("MHTML boundary를 찾을 수 없습니다.")

    boundary = boundary_match.group(1)
    parts = raw.split("------" + boundary.replace("----", ""))

    for part in parts[1:]:
        if "text/html" in part[:200]:
            start = part.find("<!DOCTYPE")
            if start == -1:
                start = part.find("<html")
            if start != -1:
                return part[start:]

    raise ValueError("HTML 파트를 찾을 수 없습니다.")


def extract_clean_html(el) -> str:
    """
    Claude 응답 div에서 순수 콘텐츠 HTML을 추출합니다.
    - UI 버튼·아이콘 제거
    - Tailwind 클래스·인라인 스타일 제거
    - <a href> 링크는 보존
    """
    el_copy = BeautifulSoup(str(el), "html.parser")

    # 불필요한 UI 요소 제거
    for tag in el_copy.find_all(["button", "svg", "path", "script", "style"]):
        tag.decompose()
    for tag in el_copy.find_all(
        class_=lambda c: c and ("sr-only" in c or "group/status" in str(c))
    ):
        tag.decompose()

    # standard-markdown 영역만 추출
    md_divs = el_copy.find_all(
        "div", class_=lambda c: c and "standard-markdown" in str(c)
    )

    result_parts = []
    for md_div in md_divs:
        # 모든 태그에서 class/style 제거 — href 같은 유용한 속성은 보존
        for tag in md_div.find_all(True):
            keep_attrs = {}
            for attr in ("href", "src", "alt", "scope", "colspan", "rowspan", "target", "rel"):
                if tag.get(attr):
                    keep_attrs[attr] = tag[attr]
            # 외부 링크에 target=_blank 추가
            if tag.name == "a" and tag.get("href", "").startswith("http"):
                keep_attrs["target"] = "_blank"
                keep_attrs["rel"] = "noopener noreferrer"
            tag.attrs = keep_attrs

        result_parts.append(
            "".join(str(c) for c in md_div.children)
        )

    return "\n".join(result_parts) if result_parts else el_copy.get_text()


def build_turn_html(user_text: str, claude_html: str) -> str:
    user_escaped = (
        user_text
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
    return f"""
    <div class="turn">
      <div class="message user-message">
        <div class="avatar user-avatar">나</div>
        <div class="bubble user-bubble">
          <p class="user-text">{user_escaped}</p>
        </div>
      </div>
      <div class="message claude-message">
        <div class="avatar claude-avatar">{CLAUDE_ICON_SVG}</div>
        <div class="bubble claude-bubble">
          {claude_html}
        </div>
      </div>
    </div>
"""


def convert(input_path: str, output_path: str) -> None:
    print(f"읽는 중: {input_path}")
    html_content = load_html_from_mhtml(input_path)
    soup = BeautifulSoup(html_content, "html.parser")

    # 제목 추출
    title_tag = soup.find("title")
    title = title_tag.get_text().strip() if title_tag else os.path.splitext(os.path.basename(input_path))[0]
    # " - Claude" 접미사 정리
    title = re.sub(r"\s*[-–]\s*Claude\s*$", "", title).strip() or title

    # 메시지 쌍 추출
    user_msgs = soup.find_all(attrs={"data-testid": "user-message"})
    claude_divs = soup.find_all(
        "div",
        class_=lambda c: c and "font-claude-response" in c and len(c) > 3,
    )

    if not user_msgs:
        raise ValueError("사용자 메시지를 찾을 수 없습니다. Claude 대화 MHTML 파일인지 확인하세요.")

    count = min(len(user_msgs), len(claude_divs))
    print(f"  대화 쌍 {count}개 발견")

    turns_html = ""
    for i in range(count):
        user_text = user_msgs[i].get_text()
        claude_html = extract_clean_html(claude_divs[i])
        turns_html += build_turn_html(user_text, claude_html)

    output_html = HTML_TEMPLATE.format(
        title=title,
        css=CSS,
        turns=turns_html,
    )

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(output_html)

    size_kb = os.path.getsize(output_path) / 1024
    print(f"  저장 완료: {output_path} ({size_kb:.1f} KB)")


# ─────────────────────────────────────────────
#  엔트리포인트
# ─────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    input_path = sys.argv[1]

    if not os.path.exists(input_path):
        print(f"오류: 파일을 찾을 수 없습니다 — {input_path}")
        sys.exit(1)

    if len(sys.argv) >= 3:
        output_path = sys.argv[2]
    else:
        base = os.path.splitext(input_path)[0]
        output_path = base + ".html"

    convert(input_path, output_path)


if __name__ == "__main__":
    main()
