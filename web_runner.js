#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const http = require("http");

const BASE_DIR = path.resolve(__dirname);
const APP_FILE = path.basename(__filename);
const MAX_BODY_BYTES = 220 * 1024 * 1024;

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__pycache__" || entry.name === "node_modules") {
        continue;
      }
      walkFiles(p, out);
      continue;
    }
    out.push(p);
  }
  return out;
}

function listScripts() {
  return walkFiles(BASE_DIR)
    .filter((p) => path.extname(p).toLowerCase() === ".js")
    .filter((p) => path.basename(p) !== APP_FILE)
    .map((p) => path.relative(BASE_DIR, p).replace(/\\/g, "/"))
    .sort();
}

function safeScriptPath(rel) {
  const abs = path.resolve(BASE_DIR, rel);
  const relPath = path.relative(BASE_DIR, abs);
  if (relPath.startsWith("..") || path.isAbsolute(relPath)) {
    throw new Error("Invalid script path.");
  }
  if (!fs.existsSync(abs)) {
    throw new Error(`Script not found: ${rel}`);
  }
  if (path.extname(abs).toLowerCase() !== ".js") {
    throw new Error("Only .js scripts are allowed.");
  }
  return abs;
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error("Invalid JSON request body."));
      }
    });
    req.on("error", reject);
  });
}

function parseOutputPathFromStdout(stdoutText, tmpDir) {
  const lines = stdoutText
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

  for (const line of lines) {
    let candidate = line;
    if (candidate.startsWith("Saved: ")) {
      candidate = candidate.slice(7).trim();
    }
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  const files = fs
    .readdirSync(tmpDir)
    .map((name) => path.join(tmpDir, name))
    .filter((p) => fs.statSync(p).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files.length ? files[0] : null;
}

function extByScript(scriptRel, inputName) {
  const name = scriptRel.toLowerCase();
  const baseInput = inputName.replace(/\.[^.]+$/, "");
  if (name.includes("mhtml2txt")) {
    return `${baseInput}.qa.txt`;
  }
  if (name.includes("txt2html") || name.includes("mhtml2html")) {
    return `${baseInput}.html`;
  }
  if (name.includes("md")) {
    return `${baseInput}.md`;
  }
  return `${baseInput}.out`;
}

function pageHtml() {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>JS 변환기</title>
  <style>
    :root {
      --bg: #eef4f8;
      --panel: #ffffff;
      --line: #d0dbe6;
      --text: #1f2933;
      --muted: #5f6c7b;
      --brand: #0d9488;
      --brand-2: #0b7f74;
      --error: #b42318;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 24px;
      font-family: "Segoe UI", "Noto Sans KR", sans-serif;
      background: radial-gradient(circle at 0 0, #dbe9f4 0, var(--bg) 52%);
      color: var(--text);
    }
    .wrap {
      max-width: 940px; margin: 0 auto; background: var(--panel);
      border: 1px solid var(--line); border-radius: 14px; padding: 20px;
    }
    h1 { margin: 0 0 10px; font-size: 1.35rem; }
    p { margin: 0; color: var(--muted); }
    .grid { display: grid; gap: 14px; margin-top: 16px; }
    label { font-weight: 700; font-size: 0.95rem; }
    select, input[type="text"] {
      width: 100%; margin-top: 6px; padding: 10px;
      border: 1px solid var(--line); border-radius: 8px; font-size: 0.95rem;
    }
    .row { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
    .card {
      border: 1px solid var(--line); border-radius: 10px; padding: 12px; background: #f8fbff;
    }
    .btns { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
    button {
      border: 0; border-radius: 8px; padding: 10px 14px;
      color: #fff; background: var(--brand); font-weight: 700; cursor: pointer;
    }
    button:hover { background: var(--brand-2); }
    button.secondary { background: #556170; }
    .muted { color: var(--muted); font-size: 0.92rem; }
    .ok { color: #127a5f; font-weight: 700; }
    .err { color: var(--error); font-weight: 700; }
    pre {
      margin-top: 10px; white-space: pre-wrap; word-break: break-word;
      border: 1px solid var(--line); border-radius: 8px; background: #f7f9fb; padding: 10px;
      max-height: 320px; overflow: auto;
    }
    @media (max-width: 760px) { .row { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main class="wrap">
    <h1>JS 변환 스크립트 실행기</h1>
    <p>스크립트 선택, 입력 파일 선택, 출력 폴더 선택(탐색기), 출력 파일명 변경 후 실행할 수 있습니다.</p>

    <section class="grid">
      <label>
        스크립트(.js)
        <select id="scriptSelect"></select>
      </label>

      <div class="row">
        <div class="card">
          <label>입력 파일</label>
          <div class="btns">
            <button type="button" id="pickInputBtn">파일 선택</button>
          </div>
          <div id="inputInfo" class="muted">선택 안 됨</div>
        </div>
        <div class="card">
          <label>출력 폴더</label>
          <div class="btns">
            <button type="button" id="pickOutDirBtn">폴더 선택</button>
          </div>
          <div id="outDirInfo" class="muted">선택 안 됨</div>
        </div>
      </div>

      <label>
        출력 파일명 (변경 가능)
        <input id="outputName" type="text" placeholder="예: result.html">
      </label>

      <div class="btns">
        <button type="button" id="runBtn">변환 실행</button>
        <button type="button" class="secondary" id="refreshScriptsBtn">스크립트 새로고침</button>
      </div>

      <div id="status" class="muted"></div>
      <pre id="log" hidden></pre>
    </section>
  </main>

  <script>
    const scriptSelect = document.getElementById("scriptSelect");
    const pickInputBtn = document.getElementById("pickInputBtn");
    const pickOutDirBtn = document.getElementById("pickOutDirBtn");
    const outputNameEl = document.getElementById("outputName");
    const runBtn = document.getElementById("runBtn");
    const refreshScriptsBtn = document.getElementById("refreshScriptsBtn");
    const inputInfo = document.getElementById("inputInfo");
    const outDirInfo = document.getElementById("outDirInfo");
    const statusEl = document.getElementById("status");
    const logEl = document.getElementById("log");

    let inputFile = null;
    let outputDirHandle = null;

    function setStatus(text, cls = "muted") {
      statusEl.className = cls;
      statusEl.textContent = text;
    }

    function setLog(text) {
      if (!text) {
        logEl.hidden = true;
        logEl.textContent = "";
        return;
      }
      logEl.hidden = false;
      logEl.textContent = text;
    }

    function guessOutputName(script, inputName) {
      if (!script || !inputName) return "";
      const base = inputName.replace(/\\.[^.]+$/, "");
      const lower = script.toLowerCase();
      if (lower.includes("mhtml2txt")) return base + ".qa.txt";
      if (lower.includes("txt2html") || lower.includes("mhtml2html")) return base + ".html";
      if (lower.includes("md")) return base + ".md";
      return base + ".out";
    }

    async function loadScripts() {
      const res = await fetch("/api/scripts");
      if (!res.ok) throw new Error("스크립트 목록 조회 실패");
      const data = await res.json();
      scriptSelect.innerHTML = "";
      for (const s of data.scripts || []) {
        const opt = document.createElement("option");
        opt.value = s;
        opt.textContent = s;
        scriptSelect.appendChild(opt);
      }
      if (scriptSelect.options.length === 0) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "(실행 가능한 .js 스크립트 없음)";
        scriptSelect.appendChild(opt);
      }
      if (inputFile) {
        outputNameEl.value = guessOutputName(scriptSelect.value, inputFile.name);
      }
    }

    async function pickInputFile() {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: [{
          description: "지원 파일",
          accept: { "application/octet-stream": [".mhtml", ".html", ".txt", ".md"] }
        }]
      });
      inputFile = await handle.getFile();
      inputInfo.textContent = inputFile.name + " (" + inputFile.size.toLocaleString() + " bytes)";
      if (!outputNameEl.value) {
        outputNameEl.value = guessOutputName(scriptSelect.value, inputFile.name);
      }
    }

    async function pickOutputDir() {
      outputDirHandle = await window.showDirectoryPicker();
      outDirInfo.textContent = outputDirHandle.name;
    }

    async function toBase64(file) {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    }

    async function saveToPickedFolder(filename, bytes) {
      if (!outputDirHandle) throw new Error("출력 폴더를 먼저 선택하세요.");
      const handle = await outputDirHandle.getFileHandle(filename, { create: true });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
    }

    async function runConvert() {
      try {
        setLog("");
        setStatus("변환 준비 중...");

        const script = scriptSelect.value;
        if (!script) throw new Error("스크립트를 선택하세요.");
        if (!inputFile) throw new Error("입력 파일을 선택하세요.");
        if (!outputDirHandle) throw new Error("출력 폴더를 선택하세요.");

        const outputName = (outputNameEl.value || "").trim();
        if (!outputName) throw new Error("출력 파일명을 입력하세요.");
        if (/[\\\\/:*?"<>|]/.test(outputName)) throw new Error("출력 파일명에 금지 문자가 있습니다.");

        setStatus("파일 업로드 및 변환 실행 중...");
        const inputBase64 = await toBase64(inputFile);
        const res = await fetch("/api/convert", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            script,
            inputName: inputFile.name,
            inputBase64
          })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || "변환 실패");
        }

        const bin = Uint8Array.from(atob(data.outputBase64), (c) => c.charCodeAt(0));
        await saveToPickedFolder(outputName, bin);

        setStatus("완료: " + outputName + " 저장됨", "ok");
        setLog(data.log || "");
      } catch (err) {
        setStatus(String(err.message || err), "err");
      }
    }

    scriptSelect.addEventListener("change", () => {
      if (inputFile) {
        outputNameEl.value = guessOutputName(scriptSelect.value, inputFile.name);
      }
    });
    pickInputBtn.addEventListener("click", pickInputFile);
    pickOutDirBtn.addEventListener("click", pickOutputDir);
    runBtn.addEventListener("click", runConvert);
    refreshScriptsBtn.addEventListener("click", loadScripts);

    (async () => {
      if (!window.showOpenFilePicker || !window.showDirectoryPicker) {
        setStatus("이 브라우저는 탐색기 기반 파일/폴더 선택 API를 지원하지 않습니다. Chrome/Edge 최신 버전을 사용하세요.", "err");
      }
      try {
        await loadScripts();
        setStatus("준비됨");
      } catch (e) {
        setStatus(e.message || "초기화 실패", "err");
      }
    })();
  </script>
</body>
</html>`;
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function runConversion({ script, inputName, inputBase64 }) {
  if (!script || !inputName || !inputBase64) {
    throw new Error("Missing required fields.");
  }

  const scriptAbs = safeScriptPath(script);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mht2html-"));
  try {
    const safeInputName = path.basename(inputName);
    const inputPath = path.join(tmpDir, safeInputName);
    fs.writeFileSync(inputPath, Buffer.from(inputBase64, "base64"));

    const outputGuess = extByScript(script, safeInputName);
    const outputPath = path.join(tmpDir, outputGuess);

    const proc = spawnSync(process.execPath, [scriptAbs, inputPath, outputPath], {
      cwd: BASE_DIR,
      encoding: "utf8",
      timeout: 1800 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });

    const combined = [proc.stdout || "", proc.stderr || ""].join("\n").trim();
    if (proc.error) {
      throw proc.error;
    }
    if (proc.status !== 0) {
      throw new Error(combined || `Process failed with code ${proc.status}`);
    }

    const detected = parseOutputPathFromStdout(combined, tmpDir);
    if (!detected || !fs.existsSync(detected)) {
      throw new Error("Failed to locate output file.");
    }
    const outBuffer = fs.readFileSync(detected);

    return {
      outputFileName: path.basename(detected),
      outputBase64: outBuffer.toString("base64"),
      log: combined || "(no output)",
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(pageHtml());
      return;
    }

    if (req.method === "GET" && req.url === "/api/scripts") {
      sendJson(res, 200, { scripts: listScripts() });
      return;
    }

    if (req.method === "POST" && req.url === "/api/convert") {
      const body = await parseJsonBody(req);
      const result = runConversion(body);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message || String(err) });
  }
});

server.listen(5000, "127.0.0.1", () => {
  process.stdout.write("Web UI: http://127.0.0.1:5000\n");
});
