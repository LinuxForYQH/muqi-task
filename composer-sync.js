const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

/**
 * @returns {string}
 */
function cursorStateDbPath() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || "", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return path.join(os.homedir(), ".config/Cursor/User/globalStorage/state.vscdb");
}

/**
 * @param {string} dbPath
 * @param {string} sql
 * @returns {Promise<string>}
 */
async function sqliteQuery(dbPath, sql) {
  const { stdout } = await execFileAsync(
    "sqlite3",
    ["-readonly", `file:${dbPath}?mode=ro`, sql],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return String(stdout || "");
}

/**
 * @param {string} value
 */
function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * @param {string} composerId
 * @returns {Promise<Array<{ bubbleId: string, role: "user" | "assistant", text: string, createdAt: string }>>}
 */
async function readComposerMessages(composerId) {
  const id = String(composerId || "").trim();
  if (!id) return [];

  const dbPath = cursorStateDbPath();
  if (!fs.existsSync(dbPath)) return [];

  let raw;
  try {
    raw = await sqliteQuery(
      dbPath,
      `SELECT value FROM cursorDiskKV WHERE key = ${sqlQuote(`composerData:${id}`)} LIMIT 1;`,
    );
  } catch {
    return [];
  }
  const jsonText = raw.trim();
  if (!jsonText) return [];

  /** @type {any} */
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }

  const headers = Array.isArray(data.fullConversationHeadersOnly)
    ? data.fullConversationHeadersOnly
    : Array.isArray(data.conversation)
      ? data.conversation
      : [];

  /** @type {Map<string, string>} */
  const bubbleTextById = new Map();
  try {
    const { stdout } = await execFileAsync(
      "sqlite3",
      [
        "-readonly",
        "-json",
        `file:${dbPath}?mode=ro`,
        `SELECT key, value FROM cursorDiskKV WHERE key LIKE ${sqlQuote(`bubbleId:${id}:%`)};`,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const rows = JSON.parse(String(stdout || "[]"));
    for (const row of rows) {
      const key = String(row.key || "");
      const bubbleId = key.split(":").slice(2).join(":");
      if (!bubbleId) continue;
      try {
        const bubble = JSON.parse(String(row.value || "{}"));
        const text = String(bubble?.text || "").trim();
        if (text) bubbleTextById.set(bubbleId, text);
      } catch {
        // ignore
      }
    }
  } catch {
    // preview-only fallback
  }

  /** @type {Array<{ bubbleId: string, role: "user" | "assistant", text: string, createdAt: string }>} */
  const messages = [];
  for (const header of headers) {
    const bubbleId = String(header?.bubbleId || "").trim();
    if (!bubbleId) continue;
    const grouping = header?.grouping && typeof header.grouping === "object" ? header.grouping : {};
    const preview = String(grouping.textPreview || "").trim();
    const body = bubbleTextById.get(bubbleId) || preview;
    if (!body) continue;
    messages.push({
      bubbleId,
      role: Number(header?.type) === 1 ? "user" : "assistant",
      text: body,
      createdAt: String(header?.createdAt || new Date().toISOString()),
    });
  }
  return messages;
}

/**
 * @param {string} text
 * @param {number} max
 */
function clip(text, max) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

/**
 * @param {Array<{ role: string, text: string }>} messages
 */
function buildReportSummary(messages) {
  const users = messages.filter((item) => item.role === "user");
  const assistants = messages.filter((item) => item.role === "assistant");
  const lastUser = users[users.length - 1];
  const lastAssistant = assistants[assistants.length - 1];
  const lines = [
    `Agent 工作汇报 · ${messages.length} 条消息（${users.length} 问 / ${assistants.length} 答）`,
    "",
    "最近提问：",
    clip(lastUser?.text || "（暂无）", 240),
    "",
    "最近回复：",
    clip(lastAssistant?.text || "（暂无）", 360),
    "",
    "点击下方「查看对话」可展开本会话全部内容。",
  ];
  return lines.join("\n");
}

/**
 * One agent_report per bound thread; multi-turn bubbles become its chat_turn children.
 * @param {{ getIssue: Function, addCommentsBatch: Function, upsertComment: Function }} db
 * @param {string} issueIdOrIdentifier
 * @param {{ maxBodyLength?: number }} [options]
 */
async function syncIssueComposerChat(db, issueIdOrIdentifier, options = {}) {
  const issue = db.getIssue(issueIdOrIdentifier);
  if (!issue) return { ok: false, added: 0, reason: "issue-not-found" };
  const threadId = String(issue.threadId || "").trim();
  if (!threadId) return { ok: true, added: 0, reason: "no-thread" };

  const messages = await readComposerMessages(threadId);
  if (!messages.length) return { ok: true, added: 0, reason: "no-messages", threadId };

  const maxBodyLength = Number(options.maxBodyLength) > 0 ? Number(options.maxBodyLength) : 12000;
  const reportId = `c-report-${threadId}`;

  // 1) Upsert the single agent_report for this conversation thread
  db.upsertComment(issue.id, {
    id: reportId,
    authorName: "Cursor Agent",
    authorId: "cursor-agent",
    authorType: "agent",
    kind: "agent_report",
    body: buildReportSummary(messages),
    threadId,
    parentCommentId: null,
    createdAt: messages[0]?.createdAt,
  });

  // 2) Upsert each turn as a child of that report
  const batch = messages.map((msg) => {
    let body = msg.text;
    if (body.length > maxBodyLength) body = `${body.slice(0, maxBodyLength)}\n…`;
    const isUser = msg.role === "user";
    return {
      id: `c-chat-${msg.bubbleId}`,
      authorName: isUser ? issue.assignee || "webhua yang" : "Cursor Agent",
      authorId: isUser ? "me" : "cursor-agent",
      authorType: isUser ? "user" : "agent",
      kind: "chat_turn",
      body,
      threadId,
      parentCommentId: reportId,
      createdAt: msg.createdAt,
    };
  });

  const result = db.addCommentsBatch(issue.id, batch);
  return {
    ok: true,
    added: (result.added || 0) + (result.updated || 0),
    inserted: result.added || 0,
    updated: result.updated || 0,
    threadId,
    reportId,
    total: messages.length,
  };
}

const COMPOSER_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @returns {string[]}
 */
function listAgentTranscriptRoots() {
  const projects = path.join(os.homedir(), ".cursor", "projects");
  if (!fs.existsSync(projects)) return [];
  /** @type {string[]} */
  const roots = [];
  try {
    for (const name of fs.readdirSync(projects)) {
      const dir = path.join(projects, name, "agent-transcripts");
      if (fs.existsSync(dir)) roots.push(dir);
    }
  } catch {
    // ignore
  }
  return roots;
}

/**
 * @param {string} composerId
 * @returns {string | null}
 */
function composerTranscriptPath(composerId) {
  const id = String(composerId || "").trim();
  if (!COMPOSER_UUID_RE.test(id)) return null;
  for (const root of listAgentTranscriptRoots()) {
    const file = path.join(root, id, `${id}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * @param {string} composerId
 */
function composerHasTranscript(composerId) {
  return Boolean(composerTranscriptPath(composerId));
}

/**
 * @param {string} filePath
 * @param {string} identifier
 * @param {string} title
 */
function transcriptMentionsIssue(filePath, identifier, title) {
  let text = "";
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(96 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      text = buf.slice(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  const id = String(identifier || "").trim();
  const name = String(title || "").trim();
  if (id) {
    if (text.includes(`任务面板任务 ${id}`)) return true;
    if (text.includes(`同步处理 ${id}`)) return true;
    if (text.includes(`处理任务面板任务 ${id}`)) return true;
  }
  if (name && text.includes(`议题主题：${name}`)) return true;
  return false;
}

/**
 * Bound threadId 可能是从未发送的空草稿（UI 标题为 New Agent）。
 * 远程 agent-transcripts 里才有真正聊过的会话。
 * @param {{ threadId?: string | null, identifier?: string, title?: string }} issue
 * @returns {string}
 */
function resolveComposerIdForIssue(issue) {
  const bound = String(issue?.threadId || "").trim();
  if (bound && composerHasTranscript(bound)) return bound;

  const identifier = String(issue?.identifier || "").trim();
  const title = String(issue?.title || "").trim();
  if (!identifier && !title) return COMPOSER_UUID_RE.test(bound) ? bound : "";

  /** @type {{ id: string, mtime: number } | null} */
  let best = null;
  for (const root of listAgentTranscriptRoots()) {
    let names = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!COMPOSER_UUID_RE.test(name)) continue;
      if (name === bound) continue;
      const file = path.join(root, name, `${name}.jsonl`);
      if (!fs.existsSync(file)) continue;
      if (!transcriptMentionsIssue(file, identifier, title)) continue;
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        mtime = 0;
      }
      if (!best || mtime > best.mtime) best = { id: name, mtime };
    }
  }
  if (best) return best.id;
  return COMPOSER_UUID_RE.test(bound) ? bound : "";
}

module.exports = {
  cursorStateDbPath,
  readComposerMessages,
  syncIssueComposerChat,
  buildReportSummary,
  resolveComposerIdForIssue,
  composerHasTranscript,
};
