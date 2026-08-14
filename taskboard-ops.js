"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const CONFIG_PATH = path.join(os.homedir(), ".cursor-taskboard", "config.json");

function readConfig() {
  if (process.env.CURSOR_TASKBOARD_DB) {
    return { dbPath: process.env.CURSOR_TASKBOARD_DB };
  }
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`未找到配置 ${CONFIG_PATH}，请先启用 Muqi Task 扩展`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

/**
 * @param {import('sql.js').Database} db
 * @param {string} idOrIdentifier
 */
function findIssueRow(db, idOrIdentifier) {
  const stmt = db.prepare(
    "SELECT * FROM issues WHERE id = ? OR identifier = ? COLLATE NOCASE LIMIT 1",
  );
  stmt.bind([idOrIdentifier, idOrIdentifier]);
  if (!stmt.step()) {
    stmt.free();
    return null;
  }
  const row = stmt.getAsObject();
  stmt.free();
  return row;
}

/**
 * @param {import('sql.js').Database} db
 * @param {string} issueId
 */
function resolveCommentKind(input = {}) {
  const explicit = String(input.kind || "").trim();
  if (explicit === "chat_report") return "agent_report";
  if (explicit === "chat_turn" || explicit === "agent_report" || explicit === "user_comment") {
    return explicit;
  }
  const id = String(input.id || "");
  if (id.startsWith("c-report-")) return "agent_report";
  if (id.startsWith("c-chat-")) return "chat_turn";
  if (input.authorType === "agent") return "agent_report";
  return "user_comment";
}

function parseForkThreadIds(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          const threadId = item.trim();
          return threadId ? { threadId, createdAt: "" } : null;
        }
        if (!item || typeof item !== "object") return null;
        const threadId = String(item.threadId || "").trim();
        if (!threadId) return null;
        return {
          threadId,
          createdAt: String(item.createdAt || ""),
          bubbleId: item.bubbleId ? String(item.bubbleId) : null,
          sourceThreadId: item.sourceThreadId ? String(item.sourceThreadId) : null,
        };
      })
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    try {
      return parseForkThreadIds(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * @param {unknown} value
 * @param {{ imagesOnly?: boolean, attachmentsRoot?: string | null }} [options]
 */
function parseAttachments(value, options = {}) {
  const imagesOnly = Boolean(options.imagesOnly);
  const attachmentsRoot = options.attachmentsRoot ? String(options.attachmentsRoot) : "";
  /** @type {unknown[]} */
  let list = [];
  if (Array.isArray(value)) {
    list = value;
  } else if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      return [];
    }
  }
  return list
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const relPath = String(item.relPath || "").trim();
      if (!relPath || relPath.includes("..") || path.isAbsolute(relPath)) return null;
      const mime = String(item.mime || "application/octet-stream").trim() || "application/octet-stream";
      if (imagesOnly && !mime.startsWith("image/")) return null;
      /** @type {{ id: string, mime: string, name: string, relPath: string, absPath?: string }} */
      const next = {
        id: String(item.id || `att-${index}`).trim() || `att-${index}`,
        mime,
        name: String(item.name || path.basename(relPath) || `file-${index + 1}`).trim(),
        relPath,
      };
      if (attachmentsRoot) {
        next.absPath = path.join(attachmentsRoot, ...relPath.split("/"));
      }
      return next;
    })
    .filter(Boolean);
}

function attachmentsRootFromConfig() {
  try {
    const config = readConfig();
    return config.attachmentsRoot ? String(config.attachmentsRoot) : "";
  } catch {
    return "";
  }
}

function loadComments(db, issueId) {
  const root = attachmentsRootFromConfig();
  const stmt = db.prepare(
    `SELECT id, author_name AS authorName, author_id AS authorId, author_type AS authorType,
            kind, body, thread_id AS threadId, parent_comment_id AS parentCommentId,
            fork_thread_ids_json AS forkThreadIdsJson, attachments_json AS attachmentsJson,
            created_at AS createdAt
     FROM comments WHERE issue_id = ? ORDER BY created_at ASC`,
  );
  stmt.bind([issueId]);
  const items = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    const { forkThreadIdsJson, attachmentsJson, ...rest } = row;
    items.push({
      ...rest,
      kind: resolveCommentKind(row),
      parentCommentId: row.parentCommentId || null,
      forkThreadIds: parseForkThreadIds(forkThreadIdsJson),
      attachments: parseAttachments(attachmentsJson, { attachmentsRoot: root }),
    });
  }
  stmt.free();
  return items;
}

/**
 * @param {import('sql.js').Database} db
 * @param {string} issueId
 */
function loadActivities(db, issueId) {
  const stmt = db.prepare(
    `SELECT id, kind, actor_name AS actorName, field,
            before_value AS before, after_value AS after, created_at AS createdAt
     FROM activities WHERE issue_id = ? ORDER BY created_at ASC`,
  );
  stmt.bind([issueId]);
  const items = [];
  while (stmt.step()) items.push(stmt.getAsObject());
  stmt.free();
  return items;
}

/**
 * @param {import('sql.js').Database} db
 * @param {string} projectId
 */
function loadProject(db, projectId) {
  const id = String(projectId || "").trim();
  if (!id) return null;
  const stmt = db.prepare(
    `SELECT id, name, key_prefix AS keyPrefix, seq,
            folders_json AS foldersJson, git_url AS gitUrl, git_urls_json AS gitUrlsJson
     FROM projects WHERE id = ? LIMIT 1`,
  );
  stmt.bind([id]);
  if (!stmt.step()) {
    stmt.free();
    return null;
  }
  const row = stmt.getAsObject();
  stmt.free();
  let folders = [];
  try {
    const parsed = JSON.parse(String(row.foldersJson || "[]"));
    folders = Array.isArray(parsed)
      ? parsed.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
  } catch {
    folders = [];
  }
  /** @type {string[]} */
  let gitUrls = [];
  try {
    const parsed = JSON.parse(String(row.gitUrlsJson || "[]"));
    if (Array.isArray(parsed)) {
      gitUrls = parsed.map((item) => String(item || "").trim()).filter(Boolean);
    }
  } catch {
    gitUrls = [];
  }
  if (!gitUrls.length && row.gitUrl) {
    gitUrls = [String(row.gitUrl).trim()].filter(Boolean);
  }
  return {
    id: String(row.id),
    name: String(row.name || ""),
    keyPrefix: String(row.keyPrefix || ""),
    seq: Number(row.seq || 0),
    folders,
    gitUrls,
    gitUrl: gitUrls[0] || null,
  };
}

/**
 * @param {Record<string, any>} row
 * @param {import('sql.js').Database} db
 * @param {{ withComments?: boolean, withActivities?: boolean }} [opts]
 */
function mapIssue(row, db, opts = {}) {
  const root = attachmentsRootFromConfig();
  const project = loadProject(db, row.project_id);
  const issue = {
    id: row.id,
    projectId: row.project_id || null,
    project,
    identifier: row.identifier,
    title: row.title,
    description: row.description || "",
    status: row.status,
    priority: row.priority || "none",
    labels: JSON.parse(String(row.labels_json || "[]")),
    assignee: row.assignee || null,
    assigneeMe: Boolean(row.assignee_me),
    startDate: row.start_date || null,
    dueDate: row.due_date || null,
    processing: Boolean(row.processing),
    threadId: row.thread_id || null,
    gitBranch: row.git_branch || null,
    worktreePath: row.worktree_path || null,
    creatorName: row.creator_name || null,
    attachments: parseAttachments(row.attachments_json, { attachmentsRoot: root }),
    outputs: (() => {
      try {
        const parsed = JSON.parse(String(row.outputs_json || "[]"));
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })(),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (opts.withComments !== false) issue.comments = loadComments(db, row.id);
  if (opts.withActivities) issue.activities = loadActivities(db, row.id);
  return issue;
}

/**
 * @param {(db: import('sql.js').Database, persist: () => void) => any | Promise<any>} fn
 */
async function withDb(fn) {
  const config = readConfig();
  const dbPath = String(config.dbPath || "");
  if (!dbPath || !fs.existsSync(dbPath)) {
    throw new Error(`数据库不存在: ${dbPath || "(empty)"}`);
  }
  // 延迟 require：MCP 进程启动时不必先加载大体积 sql.js
  const initSqlJs = require("sql.js");
  const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const persist = () => {
    fs.writeFileSync(dbPath, Buffer.from(db.export()));
  };
  // Keep MCP/CLI schema aligned with the extension store.
  const ensureColumn = (table, column, definition) => {
    const info = db.exec(`PRAGMA table_info(${table})`);
    const cols = info.length ? info[0].values.map((row) => row[1]) : [];
    if (!cols.includes(column)) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      return true;
    }
    return false;
  };
  const altered =
    ensureColumn("comments", "attachments_json", "TEXT NOT NULL DEFAULT '[]'") |
    ensureColumn("issues", "attachments_json", "TEXT NOT NULL DEFAULT '[]'") |
    ensureColumn("issues", "outputs_json", "TEXT NOT NULL DEFAULT '[]'") |
    ensureColumn("projects", "folders_json", "TEXT NOT NULL DEFAULT '[]'") |
    ensureColumn("projects", "git_url", "TEXT");
  if (altered) persist();
  try {
    return await fn(db, persist);
  } finally {
    db.close();
  }
}

async function getIssue(idOrIdentifier) {
  return withDb((db) => {
    const row = findIssueRow(db, idOrIdentifier);
    if (!row) throw new Error(`议题不存在: ${idOrIdentifier}`);
    return mapIssue(row, db, { withComments: true, withActivities: true });
  });
}

async function listComments(idOrIdentifier) {
  return withDb((db) => {
    const row = findIssueRow(db, idOrIdentifier);
    if (!row) throw new Error(`议题不存在: ${idOrIdentifier}`);
    return {
      issueId: row.id,
      identifier: row.identifier,
      comments: loadComments(db, row.id),
    };
  });
}

/**
 * @param {string} idOrIdentifier
 * @param {{ status?: string, threadId?: string | null, gitBranch?: string | null, worktreePath?: string | null }} patch
 */
async function updateIssue(idOrIdentifier, patch = {}) {
  return withDb((db, persist) => {
    const row = findIssueRow(db, idOrIdentifier);
    if (!row) throw new Error(`议题不存在: ${idOrIdentifier}`);
    const now = new Date().toISOString();
    const nextStatus = patch.status != null ? patch.status : String(row.status);
    const nextThread =
      patch.threadId !== undefined ? patch.threadId || null : row.thread_id;
    const nextBranch =
      patch.gitBranch !== undefined ? patch.gitBranch || null : row.git_branch;
    const nextWorktree =
      patch.worktreePath !== undefined ? patch.worktreePath || null : row.worktree_path;
    const processing = nextStatus === "in_progress" ? 1 : 0;
    if (patch.status != null && patch.status !== row.status) {
      const activityId = `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      db.run(
        `INSERT INTO activities (id, issue_id, kind, actor_name, field, before_value, after_value, created_at)
         VALUES (?, ?, 'change', 'Cursor Agent', 'status', ?, ?, ?)`,
        [activityId, row.id, row.status, patch.status, now],
      );
    }
    db.run(
      `UPDATE issues SET status = ?, processing = ?, thread_id = ?, git_branch = ?, worktree_path = ?, updated_at = ? WHERE id = ?`,
      [nextStatus, processing, nextThread, nextBranch, nextWorktree, now, row.id],
    );
    persist();
    const next = findIssueRow(db, row.id);
    return mapIssue(next, db, { withComments: true });
  });
}

/**
 * @param {string} idOrIdentifier
 * @param {{ body: string, threadId?: string | null }} input
 */
async function addComment(idOrIdentifier, input) {
  const body = String(input.body || "").trim();
  if (!body) throw new Error("评论不能为空");
  return withDb((db, persist) => {
    const row = findIssueRow(db, idOrIdentifier);
    if (!row) throw new Error(`议题不存在: ${idOrIdentifier}`);
    const now = new Date().toISOString();
    const commentId = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const threadId = input.threadId != null ? input.threadId : null;
    const parentCommentId = input.parentCommentId != null ? input.parentCommentId : null;
    db.run(
      `INSERT INTO comments (id, issue_id, author_name, author_id, author_type, kind, body, thread_id, parent_comment_id, attachments_json, created_at)
       VALUES (?, ?, 'Cursor Agent', 'cursor-agent', 'agent', 'agent_report', ?, ?, ?, '[]', ?)`,
      [commentId, row.id, body, threadId, parentCommentId, now],
    );
    db.run("UPDATE issues SET updated_at = ? WHERE id = ?", [now, row.id]);
    persist();
    return {
      comment: {
        id: commentId,
        authorName: "Cursor Agent",
        authorId: "cursor-agent",
        authorType: "agent",
        kind: "agent_report",
        body,
        threadId,
        parentCommentId,
        attachments: [],
        createdAt: now,
      },
      issue: mapIssue(findIssueRow(db, row.id), db, { withComments: true }),
    };
  });
}

module.exports = {
  CONFIG_PATH,
  getIssue,
  listComments,
  updateIssue,
  addComment,
};
