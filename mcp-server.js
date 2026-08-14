#!/usr/bin/env node
"use strict";

const { handleRpc } = require("./mcp-protocol");

/** 按客户端入站帧格式回包：Content-Length 或换行 JSON */
let useContentLength = false;

function send(message) {
  const body = JSON.stringify(message);
  if (useContentLength) {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
    return;
  }
  process.stdout.write(`${body}\n`);
}

/**
 * 同时接受 LSP Content-Length 帧和换行 JSON（Cursor Shared MCP 两种都出现过）。
 * @param {(message: any) => void} onMessage
 */
function listenStdio(onMessage) {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.length) {
      if (/^Content-Length\s*:/i.test(buffer)) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const match = buffer.slice(0, headerEnd).match(/Content-Length\s*:\s*(\d+)/i);
        const len = match ? Number(match[1]) : 0;
        const start = headerEnd + 4;
        if (buffer.length < start + len) return;
        const body = buffer.slice(start, start + len);
        buffer = buffer.slice(start + len);
        useContentLength = true;
        try {
          onMessage(JSON.parse(body));
        } catch {
          // ignore malformed frame
        }
        continue;
      }
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        // ignore malformed line
      }
    }
  });
}

listenStdio((message) => {
  void handleRpc(message).then((response) => {
    if (response) send(response);
  });
});
