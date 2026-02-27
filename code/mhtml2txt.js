#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { simpleParser } = require("mailparser");

function htmlUnescape(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

async function extractHtmlFromMhtml(mhtmlPath) {
  const raw = fs.readFileSync(mhtmlPath);
  const parsed = await simpleParser(raw, { skipTextToHtml: true, skipTextLinks: true });

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
    throw new Error("No text/html part found in MHTML.");
  }

  const markers = ["data-message-author-role", "<user-query", "<message-content"];
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    if (markers.some((m) => lower.includes(m))) {
      return candidate;
    }
  }

  return candidates.sort((a, b) => b.length - a.length)[0];
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

async function main() {
  const inputArg = process.argv[2];
  const mhtmlPath = inputArg
    ? path.resolve(inputArg)
    : path.resolve(path.dirname(__filename), "a.mhtml");

  if (!fs.existsSync(mhtmlPath)) {
    throw new Error(`MHTML not found: ${mhtmlPath}`);
  }

  const html = await extractHtmlFromMhtml(mhtmlPath);
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

  const outPath = mhtmlPath.replace(/\.[^.]+$/, ".qa.txt");
  const chunks = [];
  for (let i = 0; i < pairs.length; i += 1) {
    const [question, answer] = pairs[i];
    chunks.push(`[Turn ${i + 1}]`);
    chunks.push("질문:");
    chunks.push(question);
    chunks.push("");
    chunks.push("답변:");
    chunks.push(answer);
    chunks.push("");
  }
  fs.writeFileSync(outPath, `${chunks.join("\n")}\n`, "utf8");
  process.stdout.write(`${outPath}\n`);
  process.stdout.write(`turns: ${pairs.length}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
