"use strict";

const http = require("http");
const crypto = require("crypto");
const { handleRpc } = require("./mcp-protocol");

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function tokenFromPath(pathname) {
  const parts = String(pathname || "")
    .split("/")
    .filter(Boolean);
  if (parts.length >= 2) return parts[1];
  return "";
}

/**
 * 在扩展宿主内起本机 HTTP MCP（Streamable HTTP + 旧版 SSE）。
 * 远程 SSH 下由 vscode.env.asExternalUri 做端口转发，避免 Shared MCP 在本机 spawn 远端路径。
 * @param {{ token?: string }} [options]
 */
function startMcpHttpServer(options = {}) {
  const token = options.token || crypto.randomBytes(16).toString("hex");
  /** @type {Set<import('http').ServerResponse>} */
  const sseClients = new Set();

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "content-type, accept, mcp-session-id, x-taskboard-token",
    );
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    let url;
    try {
      url = new URL(req.url || "/", "http://127.0.0.1");
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }

    const provided =
      tokenFromPath(url.pathname) ||
      url.searchParams.get("token") ||
      String(req.headers["x-taskboard-token"] || "");
    if (provided !== token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    if (req.method === "DELETE") {
      res.writeHead(204);
      res.end();
      return;
    }

    const accept = String(req.headers.accept || "");
    const first = url.pathname.split("/").filter(Boolean)[0] || "";
    const wantsSse = first === "sse" || (req.method === "GET" && accept.includes("text/event-stream"));

    if (req.method === "GET" && wantsSse) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`event: endpoint\ndata: /mcp/${token}\n\n`);
      sseClients.add(res);
      const ping = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          // ignore
        }
      }, 15000);
      req.on("close", () => {
        clearInterval(ping);
        sseClients.delete(res);
      });
      return;
    }

    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: "cursor-taskboard" }));
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }

    let parsed;
    try {
      const raw = await readBody(req);
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid json" }));
      return;
    }

    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const responses = [];
    for (const message of messages) {
      try {
        const response = await handleRpc(message);
        if (response) responses.push(response);
      } catch (error) {
        if (message && message.id !== undefined) {
          responses.push({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
    }

    const payload = Array.isArray(parsed) ? responses : responses[0] || null;
    if (!payload) {
      res.writeHead(202);
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Mcp-Session-Id": token.slice(0, 16),
    });
    res.end(JSON.stringify(payload));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      resolve({
        server,
        port,
        token,
        close: () =>
          new Promise((done) => {
            for (const client of sseClients) {
              try {
                client.end();
              } catch {
                // ignore
              }
            }
            sseClients.clear();
            server.close(() => done());
          }),
      });
    });
  });
}

module.exports = { startMcpHttpServer };
