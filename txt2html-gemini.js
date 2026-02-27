#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseQa(text) {
  const pairs = [];
  let questionLines = [];
  let answerLines = [];
  let state = null;

  const flush = () => {
    if (questionLines.length > 0 || answerLines.length > 0) {
      pairs.push([questionLines.join("\n").replace(/\n+$/g, ""), answerLines.join("\n").replace(/\n+$/g, "")]);
    }
    questionLines = [];
    answerLines = [];
  };

  for (const line of text.split(/\r?\n/)) {
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

function buildMessage(role, label, text) {
  const avatar = role === "user" ? "U" : "G";
  const escaped = escapeHtml(text);
  const indent = "            ";
  return (
    `${indent}<div class="message ${role}">\n` +
    `${indent}    <div class="avatar">${avatar}</div>\n` +
    `${indent}    <div class="bubble">\n` +
    `${indent}        <div class="label">${label}</div>\n` +
    `${indent}        <div class="text">${escaped}</div>\n` +
    `${indent}    </div>\n` +
    `${indent}</div>`
  );
}

function renderHtml(template, pairs) {
  const marker = '<main class="container">';
  const start = template.indexOf(marker);
  if (start === -1) {
    throw new Error('Template missing <main class="container"> tag.');
  }
  const end = template.indexOf("</main>", start);
  if (end === -1) {
    throw new Error("Template missing </main> tag.");
  }

  const prefix = template.slice(0, start + marker.length);
  const suffix = template.slice(end);
  const blocks = [];
  for (const [question, answer] of pairs) {
    blocks.push(buildMessage("user", "질문", question));
    blocks.push(buildMessage("gemini", "답변", answer));
  }
  return `${prefix}\n\n${blocks.join("\n\n")}\n\n${suffix}`;
}

function main() {
  const baseDir = path.resolve(path.dirname(__filename));
  const inputPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(baseDir, "b.qa.txt");
  const templatePath = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.join(baseDir, "고대사 연구.html");
  const outputPath = process.argv[4]
    ? path.resolve(process.argv[4])
    : inputPath.replace(/\.[^.]+$/, ".html");

  const qaText = fs.readFileSync(inputPath, "utf8");
  const template = fs.readFileSync(templatePath, "utf8");
  const pairs = parseQa(qaText);
  const html = renderHtml(template, pairs);
  fs.writeFileSync(outputPath, html, "utf8");
  process.stdout.write(`${outputPath}\n`);
  process.stdout.write(`turns: ${pairs.length}\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
}
