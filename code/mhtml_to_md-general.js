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
  return candidates.sort((a, b) => b.length - a.length)[0];
}

function extractMainParagraphs(html) {
  const stripped = html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const paras = [];
  const paraRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = paraRe.exec(stripped)) !== null) {
    let txt = m[1].replace(/<[^>]+>/g, "");
    txt = htmlUnescape(txt);
    txt = txt.replace(/\s+/g, " ").trim();
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
    if (p.length < 30) {
      continue;
    }
    if (badRe.test(p)) {
      continue;
    }
    if (seen.has(p)) {
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

  return mainParas;
}

async function mhtmlToMd(mhtmlPath, outPath) {
  const html = await extractHtmlFromMhtml(mhtmlPath);
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? htmlUnescape(titleMatch[1].trim()) : "문서";
  const paras = extractMainParagraphs(html);
  const lines = [`# ${title}`, "", ...paras];
  const md = `${lines.join("\n\n").trim()}\n`;

  const dst = outPath || mhtmlPath.replace(/\.[^.]+$/, ".md");
  fs.writeFileSync(dst, md, "utf8");
  return dst;
}

async function main() {
  if (process.argv.length < 3) {
    throw new Error("Usage: node code/mhtml_to_md-general.js <file.mhtml> [out.md]");
  }
  const src = path.resolve(process.argv[2]);
  const out = process.argv[3] ? path.resolve(process.argv[3]) : null;
  if (!fs.existsSync(src)) {
    throw new Error(`MHTML not found: ${src}`);
  }
  const result = await mhtmlToMd(src, out);
  process.stdout.write(`${result}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
