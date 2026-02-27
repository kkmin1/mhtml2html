#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { simpleParser } = require("mailparser");
const cheerio = require("cheerio");

async function extractMainHtmlFromMhtml(mhtmlPath) {
  const raw = fs.readFileSync(mhtmlPath);
  const parsed = await simpleParser(raw, { skipTextLinks: true });
  const candidates = [];
  if (parsed.html) {
    candidates.push(parsed.html);
  }
  for (const att of parsed.attachments || []) {
    if ((att.contentType || "").toLowerCase() === "text/html") {
      candidates.push((att.content || Buffer.alloc(0)).toString("utf8"));
    }
  }
  if (candidates.length === 0) {
    throw new Error("No text/html part found.");
  }
  return candidates.sort((a, b) => b.length - a.length)[0];
}

function extractMessageBlocks(fullHtml) {
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

function normalizeText(text) {
  return text.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function tableToMarkdown($, tableEl) {
  const rows = [];
  $(tableEl)
    .find("tr")
    .each((_, tr) => {
      const row = [];
      $(tr)
        .find("th, td")
        .each((__, td) => {
          row.push(normalizeText($(td).text()).replace(/\|/g, "\\|"));
        });
      if (row.length) {
        rows.push(row);
      }
    });

  if (!rows.length) {
    return "";
  }
  const width = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => [...r, ...new Array(width - r.length).fill("")]);
  const out = [];
  out.push(`| ${norm[0].join(" | ")} |`);
  out.push(`| ${new Array(width).fill("---").join(" | ")} |`);
  for (let i = 1; i < norm.length; i += 1) {
    out.push(`| ${norm[i].join(" | ")} |`);
  }
  return `${out.join("\n")}\n\n`;
}

function nodeToMarkdown($, node, listDepth = 0) {
  if (!node) {
    return "";
  }
  if (node.type === "text") {
    return node.data || "";
  }
  if (node.type !== "tag") {
    return "";
  }
  const name = (node.name || "").toLowerCase();
  if (["script", "style", "svg", "path"].includes(name)) {
    return "";
  }

  if (name === "br") {
    return "\n";
  }
  if (name === "table") {
    return tableToMarkdown($, node);
  }
  if (name === "span") {
    const style = ($(node).attr("style") || "").toLowerCase();
    if (style.includes("display: block") && style.includes("margin-top")) {
      const h = normalizeText($(node).text());
      return h ? `\n#### ${h}\n\n` : "";
    }
  }
  if (name === "ul" || name === "ol") {
    let idx = 1;
    const lines = [];
    $(node)
      .children("li")
      .each((_, li) => {
        const content = normalizeMarkdown($(li).contents().toArray().map((n) => nodeToMarkdown($, n, listDepth + 1)).join(""));
        if (!content) {
          return;
        }
        const indent = "  ".repeat(Math.max(0, listDepth));
        if (name === "ol") {
          lines.push(`${indent}${idx}. ${content}`);
          idx += 1;
        } else {
          lines.push(`${indent}- ${content}`);
        }
      });
    return lines.length ? `${lines.join("\n")}\n\n` : "";
  }
  if (["p", "div", "section", "article", "blockquote", "li"].includes(name)) {
    const body = $(node)
      .contents()
      .toArray()
      .map((n) => nodeToMarkdown($, n, listDepth))
      .join("");
    const cleaned = normalizeMarkdown(body);
    return cleaned ? `${cleaned}\n\n` : "";
  }

  return $(node)
    .contents()
    .toArray()
    .map((n) => nodeToMarkdown($, n, listDepth))
    .join("");
}

function normalizeMarkdown(text) {
  let out = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  out = out.replace(/[ \t]+\n/g, "\n");
  out = out.replace(/\n[ \t]+/g, "\n");
  out = out.replace(/\n{3,}/g, "\n\n");
  out = out.replace(/[ \t]{2,}/g, " ");
  return out.trim();
}

function fragmentToMarkdown(fragmentHtml) {
  const $ = cheerio.load(fragmentHtml, { decodeEntities: false });
  const content = $.root()
    .contents()
    .toArray()
    .map((n) => nodeToMarkdown($, n, 0))
    .join("");
  let text = normalizeMarkdown(content);
  text = text.replace(/(?<=\.)(?=\d+\.\s)/g, "\n");
  return text;
}

function buildTurns(blocks) {
  const turns = [];
  let q = null;
  let answers = [];

  for (const [role, fragment] of blocks) {
    const text = fragmentToMarkdown(fragment);
    if (!text) {
      continue;
    }
    if (["키보드 단축키를 보려면 물음표를 누르세요.", "키보드 단축키 보기"].includes(text)) {
      continue;
    }
    if (role === "user") {
      if (q !== null) {
        turns.push([q, answers.filter((a) => a.trim()).join("\n\n").trim()]);
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
    turns.push([q, answers.filter((a) => a.trim()).join("\n\n").trim()]);
  }
  return turns;
}

function makeMd(turns, title) {
  const lines = [`# ${title}`, ""];
  for (let i = 0; i < turns.length; i += 1) {
    const [q, a] = turns[i];
    lines.push(`## Turn ${i + 1}`, "", "### 질문", "", q, "", "### 답변", "", a || "(답변 없음)", "");
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

async function main() {
  if (process.argv.length < 3) {
    throw new Error("Usage: node code/mhtml2md-grok.js <file.mhtml> [out.md]");
  }
  const src = path.resolve(process.argv[2]);
  if (!fs.existsSync(src)) {
    throw new Error(`File not found: ${src}`);
  }
  const out = process.argv[3] ? path.resolve(process.argv[3]) : src.replace(/\.[^.]+$/, ".md");

  const html = await extractMainHtmlFromMhtml(src);
  const blocks = extractMessageBlocks(html);
  const turns = buildTurns(blocks);
  const md = makeMd(turns, `${path.basename(src)} 질문·답변 정리`);
  fs.writeFileSync(out, md, "utf8");
  process.stdout.write(`${out}\n`);
  process.stdout.write(`turns: ${turns.length}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
