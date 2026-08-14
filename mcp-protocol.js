"use strict";

const SERVER_INFO = {
  name: "cursor-taskboard",
  version: require("./package.json").version,
};

/** 延迟加载，避免启动时同步 require sql.js 拖慢 initialize（远程尤其明显） */
function ops() {
  return require("./taskboard-ops");
}

const TOOLS = [
  {
    name: "issue_get",
    description:
      "Get a Cursor Taskboard issue by identifier (e.g. OPEN-17) including title, description, status, associated project (folders/gitUrl), and comments.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Issue id or identifier such as OPEN-17" },
      },
      required: ["id"],
    },
  },
  {
    name: "comment_list",
    description: "List comments for a Cursor Taskboard issue.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Issue id or identifier" },
      },
      required: ["id"],
    },
  },
  {
    name: "issue_update",
    description:
      "Update issue status and/or bound conversation threadId. Statuses: backlog, todo, in_progress, in_review, blocked, done, canceled.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string" },
        threadId: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "comment_add",
    description: "Add an agent comment to an issue after completing work.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        body: { type: "string" },
        threadId: { type: "string" },
      },
      required: ["id", "body"],
    },
  },
];

function textResult(data, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    isError,
  };
}

async function callTool(name, args = {}) {
  try {
    const { getIssue, listComments, updateIssue, addComment } = ops();
    if (name === "issue_get") return textResult({ ok: true, issue: await getIssue(args.id) });
    if (name === "comment_list") return textResult({ ok: true, ...(await listComments(args.id)) });
    if (name === "issue_update") {
      return textResult({
        ok: true,
        issue: await updateIssue(args.id, {
          status: args.status,
          threadId: args.threadId,
        }),
      });
    }
    if (name === "comment_add") {
      return textResult({
        ok: true,
        ...(await addComment(args.id, { body: args.body, threadId: args.threadId })),
      });
    }
    return textResult({ ok: false, error: `Unknown tool: ${name}` }, true);
  } catch (error) {
    return textResult(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      true,
    );
  }
}

/**
 * @param {any} message
 * @returns {Promise<object | null>} JSON-RPC response, or null for notifications
 */
async function handleRpc(message) {
  if (!message || typeof message !== "object") return null;
  const { id, method, params } = message;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
          prompts: { listChanged: false },
        },
        serverInfo: SERVER_INFO,
      },
    };
  }
  if (
    method === "notifications/initialized" ||
    method === "initialized" ||
    method === "notifications/cancelled"
  ) {
    return null;
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }
  if (method === "tools/call") {
    const result = await callTool(params?.name, params?.arguments || {});
    return { jsonrpc: "2.0", id, result };
  }
  if (method === "resources/list") {
    return { jsonrpc: "2.0", id, result: { resources: [] } };
  }
  if (method === "resources/templates/list") {
    return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };
  }
  if (method === "prompts/list") {
    return { jsonrpc: "2.0", id, result: { prompts: [] } };
  }
  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (id !== undefined) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }
  return null;
}

module.exports = {
  SERVER_INFO,
  TOOLS,
  callTool,
  handleRpc,
};
