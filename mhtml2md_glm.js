#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { simpleParser } = require("mailparser");
const cheerio = require("cheerio");

function parseArgs(argv) {
  const args = argv.slice(2);
  if (!args.length) {
    throw new Error("Usage: node code/mhtml2md_glm.js <src.mhtml> [out.md] [--assets-dir DIR]");
  }
  const src = path.resolve(args[0]);
  let out = null;
  let assetsDir = null;

  let i = 1;
  if (i < args.length && !args[i].startsWith("--")) {
    out = path.resolve(args[i]);
    i += 1;
  }
  while (i < args.length) {
    if (args[i] === "--assets-dir") {
      if (!args[i + 1]) {
        throw new Error("Missing value after --assets-dir");
      }
      assetsDir = path.resolve(args[i + 1]);
      i += 2;
      continue;
    }
    throw new Error(`Unknown argument: ${args[i]}`);
  }
  return { src, out, assetsDir };
}

function normalizeSvgMarkup(svg) {
  let fixed = svg;
  const pairs = [
    ["viewbox=", "viewBox="],
    ["markerwidth=", "markerWidth="],
    ["markerheight=", "markerHeight="],
    ["refx=", "refX="],
    ["refy=", "refY="],
    ["preserveaspectratio=", "preserveAspectRatio="],
    ["baseprofile=", "baseProfile="],
    ["clippathunits=", "clipPathUnits="],
    ["gradientunits=", "gradientUnits="],
    ["gradienttransform=", "gradientTransform="],
    ["patternunits=", "patternUnits="],
    ["patterncontentunits=", "patternContentUnits="],
    ["patterntransform=", "patternTransform="],
    ["maskunits=", "maskUnits="],
    ["maskcontentunits=", "maskContentUnits="],
    ["contentscripttype=", "contentScriptType="],
    ["contentstyletype=", "contentStyleType="],
  ];
  for (const [low, camel] of pairs) {
    fixed = fixed.replace(new RegExp(`\\b${low}`, "gi"), camel);
  }
  if (!fixed.slice(0, 80).includes("<?xml")) {
    fixed = `<?xml version="1.0" encoding="UTF-8"?>\n${fixed}`;
  }
  return fixed;
}

function textOf($, el) {
  return ($(el).text() || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function isHiddenThinking($, node) {
  let cur = node;
  while (cur && cur.type === "tag") {
    const cls = (cur.attribs && cur.attribs.class) || "";
    const classList = cls.split(/\s+/).filter(Boolean);
    if (cls.includes("thinking-chain-container") || cls.includes("thinking-block")) {
      return true;
    }
    if (classList.includes("overflow-hidden") && classList.includes("h-0")) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

function tableToMd($, table) {
  const rows = [];
  $(table)
    .find("tr")
    .each((_, tr) => {
      const cells = $(tr).find("th, td").toArray();
      if (!cells.length) {
        return;
      }
      rows.push(cells.map((c) => textOf($, c).replace(/\|/g, "\\|")));
    });
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
  return out.join("\n");
}

class Converter {
  constructor(resources, assetsDir, outDir) {
    this.resources = resources;
    this.assetsDir = assetsDir;
    this.outDir = outDir;
    this.imageSeq = 1;
    this.inlineSvgSeq = 1;
  }

  saveCidImage(srcValue) {
    const key = srcValue.startsWith("cid:") ? srcValue.slice(4) : srcValue;
    const item = this.resources.get(key);
    if (!item) {
      return null;
    }
    const { ctype, data } = item;
    const extMap = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "image/svg+xml": ".svg",
    };
    const ext = extMap[ctype] || ".bin";
    const filename = `img${String(this.imageSeq).padStart(3, "0")}${ext}`;
    this.imageSeq += 1;
    const p = path.join(this.assetsDir, filename);
    fs.writeFileSync(p, data);
    return path.relative(this.outDir, p).replace(/\\/g, "/");
  }

  saveInlineSvg(svgMarkup) {
    const filename = `svg${String(this.inlineSvgSeq).padStart(3, "0")}.svg`;
    this.inlineSvgSeq += 1;
    const p = path.join(this.assetsDir, filename);
    fs.writeFileSync(p, normalizeSvgMarkup(svgMarkup), "utf8");
    return path.relative(this.outDir, p).replace(/\\/g, "/");
  }

  nodeToMd($, node, depth = 0) {
    if (!node) {
      return "";
    }
    if (node.type === "text") {
      return (node.data || "").replace(/\u00a0/g, " ");
    }
    if (node.type !== "tag") {
      return "";
    }

    if (isHiddenThinking($, node)) {
      return "";
    }

    const name = (node.name || "").toLowerCase();
    const cls = ((node.attribs && node.attribs.class) || "").toLowerCase();
    if (cls.includes("citations") || cls.includes("tooltip") || cls.includes("edit-user-message-button")) {
      return "";
    }
    if (["script", "style", "noscript", "button"].includes(name)) {
      return "";
    }

    if (name === "svg") {
      return `![svg](${this.saveInlineSvg($.html(node))})\n\n`;
    }
    if (name === "img") {
      const src = (node.attribs && node.attribs.src) || "";
      if (!src || src.includes("icon.z.ai")) {
        return "";
      }
      if (src.startsWith("cid:")) {
        const local = this.saveCidImage(src);
        return local ? `![image](${local})\n\n` : "";
      }
      if (src.startsWith("data:image/svg")) {
        return `![svg](${this.saveInlineSvg(src)})\n\n`;
      }
      return "";
    }
    if (name === "br") {
      return "\n";
    }
    if (/^h[1-6]$/.test(name)) {
      const level = Number(name.slice(1));
      return `\n${"#".repeat(level)} ${textOf($, node)}\n\n`;
    }
    if (["p", "div", "section", "article", "blockquote"].includes(name)) {
      const body = $(node)
        .contents()
        .toArray()
        .map((c) => this.nodeToMd($, c, depth))
        .join("")
        .trim();
      return body ? `${body}\n\n` : "";
    }
    if (name === "ul") {
      const items = [];
      $(node)
        .children("li")
        .each((_, li) => {
          const content = $(li)
            .contents()
            .toArray()
            .map((c) => this.nodeToMd($, c, depth + 1))
            .join("")
            .trim();
          if (content) {
            items.push(`${"  ".repeat(depth)}- ${content}`);
          }
        });
      return items.length ? `${items.join("\n")}\n\n` : "";
    }
    if (name === "ol") {
      const items = [];
      let idx = 1;
      $(node)
        .children("li")
        .each((_, li) => {
          const content = $(li)
            .contents()
            .toArray()
            .map((c) => this.nodeToMd($, c, depth + 1))
            .join("")
            .trim();
          if (content) {
            items.push(`${"  ".repeat(depth)}${idx}. ${content}`);
            idx += 1;
          }
        });
      return items.length ? `${items.join("\n")}\n\n` : "";
    }
    if (name === "table") {
      const md = tableToMd($, node);
      return md ? `${md}\n\n` : "";
    }
    return $(node)
      .contents()
      .toArray()
      .map((c) => this.nodeToMd($, c, depth))
      .join("");
  }
}

function cleanMarkdown(text) {
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
  return out ? `${out}\n` : "";
}

function makeMarkdown(turns) {
  const lines = ["# 질의응답 추출", ""];
  for (let i = 0; i < turns.length; i += 1) {
    const [q, a] = turns[i];
    lines.push(`## Turn ${i + 1}`, "", "### 질문", "", q, "", "### 답변", "", a, "");
  }
  return `${lines.join("\n").trim()}\n`;
}

function buildTurns(html, converter) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const turns = [];
  let pendingQuestion = null;

  $('div[id^="message-"]').each((_, message) => {
    const classes = ((message.attribs && message.attribs.class) || "").split(/\s+/);
    const isUser = classes.includes("user-message");

    if (isUser) {
      let content = $(message).find(".chat-user .rounded-xl").first();
      if (!content.length) {
        content = $(message).find(".chat-user").first();
      }
      if (!content.length) {
        return;
      }
      const q = cleanMarkdown(converter.nodeToMd($, content[0])).trim();
      if (!q) {
        return;
      }
      if (pendingQuestion !== null) {
        turns.push([pendingQuestion, "(답변 없음)"]);
      }
      pendingQuestion = q;
      return;
    }

    let content = $(message).find(".chat-assistant .markdown-prose").first();
    if (!content.length) {
      content = $(message).find(".chat-assistant").first();
    }
    if (!content.length) {
      return;
    }
    const a = cleanMarkdown(converter.nodeToMd($, content[0])).trim();
    if (!a) {
      return;
    }
    if (pendingQuestion === null) {
      pendingQuestion = "(질문 없음)";
    }
    turns.push([pendingQuestion, a]);
    pendingQuestion = null;
  });

  if (pendingQuestion !== null) {
    turns.push([pendingQuestion, "(답변 없음)"]);
  }
  return turns;
}

async function extractHtmlAndResources(src) {
  const raw = fs.readFileSync(src);
  const parsed = await simpleParser(raw, { skipTextLinks: true });
  const candidates = [];
  const resources = new Map();

  if (parsed.html) {
    candidates.push(parsed.html);
  }
  for (const att of parsed.attachments || []) {
    if ((att.contentType || "").toLowerCase() === "text/html") {
      candidates.push((att.content || Buffer.alloc(0)).toString("utf8"));
    }
    const ctype = (att.contentType || "").toLowerCase();
    const data = att.content || Buffer.alloc(0);
    const cid = (att.contentId || "").trim();
    if (cid) {
      const key = cid.replace(/^<|>$/g, "");
      resources.set(cid, { ctype, data });
      resources.set(key, { ctype, data });
    }
    const cloc = (att.headers && att.headers.get("content-location")) || "";
    if (typeof cloc === "string" && cloc) {
      resources.set(cloc, { ctype, data });
      resources.set(cloc.replace(/^<|>$/g, ""), { ctype, data });
    }
  }

  if (!candidates.length) {
    throw new Error("No text/html part found in MHTML.");
  }
  return { html: candidates.sort((a, b) => b.length - a.length)[0], resources };
}

async function main() {
  const { src, out, assetsDir } = parseArgs(process.argv);
  if (!fs.existsSync(src)) {
    throw new Error(`Input file not found: ${src}`);
  }
  const dst = out || src.replace(/\.[^.]+$/, ".md");
  const assets = assetsDir || path.dirname(dst);
  fs.mkdirSync(assets, { recursive: true });

  const { html, resources } = await extractHtmlAndResources(src);
  const converter = new Converter(resources, assets, path.dirname(dst));
  const turns = buildTurns(html, converter);
  const md = makeMarkdown(turns);
  fs.writeFileSync(dst, md, "utf8");

  process.stdout.write(`${dst}\n`);
  process.stdout.write(`turns: ${turns.length}\n`);
  process.stdout.write(`assets: ${assets}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
