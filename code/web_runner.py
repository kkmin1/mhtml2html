from __future__ import annotations

import shlex
import subprocess
import sys
from pathlib import Path

from flask import Flask, redirect, render_template_string, request, url_for

BASE_DIR = Path(__file__).resolve().parent
APP_FILE = Path(__file__).name

SCRIPT_GLOBS = ("*.py",)
INPUT_GLOBS = ("*.mhtml", "*.html", "*.txt", "*.md")

HTML_TEMPLATE = """
<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MHTML 변환 실행기</title>
  <style>
    :root {
      --bg: #f3f2ee;
      --panel: #fffdf8;
      --line: #d6d2c8;
      --text: #1f2523;
      --muted: #5c6662;
      --accent: #0f766e;
      --accent-2: #0b5f59;
      --error: #b42318;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      background: radial-gradient(circle at 0 0, #dcefe9 0, var(--bg) 55%);
      color: var(--text);
      font-family: "Segoe UI", "Noto Sans KR", sans-serif;
    }
    .wrap {
      max-width: 960px;
      margin: 0 auto;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 20px;
    }
    h1 { margin: 0 0 12px; font-size: 1.35rem; }
    p { color: var(--muted); margin-top: 0; }
    form { display: grid; gap: 12px; }
    label { font-weight: 600; font-size: 0.95rem; }
    select, input {
      width: 100%;
      margin-top: 6px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      font-size: 0.95rem;
      background: #fff;
      color: var(--text);
    }
    .row { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
    button {
      border: 0;
      border-radius: 8px;
      padding: 10px 14px;
      font-weight: 700;
      color: #fff;
      background: var(--accent);
      cursor: pointer;
    }
    .ghost {
      background: #5d6763;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 10px 14px;
      border-radius: 8px;
      color: #fff;
      font-weight: 700;
    }
    button:hover { background: var(--accent-2); }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      background: #f7f8f8;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      margin-top: 8px;
      max-height: 420px;
      overflow: auto;
    }
    .ok { color: var(--accent-2); font-weight: 700; }
    .error { color: var(--error); font-weight: 700; }
    code { background: #e8eceb; padding: 1px 5px; border-radius: 5px; }
    @media (max-width: 760px) { .row { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main class="wrap">
    <h1>변환 스크립트 웹 실행기</h1>
    <p>폴더 내 파이썬 변환 스크립트와 입력 파일을 선택해서 실행합니다. 출력 인자 방식은 스크립트별로 선택하세요.</p>

    <form method="post" action="{{ url_for('run') }}">
      <label>
        파이썬 스크립트
        <select name="script" required>
          <option value="">-- 선택 --</option>
          {% for item in scripts %}
            <option value="{{ item }}" {% if selected_script == item %}selected{% endif %}>{{ item }}</option>
          {% endfor %}
        </select>
      </label>

      <label>
        입력 파일
        <select name="input_file" required>
          <option value="">-- 선택 --</option>
          {% for item in input_files %}
            <option value="{{ item }}" {% if selected_input == item %}selected{% endif %}>{{ item }}</option>
          {% endfor %}
        </select>
      </label>

      <div class="row">
        <label>
          출력 파일 경로 (선택)
          <input type="text" name="output_file" value="{{ output_file }}" placeholder="예: sample.out.html">
        </label>

        <label>
          출력 인자 방식
          <select name="output_mode">
            <option value="none" {% if output_mode == 'none' %}selected{% endif %}>사용 안 함</option>
            <option value="positional" {% if output_mode == 'positional' %}selected{% endif %}>positional 인자</option>
            <option value="dash_o" {% if output_mode == 'dash_o' %}selected{% endif %}>-o / --output</option>
          </select>
        </label>
      </div>

      <label>
        추가 인자 (선택)
        <input type="text" name="extra_args" value="{{ extra_args }}" placeholder="예: --assets-dir f_assets">
      </label>

      <div class="actions">
        <button type="submit">실행</button>
        <a class="ghost" href="{{ url_for('index') }}">새로고침</a>
      </div>
    </form>

    {% if command %}
      <h2>실행 명령</h2>
      <pre><code>{{ command }}</code></pre>
    {% endif %}

    {% if status %}
      <h2>실행 결과</h2>
      <div class="{{ 'ok' if status == 'success' else 'error' }}">{{ status_message }}</div>
      <pre>{{ output_text }}</pre>
    {% endif %}

  </main>
</body>
</html>
"""


def list_scripts() -> list[str]:
    scripts: set[str] = set()
    for pattern in SCRIPT_GLOBS:
        for path in BASE_DIR.rglob(pattern):
            if "__pycache__" in path.parts:
                continue
            if path.name == APP_FILE:
                continue
            scripts.add(path.relative_to(BASE_DIR).as_posix())
    return sorted(scripts)


def list_input_files() -> list[str]:
    files: set[str] = set()
    for pattern in INPUT_GLOBS:
        for path in BASE_DIR.rglob(pattern):
            if "__pycache__" in path.parts:
                continue
            if path.is_file():
                files.add(path.relative_to(BASE_DIR).as_posix())
    return sorted(files)


def safe_resolve(rel_name: str) -> Path:
    candidate = (BASE_DIR / rel_name).resolve()
    candidate.relative_to(BASE_DIR)
    return candidate


def build_command(script: str, input_file: str, output_file: str, output_mode: str, extra_args: str) -> list[str]:
    cmd = [sys.executable, str(safe_resolve(script)), str(safe_resolve(input_file))]

    out = output_file.strip()
    if out:
        output_path = str(safe_resolve(out))
        if output_mode == "positional":
            cmd.append(output_path)
        elif output_mode == "dash_o":
            cmd.extend(["-o", output_path])

    if extra_args.strip():
        cmd.extend(shlex.split(extra_args, posix=False))

    return cmd


app = Flask(__name__)


@app.get("/")
def index():
    return render_template_string(
        HTML_TEMPLATE,
        scripts=list_scripts(),
        input_files=list_input_files(),
        selected_script="",
        selected_input="",
        output_file="",
        output_mode="none",
        extra_args="",
        command="",
        status="",
        status_message="",
        output_text="",
    )


@app.post("/run")
def run():
    script = (request.form.get("script") or "").strip()
    input_file = (request.form.get("input_file") or "").strip()
    output_file = request.form.get("output_file") or ""
    output_mode = request.form.get("output_mode") or "none"
    extra_args = request.form.get("extra_args") or ""

    if not script or not input_file:
        return redirect(url_for("index"))

    try:
        cmd = build_command(script, input_file, output_file, output_mode, extra_args)
    except Exception as exc:
        return render_template_string(
            HTML_TEMPLATE,
            scripts=list_scripts(),
            input_files=list_input_files(),
            selected_script=script,
            selected_input=input_file,
            output_file=output_file,
            output_mode=output_mode,
            extra_args=extra_args,
            command="",
            status="error",
            status_message="경로 오류",
            output_text=str(exc),
        )

    try:
        result = subprocess.run(
            cmd,
            cwd=str(BASE_DIR),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=1800,
        )
    except subprocess.TimeoutExpired:
        return render_template_string(
            HTML_TEMPLATE,
            scripts=list_scripts(),
            input_files=list_input_files(),
            selected_script=script,
            selected_input=input_file,
            output_file=output_file,
            output_mode=output_mode,
            extra_args=extra_args,
            command=subprocess.list2cmdline(cmd),
            status="error",
            status_message="실패 (timeout 1800초)",
            output_text="변환 실행 시간이 1800초를 초과했습니다.",
        )

    combined = "\n".join(
        part for part in [result.stdout.strip(), result.stderr.strip()] if part
    ).strip()
    if not combined:
        combined = "(출력 없음)"

    is_success = result.returncode == 0

    return render_template_string(
        HTML_TEMPLATE,
        scripts=list_scripts(),
        input_files=list_input_files(),
        selected_script=script,
        selected_input=input_file,
        output_file=output_file,
        output_mode=output_mode,
        extra_args=extra_args,
        command=subprocess.list2cmdline(cmd),
        status="success" if is_success else "error",
        status_message="성공" if is_success else f"실패 (exit code {result.returncode})",
        output_text=combined,
    )


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
