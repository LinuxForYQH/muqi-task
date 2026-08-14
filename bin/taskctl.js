#!/usr/bin/env node
"use strict";

/** Optional debug CLI. Agents should use cursor-taskboard MCP tools instead. */

const { getIssue, listComments, updateIssue, addComment } = require("../taskboard-ops");

function fail(message, code = 4) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exit(code);
}

function ok(data) {
  process.stdout.write(`${JSON.stringify({ ok: true, schemaVersion: 1, ...data })}\n`);
}

function parseArgs(argv) {
  const args = [...argv];
  const positional = [];
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  while (args.length) {
    const token = args.shift();
    if (!token) break;
    if (token === "--json") {
      flags.json = true;
      continue;
    }
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = args[0];
      if (next && !next.startsWith("--")) {
        flags[key] = args.shift() || "";
      } else {
        flags[key] = true;
      }
      continue;
    }
    positional.push(token);
  }
  return { positional, flags };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [resource, action, ...rest] = positional;
  if (!resource || resource === "help" || resource === "--help" || resource === "-h") {
    ok({
      usage: [
        "taskctl issue get ID",
        "taskctl issue update ID --status STATUS [--thread-id ID]",
        "taskctl comment list ID",
        "taskctl comment add ID --body TEXT [--thread-id ID]",
      ],
      note: "Agents should use cursor-taskboard MCP tools, not this CLI.",
    });
    return;
  }

  if (resource === "issue" && action === "get") {
    const id = rest[0] || String(flags.id || "");
    if (!id) fail("缺少议题 ID", 2);
    ok({ issue: await getIssue(id) });
    return;
  }

  if (resource === "issue" && action === "update") {
    const id = rest[0] || String(flags.id || "");
    if (!id) fail("缺少议题 ID", 2);
    const status = flags.status != null ? String(flags.status) : undefined;
    const threadId = flags["thread-id"] != null ? String(flags["thread-id"]) : undefined;
    if (status == null && threadId == null) fail("请提供 --status 或 --thread-id", 2);
    ok({
      issue: await updateIssue(id, {
        status,
        threadId,
      }),
    });
    return;
  }

  if (resource === "comment" && action === "list") {
    const id = rest[0] || String(flags.id || "");
    if (!id) fail("缺少议题 ID", 2);
    ok(await listComments(id));
    return;
  }

  if (resource === "comment" && action === "add") {
    const id = rest[0] || String(flags.id || "");
    const body = flags.body != null ? String(flags.body).trim() : "";
    if (!id) fail("缺少议题 ID", 2);
    if (!body) fail("评论不能为空（--body）", 2);
    const threadId = flags["thread-id"] != null ? String(flags["thread-id"]) : null;
    ok(await addComment(id, { body, threadId }));
    return;
  }

  fail(`未知命令: ${positional.join(" ")}`, 2);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error), 4);
});
