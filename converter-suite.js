(function () {
  "use strict";

  const UI_HIDE_CSS = `
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
}`.trim();

  const MATHJAX_CONFIG = `
window.MathJax = {
  tex: {
    inlineMath: [['$', '$'], ['\\\\(', '\\\\)']],
    displayMath: [['$$', '$$'], ['\\\\[', '\\\\]']]
  },
  options: {
    skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
  }
};`.trim();

  function normalizeCid(value) {
    const cid = value.startsWith("cid:") ? value.slice(4) : value;
    return cid.trim().replace(/^<|>$/g, "");
  }

  function parseHeaders(headerText) {
    const lines = headerText.replace(/\r\n/g, "\n").split("\n");
    const out = {};
    let key = null;
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      if ((line.startsWith(" ") || line.startsWith("\t")) && key) {
        out[key] += " " + line.trim();
        continue;
      }
      const idx = line.indexOf(":");
      if (idx < 0) {
        continue;
      }
      key = line.slice(0, idx).trim().toLowerCase();
      out[key] = line.slice(idx + 1).trim();
    }
    return out;
  }

  function getParam(headerValue, key) {
    if (!headerValue) {
      return null;
    }
    const re = new RegExp(`${key}\\s*=\\s*("([^"]+)"|([^;\\s]+))`, "i");
    const m = headerValue.match(re);
    if (!m) {
      return null;
    }
    return (m[2] || m[3] || "").trim();
  }

  function qpDecodeToBytes(text) {
    const src = text.replace(/=\r?\n/g, "");
    const out = [];
    for (let i = 0; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === "=" && i + 2 < src.length && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
        out.push(parseInt(src.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        out.push(src.charCodeAt(i) & 0xff);
      }
    }
    return new Uint8Array(out);
  }

  function latin1ToBytes(text) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) {
      out[i] = text.charCodeAt(i) & 0xff;
    }
    return out;
  }

  function base64ToBytes(text) {
    const cleaned = text.replace(/[\r\n\s]/g, "");
    const bin = atob(cleaned);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }

  function bytesToBase64(bytes) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function decodeBytes(bytes, charsetHint) {
    const tries = [];
    if (charsetHint) {
      tries.push(charsetHint);
    }
    for (const c of ["utf-8", "cp949", "euc-kr", "windows-1252", "latin1"]) {
      if (!tries.includes(c)) {
        tries.push(c);
      }
    }
    for (const cs of tries) {
      try {
        return new TextDecoder(cs).decode(bytes);
      } catch (_) {}
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }

  function htmlUnescape(text) {
    return text
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  }

  function parseMhtmlParts(bytes) {
    const latin1 = new TextDecoder("iso-8859-1").decode(bytes);
    const sep = latin1.indexOf("\r\n\r\n") >= 0 ? "\r\n\r\n" : "\n\n";
    const headEnd = latin1.indexOf(sep);
    if (headEnd < 0) {
      throw new Error("Invalid MHTML: no header separator.");
    }

    const rootHeaders = parseHeaders(latin1.slice(0, headEnd));
    const rootCtype = rootHeaders["content-type"] || "";
    const boundary = getParam(rootCtype, "boundary");
    if (!boundary) {
      throw new Error("Invalid MHTML: multipart boundary not found.");
    }

    const bodyText = latin1.slice(headEnd + sep.length);
    const marker = `--${boundary}`;
    const sections = bodyText.split(marker).slice(1);
    const parts = [];

    for (let sec of sections) {
      sec = sec.replace(/^\r?\n/, "");
      if (!sec || sec.startsWith("--")) {
        continue;
      }
      const partSep = sec.indexOf("\r\n\r\n") >= 0 ? "\r\n\r\n" : "\n\n";
      const idx = sec.indexOf(partSep);
      if (idx < 0) {
        continue;
      }

      const pHeaders = parseHeaders(sec.slice(0, idx));
      let pBody = sec.slice(idx + partSep.length);
      pBody = pBody.replace(/\r?\n$/, "");

      const cte = (pHeaders["content-transfer-encoding"] || "").toLowerCase();
      let pBytes;
      if (cte.includes("base64")) {
        pBytes = base64ToBytes(pBody);
      } else if (cte.includes("quoted-printable")) {
        pBytes = qpDecodeToBytes(pBody);
      } else {
        pBytes = latin1ToBytes(pBody);
      }

      const ctype = (pHeaders["content-type"] || "application/octet-stream").split(";")[0].trim().toLowerCase();
      const charset = getParam(pHeaders["content-type"] || "", "charset");
      parts.push({
        headers: pHeaders,
        contentType: ctype,
        charset,
        bytes: pBytes,
      });
    }
    return parts;
  }

  function getMainHtmlPart(parts) {
    const htmlParts = parts.filter((p) => p.contentType === "text/html");
    if (!htmlParts.length) {
      throw new Error("No text/html part found in MHTML.");
    }
    return htmlParts[0];
  }

  function buildCidMap(parts) {
    const cidMap = new Map();
    for (const part of parts) {
      const contentId = (part.headers["content-id"] || "").trim();
      const contentLoc = (part.headers["content-location"] || "").trim();
      if (contentId) {
        cidMap.set(normalizeCid(contentId), part);
      }
      if (contentLoc.startsWith("cid:")) {
        cidMap.set(normalizeCid(contentLoc), part);
      }
    }
    return cidMap;
  }

  function makeOutputName(inputName, ext) {
    return inputName.replace(/\.[^.]+$/, "") + ext;
  }

  function toDataUri(part) {
    return `data:${part.contentType || "application/octet-stream"};base64,${bytesToBase64(part.bytes)}`;
  }

  function replaceCidUrlsInCss(cssText, cidMap) {
    let out = cssText.replace(/url\(['"]?(cid:[^)"']+)['"]?\)/gi, (match, cidRef) => {
      const part = cidMap.get(normalizeCid(cidRef));
      return part ? `url('${toDataUri(part)}')` : match;
    });
    out = out.replace(/@import\s+['"](cid:[^'"\s;]+)['"]/gi, (match, cidRef) => {
      const part = cidMap.get(normalizeCid(cidRef));
      return part ? `@import url('${toDataUri(part)}')` : match;
    });
    return out;
  }

  function stripUnrenderedMarkdownBold(doc) {
    const walker = doc.createTreeWalker(doc.body || doc, NodeFilter.SHOW_TEXT);
    const pattern = /\*\*([^*\n][^*\n]*?)\*\*/g;
    const skipTags = new Set(["SCRIPT", "STYLE", "CODE", "PRE", "TEXTAREA"]);
    const nodes = [];
    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }
    for (const node of nodes) {
      const parent = node.parentElement;
      if (!parent || skipTags.has(parent.tagName)) {
        continue;
      }
      if (!node.nodeValue.includes("**")) {
        continue;
      }
      node.nodeValue = node.nodeValue.replace(pattern, "$1");
    }
    for (const tag of ["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "td", "th"]) {
      for (const el of doc.querySelectorAll(tag)) {
        if (el.innerHTML.includes("**")) {
          el.innerHTML = el.innerHTML.replace(/\*\*([\s\S]+?)\*\*/g, "$1");
        }
      }
    }
  }

  function convertMhtmlToHtml(parts) {
    const mainHtml = decodeBytes(getMainHtmlPart(parts).bytes, getMainHtmlPart(parts).charset);
    const cidMap = buildCidMap(parts);
    const doc = new DOMParser().parseFromString(mainHtml, "text/html");

    for (const link of Array.from(doc.querySelectorAll("link[href]"))) {
      const href = link.getAttribute("href") || "";
      if (!href.startsWith("cid:")) {
        continue;
      }
      const part = cidMap.get(normalizeCid(href));
      if (part && part.contentType === "text/css") {
        const style = doc.createElement("style");
        style.textContent = replaceCidUrlsInCss(decodeBytes(part.bytes, part.charset), cidMap);
        link.replaceWith(style);
      } else {
        link.remove();
      }
    }

    for (const attr of ["src", "href", "poster"]) {
      for (const el of Array.from(doc.querySelectorAll(`[${attr}]`))) {
        const v = el.getAttribute(attr) || "";
        if (!v.startsWith("cid:")) {
          continue;
        }
        const part = cidMap.get(normalizeCid(v));
        if (part) {
          el.setAttribute(attr, toDataUri(part));
        }
      }
    }

    for (const el of Array.from(doc.querySelectorAll("[style]"))) {
      const style = el.getAttribute("style") || "";
      el.setAttribute(
        "style",
        style.replace(/url\(['"]?(cid:[^)"']+)['"]?\)/gi, (match, cidRef) => {
          const part = cidMap.get(normalizeCid(cidRef));
          return part ? `url('${toDataUri(part)}')` : match;
        })
      );
    }

    for (const st of Array.from(doc.querySelectorAll("style"))) {
      const css = st.textContent || "";
      if (css.includes("cid:")) {
        st.textContent = replaceCidUrlsInCss(css, cidMap);
      }
    }

    for (const link of Array.from(doc.querySelectorAll("link[rel]"))) {
      const rel = (link.getAttribute("rel") || "").toLowerCase().split(/\s+/);
      if (rel.includes("preload")) {
        link.remove();
      }
    }

    stripUnrenderedMarkdownBold(doc);
    for (const s of Array.from(doc.querySelectorAll("script"))) {
      s.remove();
    }

    const conv = doc.querySelector("chat-window-content");
    if (conv && doc.body) {
      const root = doc.createElement("main");
      root.id = "content-root";
      root.appendChild(conv.cloneNode(true));
      doc.body.innerHTML = "";
      doc.body.appendChild(root);
    }

    if (!doc.head) {
      const h = doc.createElement("head");
      if (doc.documentElement.firstChild) {
        doc.documentElement.insertBefore(h, doc.documentElement.firstChild);
      } else {
        doc.documentElement.appendChild(h);
      }
    }
    const head = doc.head;
    if (!head.querySelector("meta[charset]")) {
      const meta = doc.createElement("meta");
      meta.setAttribute("charset", "UTF-8");
      head.insertBefore(meta, head.firstChild);
    }
    const cleanupStyle = doc.createElement("style");
    cleanupStyle.id = "clean-content-style";
    cleanupStyle.textContent = UI_HIDE_CSS;
    head.appendChild(cleanupStyle);

    const cfg = doc.createElement("script");
    cfg.textContent = MATHJAX_CONFIG;
    head.appendChild(cfg);

    const mj = doc.createElement("script");
    mj.id = "mathjax-script";
    mj.defer = true;
    mj.src = "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js";
    head.appendChild(mj);

    const htmlOut = "<!DOCTYPE html>\n" + doc.documentElement.outerHTML.replace(/\*\*/g, "");
    return new Blob([htmlOut], { type: "text/html;charset=utf-8" });
  }

  function htmlToText(fragment) {
    let text = fragment;
    text = text.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/<\/(p|div|li|ul|ol|blockquote|h[1-6]|tr|table|section)>/gi, "\n");
    text = text.replace(/<(p|div|li|ul|ol|blockquote|h[1-6]|tr|table|section)[^>]*>/gi, "\n");
    text = text.replace(/<td[^>]*>/gi, "\t");
    text = text.replace(/<\/td>/gi, "\t");
    text = text.replace(/<[^>]+>/g, "");
    text = htmlUnescape(text);
    text = text.replace(/\r\n?/g, "\n");
    text = text.replace(/[ \t]+\n/g, "\n");
    text = text.replace(/\n[ \t]+/g, "\n");
    text = text.replace(/\n{3,}/g, "\n\n");
    return text.trim();
  }

  function cleanDialogText(role, text) {
    const lines = [];
    for (const line of text.split("\n")) {
      const stripped = line.trim();
      if (!stripped) {
        lines.push("");
        continue;
      }
      if (["ChatGPT said:", "You said:", "사용자 said:"].includes(stripped)) {
        continue;
      }
      if (/^\d+$/.test(stripped)) {
        continue;
      }
      lines.push(line);
    }
    let out = lines.join("\n").trim();
    if (role === "model") {
      out = out.replace(/^\d{4}-\d{2}-\d{2}\n+/, "");
    }
    out = out.replace(/\n{3,}/g, "\n\n");
    return out.trim();
  }

  function extractBlocks(html) {
    const items = [];
    const userRe = /<user-query[^>]*>([\s\S]*?)<\/user-query>/gi;
    const modelRe = /<message-content[^>]*>([\s\S]*?)<\/message-content>/gi;
    let m;
    while ((m = userRe.exec(html)) !== null) {
      items.push({ role: "user", pos: m.index, fragment: m[1] });
    }
    while ((m = modelRe.exec(html)) !== null) {
      items.push({ role: "model", pos: m.index, fragment: m[1] });
    }
    if (items.length > 0) {
      items.sort((a, b) => a.pos - b.pos);
      return items;
    }
    const roleMatches = [...html.matchAll(/<div[^>]*data-message-author-role="(user|assistant)"[^>]*>/gi)];
    for (let i = 0; i < roleMatches.length; i += 1) {
      const role = roleMatches[i][1].toLowerCase();
      const start = roleMatches[i].index || 0;
      const end = i + 1 < roleMatches.length ? roleMatches[i + 1].index || html.length : html.length;
      items.push({
        role: role === "user" ? "user" : "model",
        pos: start,
        fragment: html.slice(start, end),
      });
    }
    items.sort((a, b) => a.pos - b.pos);
    return items;
  }

  function extractQaPairsFromMhtml(parts) {
    const html = decodeBytes(getMainHtmlPart(parts).bytes, getMainHtmlPart(parts).charset);
    const items = extractBlocks(html);

    const pairs = [];
    let currentQuestion = null;
    let currentAnswers = [];

    for (const item of items) {
      const text = cleanDialogText(item.role, htmlToText(item.fragment));
      if (!text) {
        continue;
      }
      if (item.role === "user") {
        if (currentQuestion !== null) {
          pairs.push([currentQuestion, currentAnswers.join("\n\n").trim()]);
        }
        currentQuestion = text;
        currentAnswers = [];
      } else {
        if (currentQuestion === null) {
          currentQuestion = "(질문 없음)";
        }
        currentAnswers.push(text);
      }
    }
    if (currentQuestion !== null) {
      pairs.push([currentQuestion, currentAnswers.join("\n\n").trim()]);
    }
    return pairs;
  }

  function convertMhtmlToQaTxt(parts) {
    const pairs = extractQaPairsFromMhtml(parts);
    const lines = [];
    for (let i = 0; i < pairs.length; i += 1) {
      lines.push(`[Turn ${i + 1}]`);
      lines.push("질문:");
      lines.push(pairs[i][0]);
      lines.push("");
      lines.push("답변:");
      lines.push(pairs[i][1]);
      lines.push("");
    }
    const out = lines.join("\n") + "\n";
    return new Blob([out], { type: "text/plain;charset=utf-8" });
  }

  function convertMhtmlToGeneralMd(parts) {
    const html = decodeBytes(getMainHtmlPart(parts).bytes, getMainHtmlPart(parts).charset);
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? htmlUnescape(titleMatch[1].trim()) : "문서";
    const stripped = html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

    const paras = [];
    const paraRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = paraRe.exec(stripped)) !== null) {
      let txt = m[1].replace(/<[^>]+>/g, "");
      txt = htmlUnescape(txt).replace(/\s+/g, " ").trim();
      if (txt) {
        paras.push(txt);
      }
    }

    const badRe =
      /(微信|支付宝|VIP|恢复|商户|扫码|支付|个人图书馆|收藏|阅读|转藏|来源|展开全文|登录|注册|分享|猜你喜欢|相关推荐|热门|关注|回复|评论|举报|版权|免责声明|360doc)/i;
    const stopRe = /(\|\||客服工作时间)/i;

    const mainParas = [];
    const seen = new Set();
    for (const p of paras) {
      if (stopRe.test(p)) {
        break;
      }
      if (p.length < 30 || badRe.test(p) || seen.has(p)) {
        continue;
      }
      seen.add(p);
      mainParas.push(p);
    }

    if (mainParas.length < 3) {
      const abstractMatch = stripped.match(/name="360docabstract"\s+content="([^"]*)"/i);
      if (abstractMatch && abstractMatch[1]) {
        mainParas.push(htmlUnescape(abstractMatch[1].trim()));
      }
    }

    const md = [`# ${title}`, "", ...mainParas].join("\n\n").trim() + "\n";
    return new Blob([md], { type: "text/markdown;charset=utf-8" });
  }

  function makeTurnsMarkdown(pairs, title) {
    const lines = [title ? `# ${title}` : "# 질의응답 추출", ""];
    for (let i = 0; i < pairs.length; i += 1) {
      lines.push(`## Turn ${i + 1}`, "", "### 질문", "", pairs[i][0] || "(질문 없음)", "", "### 답변", "", pairs[i][1] || "(답변 없음)", "");
    }
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }

  function glmNodeToMd(node, depth) {
    if (!node) {
      return "";
    }
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.nodeValue || "").replace(/\u00a0/g, " ");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const el = node;
    const name = el.tagName.toLowerCase();
    const cls = (el.getAttribute("class") || "").toLowerCase();
    const classList = cls.split(/\s+/).filter(Boolean);

    if (
      cls.includes("thinking-chain-container") ||
      cls.includes("thinking-block") ||
      (classList.includes("overflow-hidden") && classList.includes("h-0")) ||
      cls.includes("citations") ||
      cls.includes("tooltip") ||
      cls.includes("edit-user-message-button")
    ) {
      return "";
    }

    if (["script", "style", "noscript", "button"].includes(name)) {
      return "";
    }
    if (name === "br") {
      return "\n";
    }
    if (/^h[1-6]$/.test(name)) {
      const level = Number(name.slice(1));
      return `\n${"#".repeat(level)} ${el.textContent.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim()}\n\n`;
    }

    if (name === "table") {
      const rows = [];
      for (const tr of Array.from(el.querySelectorAll("tr"))) {
        const cells = Array.from(tr.querySelectorAll("th,td"));
        if (!cells.length) {
          continue;
        }
        rows.push(cells.map((c) => c.textContent.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().replace(/\|/g, "\\|")));
      }
      if (!rows.length) {
        return "";
      }
      const width = Math.max(...rows.map((r) => r.length));
      for (const r of rows) {
        while (r.length < width) {
          r.push("");
        }
      }
      const out = [];
      out.push(`| ${rows[0].join(" | ")} |`);
      out.push(`| ${new Array(width).fill("---").join(" | ")} |`);
      for (let i = 1; i < rows.length; i += 1) {
        out.push(`| ${rows[i].join(" | ")} |`);
      }
      return out.join("\n") + "\n\n";
    }

    if (name === "ul" || name === "ol") {
      const lines = [];
      let idx = 1;
      for (const li of Array.from(el.children).filter((c) => c.tagName && c.tagName.toLowerCase() === "li")) {
        const content = Array.from(li.childNodes)
          .map((n) => glmNodeToMd(n, depth + 1))
          .join("")
          .trim();
        if (!content) {
          continue;
        }
        if (name === "ol") {
          lines.push(`${"  ".repeat(depth)}${idx}. ${content}`);
          idx += 1;
        } else {
          lines.push(`${"  ".repeat(depth)}- ${content}`);
        }
      }
      return lines.length ? lines.join("\n") + "\n\n" : "";
    }

    const body = Array.from(el.childNodes)
      .map((n) => glmNodeToMd(n, depth))
      .join("")
      .trim();
    if (["p", "div", "section", "article", "blockquote"].includes(name)) {
      return body ? body + "\n\n" : "";
    }
    return body;
  }

  function cleanGlmMarkdown(text) {
    let out = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    out = out.replace(/[ \t]+\n/g, "\n");
    out = out.replace(/\n{3,}/g, "\n\n");

    const lines = [];
    for (const line of out.split("\n")) {
      const s = line.trim();
      if (!s) {
        lines.push("");
        continue;
      }
      if (["sources", "thought process"].includes(s.toLowerCase())) {
        continue;
      }
      if (/^\d{1,3}$/.test(s)) {
        continue;
      }
      if (/^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/.test(s)) {
        continue;
      }
      lines.push(s);
    }
    out = lines.join("\n");
    out = out.replace(/(?<!\()\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b(?!\))/g, "");
    out = out.replace(/[ \t]{2,}/g, " ");
    out = out.replace(/\n{3,}/g, "\n\n").trim();
    return out;
  }

  function extractGrokBlocks(fullHtml) {
    const needle = '<div dir="ltr" class="';
    let pos = 0;
    const blocks = [];

    while (true) {
      const i = fullHtml.indexOf(needle, pos);
      if (i === -1) {
        break;
      }
      const j = fullHtml.indexOf('">', i);
      if (j === -1) {
        break;
      }

      const classAttr = fullHtml.slice(i + needle.length, j);
      if (!classAttr.includes("r-imh66m")) {
        pos = i + 1;
        continue;
      }

      const start = j + 2;
      let depth = 1;
      let k = start;
      while (depth > 0) {
        const nOpen = fullHtml.indexOf("<div", k);
        const nClose = fullHtml.indexOf("</div>", k);
        if (nClose === -1) {
          k = fullHtml.length;
          break;
        }
        if (nOpen !== -1 && nOpen < nClose) {
          depth += 1;
          k = nOpen + 4;
        } else {
          depth -= 1;
          k = nClose + 6;
        }
      }

      const fragment = depth === 0 ? fullHtml.slice(start, k - 6) : fullHtml.slice(start, k);
      const role = classAttr.includes("r-1kt6imw") ? "user" : "model";
      blocks.push([role, fragment]);
      pos = k;
    }
    return blocks;
  }

  function grokFragmentToMarkdown(fragmentHtml) {
    const doc = new DOMParser().parseFromString(`<body>${fragmentHtml}</body>`, "text/html");
    const text = Array.from(doc.body.childNodes).map((n) => glmNodeToMd(n, 0)).join("");
    return cleanGlmMarkdown(text);
  }

  function convertMhtmlToMdGrok(parts, inputName) {
    const html = decodeBytes(getMainHtmlPart(parts).bytes, getMainHtmlPart(parts).charset);
    const blocks = extractGrokBlocks(html);
    const pairs = [];
    let q = null;
    let answers = [];

    for (const [role, fragment] of blocks) {
      const text = grokFragmentToMarkdown(fragment);
      if (!text) {
        continue;
      }
      if (text === "키보드 단축키를 보려면 물음표를 누르세요." || text === "키보드 단축키 보기") {
        continue;
      }
      if (role === "user") {
        if (q !== null) {
          pairs.push([q, answers.filter((x) => x.trim()).join("\n\n").trim()]);
        }
        q = text;
        answers = [];
      } else {
        if (q === null) {
          q = "(질문 없음)";
        }
        answers.push(text);
      }
    }
    if (q !== null) {
      pairs.push([q, answers.filter((x) => x.trim()).join("\n\n").trim()]);
    }
    if (!pairs.length) {
      pairs.push(...extractQaPairsFromMhtml(parts));
    }

    const title = `${inputName || "문서"} 질문·답변 정리`;
    const md = makeTurnsMarkdown(pairs, title);
    return new Blob([md], { type: "text/markdown;charset=utf-8" });
  }

  function convertMhtmlToMdGlm(parts) {
    const html = decodeBytes(getMainHtmlPart(parts).bytes, getMainHtmlPart(parts).charset);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const turns = [];
    let pendingQuestion = null;

    for (const message of Array.from(doc.querySelectorAll('div[id^="message-"]'))) {
      const classes = (message.getAttribute("class") || "").split(/\s+/);
      const isUser = classes.includes("user-message");

      if (isUser) {
        let content = message.querySelector(".chat-user .rounded-xl");
        if (!content) {
          content = message.querySelector(".chat-user");
        }
        if (!content) {
          continue;
        }
        const q = cleanGlmMarkdown(Array.from(content.childNodes).map((n) => glmNodeToMd(n, 0)).join(""));
        if (!q) {
          continue;
        }
        if (pendingQuestion !== null) {
          turns.push([pendingQuestion, "(답변 없음)"]);
        }
        pendingQuestion = q;
        continue;
      }

      let content = message.querySelector(".chat-assistant .markdown-prose");
      if (!content) {
        content = message.querySelector(".chat-assistant");
      }
      if (!content) {
        continue;
      }
      const a = cleanGlmMarkdown(Array.from(content.childNodes).map((n) => glmNodeToMd(n, 0)).join(""));
      if (!a) {
        continue;
      }
      if (pendingQuestion === null) {
        pendingQuestion = "(질문 없음)";
      }
      turns.push([pendingQuestion, a]);
      pendingQuestion = null;
    }

    if (pendingQuestion !== null) {
      turns.push([pendingQuestion, "(답변 없음)"]);
    }

    const md = makeTurnsMarkdown(turns, "질의응답 추출");
    return new Blob([md], { type: "text/markdown;charset=utf-8" });
  }

  function parseQaText(text) {
    const pairs = [];
    let questionLines = [];
    let answerLines = [];
    let state = null;

    function flush() {
      if (questionLines.length > 0 || answerLines.length > 0) {
        pairs.push([
          questionLines.join("\n").replace(/\n+$/g, ""),
          answerLines.join("\n").replace(/\n+$/g, ""),
        ]);
      }
      questionLines = [];
      answerLines = [];
    }

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine;
      if (line.startsWith("[Turn ") && line.endsWith("]")) {
        flush();
        state = null;
        continue;
      }
      if (line.trim() === "질문:") {
        state = "question";
        continue;
      }
      if (line.trim() === "답변:") {
        state = "answer";
        continue;
      }
      if (state === "question") {
        questionLines.push(line);
      } else if (state === "answer") {
        answerLines.push(line);
      }
    }
    flush();
    return pairs;
  }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderQaHtml(pairs, title) {
    const rows = [];
    for (const [q, a] of pairs) {
      rows.push(`
<article class="item user">
  <h3>질문</h3>
  <pre>${escapeHtml(q)}</pre>
</article>
<article class="item answer">
  <h3>답변</h3>
  <pre>${escapeHtml(a)}</pre>
</article>`);
    }
    return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body{margin:0;padding:24px;font-family:Segoe UI,Noto Sans KR,sans-serif;background:#f5f7fb;color:#1f2933}
    main{max-width:920px;margin:0 auto;background:#fff;border:1px solid #d8dee8;border-radius:12px;padding:18px}
    h1{margin:0 0 14px}
    .item{border:1px solid #d8dee8;border-radius:10px;padding:12px;margin:12px 0;background:#fff}
    .item.user{background:#f8fcff}
    .item.answer{background:#f7fffb}
    h3{margin:0 0 8px}
    pre{white-space:pre-wrap;word-break:break-word;margin:0}
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    ${rows.join("\n")}
  </main>
</body>
</html>`;
  }

  function convertQaTxtToHtml(bytes, inputName) {
    const text = decodeBytes(bytes, "utf-8");
    const pairs = parseQaText(text);
    const title = (inputName || "qa").replace(/\.[^.]+$/, "");
    const html = renderQaHtml(pairs, title);
    return new Blob([html], { type: "text/html;charset=utf-8" });
  }

  const CONVERTERS = [
    {
      id: "mhtml2html",
      label: "mhtml2html.js",
      fileName: "mhtml2html.js",
      accept: ".mhtml,.mht",
      defaultExt: ".html",
      run: (bytes) => convertMhtmlToHtml(parseMhtmlParts(bytes)),
    },
    {
      id: "mhtml2html-gemini",
      label: "mhtml2html-gemini.js",
      fileName: "mhtml2html-gemini.js",
      accept: ".mhtml,.mht",
      defaultExt: ".html",
      run: (bytes) => convertMhtmlToHtml(parseMhtmlParts(bytes)),
    },
    {
      id: "mhtml2txt",
      label: "mhtml2txt.js",
      fileName: "mhtml2txt.js",
      accept: ".mhtml,.mht",
      defaultExt: ".qa.txt",
      run: (bytes) => convertMhtmlToQaTxt(parseMhtmlParts(bytes)),
    },
    {
      id: "mhtml2txt-gemini",
      label: "mhtml2txt-gemini.js",
      fileName: "mhtml2txt-gemini.js",
      accept: ".mhtml,.mht",
      defaultExt: ".qa.txt",
      run: (bytes) => convertMhtmlToQaTxt(parseMhtmlParts(bytes)),
    },
    {
      id: "mhtml2txt-chatgpt",
      label: "mhtml2txt-chatgpt.js",
      fileName: "mhtml2txt-chatgpt.js",
      accept: ".mhtml,.mht",
      defaultExt: ".qa.txt",
      run: (bytes) => convertMhtmlToQaTxt(parseMhtmlParts(bytes)),
    },
    {
      id: "mhtml_to_md_general",
      label: "mhtml_to_md-general.js",
      fileName: "mhtml_to_md-general.js",
      accept: ".mhtml,.mht",
      defaultExt: ".md",
      run: (bytes) => convertMhtmlToGeneralMd(parseMhtmlParts(bytes)),
    },
    {
      id: "mhtml2md-grok",
      label: "mhtml2md-grok.js",
      fileName: "mhtml2md-grok.js",
      accept: ".mhtml,.mht",
      defaultExt: ".md",
      run: (bytes, inputName) => convertMhtmlToMdGrok(parseMhtmlParts(bytes), inputName),
    },
    {
      id: "mhtml2md_glm",
      label: "mhtml2md_glm.js",
      fileName: "mhtml2md_glm.js",
      accept: ".mhtml,.mht",
      defaultExt: ".md",
      run: (bytes) => convertMhtmlToMdGlm(parseMhtmlParts(bytes)),
    },
    {
      id: "txt2html-gemini",
      label: "txt2html-gemini.js",
      fileName: "txt2html-gemini.js",
      accept: ".txt",
      defaultExt: ".html",
      run: (bytes, inputName) => convertQaTxtToHtml(bytes, inputName),
    },
  ];

  const pickConverterBtn = document.getElementById("pickConverterBtn");
  const converterInfo = document.getElementById("converterInfo");
  const pickFileBtn = document.getElementById("pickFileBtn");
  const runBtn = document.getElementById("runBtn");
  const downloadBtn = document.getElementById("downloadBtn");
  const savePickerBtn = document.getElementById("savePickerBtn");
  const fileInfo = document.getElementById("fileInfo");
  const outputNameEl = document.getElementById("outputName");
  const statusEl = document.getElementById("status");
  const logEl = document.getElementById("log");

  let inputFile = null;
  let outputBlob = null;
  let selectedConverterId = CONVERTERS[0].id;
  let lastInputHandle = null;
  let lastOutputHandle = null;
  let lastConverterHandle = null;

  const HANDLE_DB_NAME = "converter-suite-handles";
  const HANDLE_STORE = "handles";
  const HANDLE_KEY_INPUT = "lastInputHandle";
  const HANDLE_KEY_OUTPUT = "lastOutputHandle";
  const HANDLE_KEY_CONVERTER = "lastConverterHandle";

  function openHandleDb() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        resolve(null);
        return;
      }
      const req = indexedDB.open(HANDLE_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(HANDLE_STORE)) {
          db.createObjectStore(HANDLE_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
    });
  }

  async function saveHandle(key, handle) {
    try {
      const db = await openHandleDb();
      if (!db || !handle) {
        return;
      }
      await new Promise((resolve, reject) => {
        const tx = db.transaction(HANDLE_STORE, "readwrite");
        tx.objectStore(HANDLE_STORE).put(handle, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error("IndexedDB write failed"));
      });
      db.close();
    } catch (_) {}
  }

  async function loadHandle(key) {
    try {
      const db = await openHandleDb();
      if (!db) {
        return null;
      }
      const handle = await new Promise((resolve, reject) => {
        const tx = db.transaction(HANDLE_STORE, "readonly");
        const req = tx.objectStore(HANDLE_STORE).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error || new Error("IndexedDB read failed"));
      });
      db.close();
      return handle;
    } catch (_) {
      return null;
    }
  }

  function setStatus(text, cls) {
    statusEl.className = cls || "muted";
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

  function selectedConverter() {
    return CONVERTERS.find((c) => c.id === selectedConverterId) || CONVERTERS[0];
  }

  function setConverterInfo(name) {
    converterInfo.textContent = name || "(선택 안 됨)";
  }

  function findConverterByFileName(fileName) {
    const lower = String(fileName || "").toLowerCase();
    return CONVERTERS.find((c) => String(c.fileName || "").toLowerCase() === lower) || null;
  }

  async function pickConverter() {
    try {
      let pickedFileName = "";
      if (window.showOpenFilePicker) {
        const opts = {
          id: "converter-suite-converter",
          multiple: false,
          types: [{ description: "JavaScript", accept: { "text/javascript": [".js"] } }],
        };
        if (lastConverterHandle) {
          opts.startIn = lastConverterHandle;
        } else {
          opts.startIn = "documents";
        }
        const [handle] = await window.showOpenFilePicker(opts);
        lastConverterHandle = handle;
        await saveHandle(HANDLE_KEY_CONVERTER, handle);
        const file = await handle.getFile();
        pickedFileName = file.name;
      } else {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".js";
        await new Promise((resolve) => {
          input.onchange = resolve;
          input.click();
        });
        if (!input.files || !input.files[0]) {
          return;
        }
        pickedFileName = input.files[0].name;
      }

      const converter = findConverterByFileName(pickedFileName);
      if (!converter) {
        throw new Error(`지원하지 않는 변환기 파일: ${pickedFileName}`);
      }
      selectedConverterId = converter.id;
      setConverterInfo(converter.fileName);
      if (inputFile) {
        outputNameEl.value = guessOutputName();
      }
      setStatus(`변환기 선택됨: ${converter.fileName}`, "ok");
    } catch (e) {
      setStatus(e.message || String(e), "err");
    }
  }

  function guessOutputName() {
    if (!inputFile) {
      return "";
    }
    const cv = selectedConverter();
    return makeOutputName(inputFile.name, cv.defaultExt);
  }

  async function pickFile() {
    try {
      const cv = selectedConverter();
      if (window.showOpenFilePicker) {
        const opts = {
          id: "converter-suite-input",
          multiple: false,
          types: [
            {
              description: "입력 파일",
              accept: { "application/octet-stream": cv.accept.split(",") },
            },
          ],
        };
        if (lastInputHandle) {
          opts.startIn = lastInputHandle;
        } else {
          opts.startIn = "documents";
        }
        const [handle] = await window.showOpenFilePicker(opts);
        lastInputHandle = handle;
        await saveHandle(HANDLE_KEY_INPUT, handle);
        inputFile = await handle.getFile();
      } else {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = cv.accept;
        await new Promise((resolve) => {
          input.onchange = resolve;
          input.click();
        });
        inputFile = input.files && input.files[0] ? input.files[0] : null;
      }
      if (!inputFile) {
        return;
      }
      fileInfo.textContent = `${inputFile.name} (${inputFile.size.toLocaleString()} bytes)`;
      outputNameEl.value = guessOutputName();
      setStatus("입력 파일 선택 완료");
    } catch (e) {
      setStatus(e.message || String(e), "err");
    }
  }

  async function runConvert() {
    try {
      if (!inputFile) {
        throw new Error("입력 파일을 먼저 선택하세요.");
      }
      const cv = selectedConverter();
      setStatus("변환 중...");
      setLog("");
      const bytes = new Uint8Array(await inputFile.arrayBuffer());
      outputBlob = cv.run(bytes, inputFile.name);
      setStatus(`${cv.label} 변환 완료`, "ok");
      setLog("변환 성공");
    } catch (e) {
      outputBlob = null;
      setStatus(e.message || String(e), "err");
      setLog(e && e.stack ? e.stack : String(e));
    }
  }

  function getOutputName() {
    const name = (outputNameEl.value || "").trim();
    if (!name) {
      throw new Error("출력 파일명을 입력하세요.");
    }
    if (/[\\/:*?"<>|]/.test(name)) {
      throw new Error("출력 파일명에 금지 문자가 있습니다.");
    }
    return name;
  }

  async function saveWithPicker() {
    try {
      if (!outputBlob) {
        throw new Error("먼저 변환을 실행하세요.");
      }
      const fileName = getOutputName();
      if (!window.showSaveFilePicker) {
        throw new Error("브라우저가 저장 탐색기를 지원하지 않습니다. 다운로드를 사용하세요.");
      }
      const opts = {
        id: "converter-suite-output",
        suggestedName: fileName,
      };
      if (lastOutputHandle) {
        opts.startIn = lastOutputHandle;
      } else if (lastInputHandle) {
        opts.startIn = lastInputHandle;
      } else {
        opts.startIn = "documents";
      }
      const handle = await window.showSaveFilePicker(opts);
      const writable = await handle.createWritable();
      await writable.write(outputBlob);
      await writable.close();
      lastOutputHandle = handle;
      await saveHandle(HANDLE_KEY_OUTPUT, handle);
      setStatus("저장 완료", "ok");
    } catch (e) {
      setStatus(e.message || String(e), "err");
    }
  }

  function downloadOutput() {
    try {
      if (!outputBlob) {
        throw new Error("먼저 변환을 실행하세요.");
      }
      const fileName = getOutputName();
      const url = URL.createObjectURL(outputBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus("다운로드 시작됨", "ok");
    } catch (e) {
      setStatus(e.message || String(e), "err");
    }
  }

  async function init() {
    lastInputHandle = await loadHandle(HANDLE_KEY_INPUT);
    lastOutputHandle = await loadHandle(HANDLE_KEY_OUTPUT);
    lastConverterHandle = await loadHandle(HANDLE_KEY_CONVERTER);
    setConverterInfo(selectedConverter().fileName);
    pickConverterBtn.addEventListener("click", pickConverter);
    pickFileBtn.addEventListener("click", pickFile);
    runBtn.addEventListener("click", runConvert);
    savePickerBtn.addEventListener("click", saveWithPicker);
    downloadBtn.addEventListener("click", downloadOutput);
  }

  init();
})();
