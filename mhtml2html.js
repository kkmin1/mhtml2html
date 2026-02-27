#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { simpleParser } = require("mailparser");
const cheerio = require("cheerio");

const UI_HIDE_CSS = `
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
`.trim();

const MATHJAX_CONFIG = `
window.MathJax = {
  tex: {
    inlineMath: [['$', '$'], ['\\\\(', '\\\\)']],
    displayMath: [['$$', '$$'], ['\\\\[', '\\\\]']]
  },
  options: {
    skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
  }
};
`.trim();

function normalizeCid(value) {
  const cid = value.startsWith("cid:") ? value.slice(4) : value;
  return cid.trim().replace(/^<|>$/g, "");
}

function toDataUri(part) {
  const data = part.content || Buffer.alloc(0);
  const mime = part.contentType || "application/octet-stream";
  return `data:${mime};base64,${data.toString("base64")}`;
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

function stripUnrenderedMarkdownBold($) {
  const inlinePattern = /\*\*([^*\n][^*\n]*?)\*\*/g;
  const skipTags = new Set(["script", "style", "code", "pre", "textarea"]);

  function walk(node) {
    if (!node || !node.children) {
      return;
    }
    for (const child of node.children) {
      if (child.type === "text") {
        const parentName = (child.parent && child.parent.name) || "";
        if (!skipTags.has(parentName)) {
          const text = child.data || "";
          if (text.includes("**")) {
            child.data = text.replace(inlinePattern, "$1");
          }
        }
      } else if (child.type === "tag") {
        walk(child);
      }
    }
  }

  walk($.root()[0]);
  const blockTags = ["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "td", "th"];
  for (const tag of blockTags) {
    $(tag).each((_, el) => {
      const html = $(el).html() || "";
      if (!html.includes("**")) {
        return;
      }
      const cleaned = html.replace(/\*\*([\s\S]+?)\*\*/g, "$1");
      if (cleaned !== html) {
        $(el).html(cleaned);
      }
    });
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  if (!args.length) {
    throw new Error("Usage: node code/mhtml2html.js <input.mhtml> [output.html] | [-o output.html]");
  }

  let input = null;
  let output = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-o" || arg === "--output") {
      if (!args[i + 1] || args[i + 1].startsWith("-")) {
        throw new Error("Missing output path after -o/--output");
      }
      output = args[i + 1];
      i += 1;
      continue;
    }

    if (!input) {
      input = arg;
    } else if (!output) {
      output = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  const src = path.resolve(input);
  const dst = output ? path.resolve(output) : src.replace(/\.[^.]+$/, ".html");
  return { src, dst };
}

async function main() {
  const { src, dst } = parseArgs();
  const parsed = await simpleParser(fs.readFileSync(src), { skipTextLinks: true });
  const htmlText = parsed.html || "";
  if (!htmlText) {
    throw new Error("No text/html part found in MHTML");
  }

  const cidMap = new Map();
  for (const att of parsed.attachments || []) {
    const contentId = (att.contentId || "").trim();
    if (contentId) {
      cidMap.set(normalizeCid(contentId), att);
    }
    const contentLocation = (att.headers && att.headers.get("content-location")) || "";
    if (typeof contentLocation === "string" && contentLocation.startsWith("cid:")) {
      cidMap.set(normalizeCid(contentLocation), att);
    }
  }

  const $ = cheerio.load(htmlText, { decodeEntities: false });

  $("link[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (!href.startsWith("cid:")) {
      return;
    }
    const part = cidMap.get(normalizeCid(href));
    if (part && part.contentType === "text/css") {
      const cssText = part.content ? part.content.toString("utf8") : "";
      $(el).replaceWith($("<style></style>").text(replaceCidUrlsInCss(cssText, cidMap)));
    } else {
      $(el).remove();
    }
  });

  for (const attr of ["src", "href", "poster"]) {
    $(`[${attr}]`).each((_, el) => {
      const value = $(el).attr(attr) || "";
      if (!value.startsWith("cid:")) {
        return;
      }
      const part = cidMap.get(normalizeCid(value));
      if (part) {
        $(el).attr(attr, toDataUri(part));
      }
    });
  }

  $("[style]").each((_, el) => {
    const style = $(el).attr("style") || "";
    const replaced = style.replace(/url\(['"]?(cid:[^)"']+)['"]?\)/gi, (match, cidRef) => {
      const part = cidMap.get(normalizeCid(cidRef));
      return part ? `url('${toDataUri(part)}')` : match;
    });
    $(el).attr("style", replaced);
  });

  $("style").each((_, el) => {
    const css = $(el).html() || "";
    if (css.includes("cid:")) {
      $(el).text(replaceCidUrlsInCss(css, cidMap));
    }
  });

  $("link[rel]").each((_, el) => {
    const rel = (($(el).attr("rel") || "").toLowerCase()).split(/\s+/);
    if (rel.includes("preload")) {
      $(el).remove();
    }
  });

  stripUnrenderedMarkdownBold($);
  $("script").remove();

  const conversation = $("chat-window-content").first();
  if (conversation.length && $("body").length) {
    const body = $("body").first();
    const root = $('<main id="content-root"></main>');
    root.append(conversation.clone(true, true));
    body.empty().append(root);
  }

  if (!$("head").length) {
    if (!$("html").length) {
      $.root().prepend("<html><head></head><body></body></html>");
    } else {
      $("html").prepend("<head></head>");
    }
  }

  const head = $("head").first();
  head.append('<style id="clean-content-style"></style>');
  head.find("style#clean-content-style").text(UI_HIDE_CSS);
  head.append("<script></script>");
  head.find("script").last().text(MATHJAX_CONFIG);
  head.append(
    '<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js" id="mathjax-script" defer></script>'
  );
  if (!head.find("meta[charset]").length) {
    head.prepend('<meta charset="UTF-8">');
  }

  fs.writeFileSync(dst, $.html().replace(/\*\*/g, ""), "utf8");
  process.stdout.write(`Saved: ${dst}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
