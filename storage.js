const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");

function hashBuffer(buffer) {
  return crypto.createHash("sha1").update(buffer).digest("hex");
}

/** @typedef {{ id: string, name: string, keyPrefix?: string, seq?: number, folders?: string[], gitUrl?: string | null, gitUrls?: string[] }} Project */
/** @typedef {Record<string, any>} Issue */

const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL DEFAULT 'OPEN',
  seq INTEGER NOT NULL DEFAULT 0,
  folders_json TEXT NOT NULL DEFAULT '[]',
  git_url TEXT,
  git_urls_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  identifier TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'none',
  labels_json TEXT NOT NULL DEFAULT '[]',
  assignee TEXT,
  assignee_me INTEGER NOT NULL DEFAULT 0,
  start_date TEXT,
  due_date TEXT,
  processing INTEGER NOT NULL DEFAULT 0,
  thread_id TEXT,
  git_branch TEXT,
  worktree_path TEXT,
  parent_issue_id TEXT,
  creator_name TEXT,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  outputs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (parent_issue_id) REFERENCES issues(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor_name TEXT,
  field TEXT,
  before_value TEXT,
  after_value TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  author_name TEXT,
  author_id TEXT,
  author_type TEXT,
  kind TEXT,
  body TEXT NOT NULL,
  thread_id TEXT,
  parent_comment_id TEXT,
  fork_thread_ids_json TEXT NOT NULL DEFAULT '[]',
  attachments_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS issue_relations (
  id TEXT PRIMARY KEY,
  from_issue_id TEXT NOT NULL,
  to_issue_id TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(from_issue_id, to_issue_id, type),
  FOREIGN KEY (from_issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (to_issue_id) REFERENCES issues(id) ON DELETE CASCADE
);
`;

/** @type {ReadonlySet<string>} */
const COMMENT_KINDS = new Set(["chat_turn", "agent_report", "user_comment"]);

/**
 * Resolve comment kind from explicit value or legacy id / author_type.
 * @param {{ id?: string, kind?: string | null, authorType?: string | null }} input
 */
function resolveCommentKind(input = {}) {
  const explicit = String(input.kind || "").trim();
  // Legacy chat_report collapsed into agent_report.
  if (explicit === "chat_report") return "agent_report";
  if (COMMENT_KINDS.has(explicit)) return explicit;
  const id = String(input.id || "");
  if (id.startsWith("c-report-")) return "agent_report";
  if (id.startsWith("c-chat-")) return "chat_turn";
  if (input.authorType === "agent") return "agent_report";
  return "user_comment";
}

/**
 * @param {unknown} value
 * @returns {Array<{ threadId: string, createdAt: string, bubbleId?: string | null, sourceThreadId?: string | null }>}
 */
/**
 * @param {unknown} value
 * @returns {string[]}
 */
function parseFolders(value) {
  /** @type {unknown[]} */
  let list = [];
  if (Array.isArray(value)) {
    list = value;
  } else if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) list = parsed;
      else list = String(value).split(/\r?\n+/);
    } catch {
      list = String(value).split(/\r?\n+/);
    }
  }
  return [...new Set(list.map((item) => String(item || "").trim()).filter(Boolean))];
}

/**
 * @param {unknown} gitUrls
 * @param {string | null | undefined} [legacyGitUrl]
 * @returns {string[]}
 */
function parseGitUrls(gitUrls, legacyGitUrl) {
  const list = parseFolders(gitUrls);
  if (list.length) return list;
  const single = String(legacyGitUrl || "").trim();
  return single ? [single] : [];
}

/**
 * @param {string[] | string | null | undefined} folders
 * @returns {string | null}
 */
function serializeFoldersToWorktree(folders) {
  const list = parseFolders(folders);
  return list.length ? list.join("\n") : null;
}

/**
 * Normalize folder lists for equality checks (order-independent, resolved paths).
 * @param {unknown} folders
 * @returns {string}
 */
function normalizeFolderKey(folders) {
  return parseFolders(folders)
    .map((item) => {
      try {
        return path.resolve(item);
      } catch {
        return String(item || "").trim();
      }
    })
    .filter(Boolean)
    .sort()
    .join("\n");
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function foldersMatch(a, b) {
  return normalizeFolderKey(a) === normalizeFolderKey(b);
}

/**
 * @param {unknown} value
 * @param {{ imagesOnly?: boolean }} [options]
 * @returns {Array<{ id: string, mime: string, name: string, relPath: string, url?: string }>}
 */
/**
 * 议题产出：目录书（章节为 md）
 * @param {unknown} value
 */
function parseOutputs(value) {
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
      const row = /** @type {Record<string, any>} */ (item);
      const rootPath = String(row.rootPath || "").trim();
      if (!rootPath) return null;
      const id = String(row.id || `out-${index}`).trim() || `out-${index}`;
      const title = String(row.title || path.basename(rootPath) || `产出 ${index + 1}`).trim();
      const chapters = Array.isArray(row.chapters)
        ? row.chapters
            .map((chapter, chapterIndex) => {
              if (!chapter || typeof chapter !== "object") return null;
              const ch = /** @type {Record<string, any>} */ (chapter);
              const chapterPath = String(ch.path || "").trim();
              if (!chapterPath) return null;
              return {
                id: String(ch.id || `ch-${chapterIndex}`).trim() || `ch-${chapterIndex}`,
                title: String(ch.title || path.basename(chapterPath, path.extname(chapterPath)) || `章节 ${chapterIndex + 1}`).trim(),
                path: chapterPath,
                relPath: String(ch.relPath || path.basename(chapterPath)).trim(),
              };
            })
            .filter(Boolean)
        : [];
      return {
        id,
        title,
        rootPath,
        chapters,
        createdAt: String(row.createdAt || ""),
        updatedAt: row.updatedAt ? String(row.updatedAt) : undefined,
      };
    })
    .filter(Boolean);
}

function parseAttachments(value, options = {}) {
  const imagesOnly = Boolean(options.imagesOnly);
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
      const row = /** @type {Record<string, any>} */ (item);
      const relPath = String(row.relPath || "").trim();
      if (!relPath || relPath.includes("..") || path.isAbsolute(relPath)) return null;
      const mime = String(row.mime || "application/octet-stream").trim() || "application/octet-stream";
      if (imagesOnly && !mime.startsWith("image/")) return null;
      const id = String(row.id || `att-${index}`).trim() || `att-${index}`;
      const name = String(row.name || path.basename(relPath) || `file-${index + 1}`).trim();
      /** @type {{ id: string, mime: string, name: string, relPath: string, url?: string }} */
      const next = { id, mime, name, relPath };
      if (row.url) next.url = String(row.url);
      return next;
    })
    .filter(Boolean);
}

function parseForkThreadIds(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          const threadId = item.trim();
          return threadId ? { threadId, createdAt: "", bubbleId: null, sourceThreadId: null } : null;
        }
        if (!item || typeof item !== "object") return null;
        const threadId = String(/** @type {any} */ (item).threadId || "").trim();
        if (!threadId) return null;
        return {
          threadId,
          createdAt: String(/** @type {any} */ (item).createdAt || ""),
          bubbleId: /** @type {any} */ (item).bubbleId ? String(/** @type {any} */ (item).bubbleId) : null,
          sourceThreadId: /** @type {any} */ (item).sourceThreadId
            ? String(/** @type {any} */ (item).sourceThreadId)
            : null,
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

const GUIDE_PROJECT_ID = "muqi-task";
const GUIDE_ISSUE_ID = "guide";
const GUIDE_ISSUE_TITLE = "Muqi Task 实践指南";
const OLD_SEED_ISSUE_IDS = ["t1", "t2", "t3", "t4", "t5", "t6", "t7"];
const OLD_SEED_IDENTIFIERS = ["LOCAL-2", "OPEN-8", "OPEN-9", "OPEN-13", "OPEN-14", "OPEN-15", "OPEN-16"];
const OLD_SEED_PROJECT_IDS = ["opendata", "cursor-taskboard", "local", "dashi-taskboard"];

const GUIDE_DESCRIPTION = [
  "欢迎使用 Muqi Task。这是 Cursor 侧栏里的任务面板：议题保存在本机 SQLite，可按列表或看板管理，也可以交给 Agent 处理。",
  "",
  "打开面板",
  "点击最左侧活动栏的三列图标，打开 Task Panel。",
  "",
  "项目",
  "顶部下拉可切换项目，或选择「全部项目」。",
  "「项目管理」用来新增、编辑项目，并关联本地文件夹或 Git 仓库。",
  "「自动化」里可配置同步与备份。",
  "",
  "议题",
  "点右上角 + 新建一条议题。",
  "搜索框按标题筛选。",
  "列表视图：按状态分组查看。",
  "议题看板：拖拽卡片即可改状态。",
  "甘特图：按时间查看（若尚未完善会显示占位）。",
  "点开议题可改标题、描述、负责人、日期，并在对话中交给 Agent。",
  "",
  "和 Agent 协作",
  "在议题里选择「在对话中打开」。Agent 会读取本议题、同步状态，并把进展写回评论。",
  "",
  "数据",
  "数据只存在本机，不经过云端。可在设置里备份到 Git。",
  "",
  "接下来",
  "读完后可以把本指南标为完成，或直接点 + 创建你自己的第一条议题。",
].join("\n");

function buildGuideIssue(identifier) {
  const now = new Date().toISOString();
  return {
    id: GUIDE_ISSUE_ID,
    projectId: GUIDE_PROJECT_ID,
    identifier,
    title: GUIDE_ISSUE_TITLE,
    description: GUIDE_DESCRIPTION,
    status: "todo",
    priority: "none",
    labels: ["guide"],
    assignee: null,
    assigneeMe: false,
    startDate: null,
    dueDate: null,
    processing: false,
    threadId: null,
    createdAt: now,
    updatedAt: now,
    creatorName: "Muqi Task",
    activities: [],
    comments: [
      {
        id: "c-guide-welcome",
        authorName: "Muqi Task",
        authorId: "muqi-task",
        authorType: "user",
        kind: "user_comment",
        body: "打开本议题即可查看完整使用说明。读完后可以把它标为完成，或按 + 新建你自己的议题。",
        createdAt: now,
        threadId: null,
      },
    ],
  };
}

const SEED_PROJECTS = [{ id: GUIDE_PROJECT_ID, name: "Muqi Task", keyPrefix: "MUQI", seq: 1 }];
const SEED_ISSUES = [buildGuideIssue("MUQI-1")];

/**
 * @param {import('vscode').Uri} globalStorageUri
 */
async function createStore(globalStorageUri) {
  const dir = globalStorageUri.fsPath;
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "taskboard.db");

  const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
  const SQL = await initSqlJs({
    locateFile: () => wasmPath,
  });

  const existed = fs.existsSync(dbPath);
  const fileBuffer = existed ? fs.readFileSync(dbPath) : null;
  /** @type {import('sql.js').Database} */
  let db = fileBuffer ? new SQL.Database(fileBuffer) : new SQL.Database();
  let suppressPersistNotify = false;
  /** Content we last read from / wrote to disk, so fs.watch can skip our own writes. */
  let knownDiskHash = fileBuffer ? hashBuffer(fileBuffer) : "";

  db.run(SCHEMA_SQL);

  function persist() {
    suppressPersistNotify = true;
    const data = db.export();
    const buffer = Buffer.from(data);
    knownDiskHash = hashBuffer(buffer);
    fs.writeFileSync(dbPath, buffer);
    setTimeout(() => {
      suppressPersistNotify = false;
    }, 150);
  }

  function reloadFromDisk() {
    if (!fs.existsSync(dbPath)) return false;
    const buffer = fs.readFileSync(dbPath);
    knownDiskHash = hashBuffer(buffer);
    const next = new SQL.Database(buffer);
    db.close();
    db = next;
    return true;
  }

  /**
   * True when the file on disk still holds the bytes we last wrote or read.
   * The 150ms suppress flag loses the race against the watcher's 200ms debounce,
   * so every self-write used to be replayed as an external change.
   */
  function diskMatchesKnownState() {
    if (!knownDiskHash) return false;
    try {
      return hashBuffer(fs.readFileSync(dbPath)) === knownDiskHash;
    } catch {
      return false;
    }
  }

  function metaGet(key) {
    const stmt = db.prepare("SELECT value FROM meta WHERE key = ?");
    stmt.bind([key]);
    const value = stmt.step() ? stmt.getAsObject().value : null;
    stmt.free();
    return value;
  }

  function metaSet(key, value) {
    db.run("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
      key,
      String(value),
    ]);
  }

  function insertIssueRow(issue) {
    db.run(
      `INSERT INTO issues (
        id, project_id, identifier, title, description, status, priority, labels_json,
        assignee, assignee_me, start_date, due_date, processing, thread_id, git_branch, worktree_path,
        parent_issue_id, creator_name, attachments_json, outputs_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        issue.id,
        issue.projectId,
        issue.identifier,
        issue.title,
        issue.description || "",
        issue.status,
        issue.priority || "none",
        JSON.stringify(issue.labels || []),
        issue.assignee || null,
        issue.assigneeMe ? 1 : 0,
        issue.startDate || null,
        issue.dueDate || null,
        issue.processing ? 1 : 0,
        issue.threadId || null,
        issue.gitBranch || null,
        issue.worktreePath || null,
        issue.parentIssueId || null,
        issue.creatorName || null,
        JSON.stringify(parseAttachments(issue.attachments || [])),
        JSON.stringify(parseOutputs(issue.outputs || [])),
        issue.createdAt,
        issue.updatedAt,
      ],
    );

    for (const activity of issue.activities || []) {
      db.run(
        `INSERT INTO activities (id, issue_id, kind, actor_name, field, before_value, after_value, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          activity.id,
          issue.id,
          activity.kind || "change",
          activity.actorName || null,
          activity.field || null,
          activity.before ?? null,
          activity.after ?? null,
          activity.createdAt,
        ],
      );
    }

    for (const comment of issue.comments || []) {
      db.run(
        `INSERT INTO comments (id, issue_id, author_name, author_id, author_type, kind, body, thread_id, parent_comment_id, fork_thread_ids_json, attachments_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          comment.id,
          issue.id,
          comment.authorName || null,
          comment.authorId || null,
          comment.authorType || null,
          resolveCommentKind(comment),
          comment.body,
          comment.threadId || null,
          comment.parentCommentId || null,
          JSON.stringify(parseForkThreadIds(comment.forkThreadIds || comment.fork_thread_ids_json || [])),
          JSON.stringify(parseAttachments(comment.attachments || comment.attachments_json || [])),
          comment.createdAt,
        ],
      );
    }
  }

  function hasRow(sql, params) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const found = stmt.step();
    stmt.free();
    return found;
  }

  function replaceMockSeedWithGuide() {
    db.run("PRAGMA foreign_keys = ON");
    db.run(
      `DELETE FROM issues WHERE id IN (${OLD_SEED_ISSUE_IDS.map(() => "?").join(",")})`,
      OLD_SEED_ISSUE_IDS,
    );
    db.run(
      `DELETE FROM issues WHERE identifier IN (${OLD_SEED_IDENTIFIERS.map(() => "?").join(",")})`,
      OLD_SEED_IDENTIFIERS,
    );
    for (const projectId of OLD_SEED_PROJECT_IDS) {
      const stmt = db.prepare("SELECT COUNT(*) AS c FROM issues WHERE project_id = ?");
      stmt.bind([projectId]);
      const count = stmt.step() ? Number(stmt.getAsObject().c || 0) : 0;
      stmt.free();
      if (count === 0) {
        db.run("DELETE FROM projects WHERE id = ?", [projectId]);
      }
    }

    if (!hasRow("SELECT 1 FROM projects WHERE id = ? LIMIT 1", [GUIDE_PROJECT_ID])) {
      db.run(
        "INSERT INTO projects (id, name, key_prefix, seq, folders_json, git_url, git_urls_json) VALUES (?, ?, ?, ?, '[]', NULL, '[]')",
        [GUIDE_PROJECT_ID, "Muqi Task", "MUQI", 1],
      );
    } else {
      db.run("UPDATE projects SET name = ? WHERE id = ?", ["Muqi Task", GUIDE_PROJECT_ID]);
    }

    if (hasRow("SELECT 1 FROM issues WHERE id = ? OR title = ? LIMIT 1", [GUIDE_ISSUE_ID, GUIDE_ISSUE_TITLE])) {
      db.run(
        "UPDATE issues SET description = ?, title = ? WHERE id = ? OR title = ?",
        [GUIDE_DESCRIPTION, GUIDE_ISSUE_TITLE, GUIDE_ISSUE_ID, GUIDE_ISSUE_TITLE],
      );
      return;
    }

    const identifier = hasRow("SELECT 1 FROM issues WHERE identifier = ? LIMIT 1", ["MUQI-1"])
      ? "MUQI-GUIDE"
      : "MUQI-1";
    insertIssueRow(buildGuideIssue(identifier));
    if (identifier === "MUQI-1") {
      db.run("UPDATE projects SET seq = CASE WHEN seq < 1 THEN 1 ELSE seq END WHERE id = ?", [GUIDE_PROJECT_ID]);
    }
  }

  function seedIfNeeded() {
    if (metaGet("schemaVersion")) return false;
    const tx = db;
    for (const project of SEED_PROJECTS) {
      tx.run(
        "INSERT INTO projects (id, name, key_prefix, seq, folders_json, git_url, git_urls_json) VALUES (?, ?, ?, ?, '[]', NULL, '[]')",
        [project.id, project.name, project.keyPrefix, project.seq],
      );
    }
    for (const issue of SEED_ISSUES) {
      insertIssueRow(issue);
    }
    metaSet("schemaVersion", "1");
    metaSet("seededAt", new Date().toISOString());
    persist();
    return true;
  }

  if (!existed || !metaGet("schemaVersion")) {
    seedIfNeeded();
    if (!metaGet("schemaVersion")) {
      metaSet("schemaVersion", "1");
      persist();
    }
  }

  function ensureColumn(table, column, definition) {
    const info = db.exec(`PRAGMA table_info(${table})`);
    const cols = info.length ? info[0].values.map((row) => row[1]) : [];
    if (!cols.includes(column)) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      return true;
    }
    return false;
  }

  // ALTER 后立刻落盘，避免 MCP 子进程读到旧 schema
  const schemaAltered =
    ensureColumn("issues", "git_branch", "TEXT") |
    ensureColumn("issues", "worktree_path", "TEXT") |
    ensureColumn("issues", "parent_issue_id", "TEXT") |
    ensureColumn("issues", "attachments_json", "TEXT NOT NULL DEFAULT '[]'") |
    ensureColumn("issues", "outputs_json", "TEXT NOT NULL DEFAULT '[]'") |
    ensureColumn("projects", "folders_json", "TEXT NOT NULL DEFAULT '[]'") |
    ensureColumn("projects", "git_url", "TEXT") |
    ensureColumn("projects", "git_urls_json", "TEXT NOT NULL DEFAULT '[]'") |
    ensureColumn("comments", "parent_comment_id", "TEXT") |
    ensureColumn("comments", "kind", "TEXT") |
    ensureColumn("comments", "fork_thread_ids_json", "TEXT NOT NULL DEFAULT '[]'") |
    ensureColumn("comments", "attachments_json", "TEXT NOT NULL DEFAULT '[]'");
  if (schemaAltered) persist();

  // 去掉历史 seed 里的 dashi-taskboard 名称
  {
    const named = db.exec(
      `SELECT id FROM projects WHERE id = 'dashi-taskboard' OR name = 'dashi-taskboard'`,
    );
    if (named.length && named[0].values.length) {
      const taken = db.exec(`SELECT 1 FROM projects WHERE id = 'cursor-taskboard' LIMIT 1`);
      const hasCursor = Boolean(taken.length && taken[0].values.length);
      db.run("PRAGMA foreign_keys = OFF");
      if (hasCursor) {
        db.run(`UPDATE issues SET project_id = 'cursor-taskboard' WHERE project_id = 'dashi-taskboard'`);
        db.run(`DELETE FROM projects WHERE id = 'dashi-taskboard'`);
      } else {
        db.run(
          `UPDATE projects SET id = 'cursor-taskboard', name = 'cursor-taskboard' WHERE id = 'dashi-taskboard'`,
        );
        db.run(`UPDATE issues SET project_id = 'cursor-taskboard' WHERE project_id = 'dashi-taskboard'`);
      }
      db.run("PRAGMA foreign_keys = ON");
    }
    db.run(
      `UPDATE issues SET description = replace(description, '视觉接近 dashi-taskboard 即可进入下一阶段。', '完成首版 UI 验收即可进入下一阶段。') WHERE description LIKE '%dashi-taskboard%'`,
    );
    persist();
  }

  // 将旧 git_url 迁入 git_urls_json
  {
    const rows = db.exec(`SELECT id, git_url AS gitUrl, git_urls_json AS gitUrlsJson FROM projects`);
    if (rows.length) {
      let migrated = false;
      for (const [id, gitUrl, gitUrlsJson] of rows[0].values) {
        const urls = parseGitUrls(gitUrlsJson, gitUrl);
        const current = parseFolders(gitUrlsJson);
        if (urls.length && (!current.length || current.join("\n") !== urls.join("\n"))) {
          db.run(`UPDATE projects SET git_urls_json = ?, git_url = ? WHERE id = ?`, [
            JSON.stringify(urls),
            urls[0] || null,
            id,
          ]);
          migrated = true;
        }
      }
      if (migrated) persist();
    }
  }

  if (metaGet("schemaVersion") === "1") {
    metaSet("schemaVersion", "2");
    persist();
  }
  // Clear mock / non-UUID composer bindings that hang Cursor chat on open.
  if (metaGet("schemaVersion") === "2") {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isBadThread = (value) => {
      const id = String(value || "").trim();
      return !id || /demo/i.test(id) || !uuidRe.test(id);
    };
    for (const table of ["issues", "comments"]) {
      const rows = db.exec(`SELECT id, thread_id FROM ${table} WHERE thread_id IS NOT NULL`);
      if (!rows.length) continue;
      for (const [rowId, threadId] of rows[0].values) {
        if (!isBadThread(threadId)) continue;
        db.run(`UPDATE ${table} SET thread_id = NULL WHERE id = ?`, [rowId]);
      }
    }
    metaSet("schemaVersion", "3");
    persist();
  }
  // Backfill comments.kind from legacy id prefixes / author_type.
  if (metaGet("schemaVersion") === "3") {
    db.run(`UPDATE comments SET kind = 'agent_report' WHERE id LIKE 'c-report-%' AND (kind IS NULL OR kind = '')`);
    db.run(`UPDATE comments SET kind = 'chat_turn' WHERE id LIKE 'c-chat-%' AND (kind IS NULL OR kind = '')`);
    db.run(
      `UPDATE comments SET kind = 'agent_report'
       WHERE author_type = 'agent'
         AND (kind IS NULL OR kind = '')
         AND id NOT LIKE 'c-chat-%'`,
    );
    db.run(`UPDATE comments SET kind = 'user_comment' WHERE kind IS NULL OR kind = ''`);
    metaSet("schemaVersion", "4");
    persist();
  }
  // Collapse legacy chat_report into agent_report (chat_turn parents stay the same).
  if (metaGet("schemaVersion") === "4") {
    db.run(`UPDATE comments SET kind = 'agent_report' WHERE kind = 'chat_report' OR id LIKE 'c-report-%'`);
    metaSet("schemaVersion", "5");
    persist();
  }
  if (metaGet("schemaVersion") === "5") {
    db.run(`UPDATE comments SET fork_thread_ids_json = '[]' WHERE fork_thread_ids_json IS NULL`);
    metaSet("schemaVersion", "6");
    persist();
  }
  if (metaGet("schemaVersion") === "6") {
    metaSet("schemaVersion", "7");
    persist();
  }
  if (metaGet("schemaVersion") === "7") {
    metaSet("schemaVersion", "8");
    persist();
  }
  // Allow issues without a project (project_id nullable).
  if (metaGet("schemaVersion") === "8") {
    const info = db.exec("PRAGMA table_info(issues)");
    const projectCol = info.length
      ? info[0].values.find((row) => String(row[1]) === "project_id")
      : null;
    const notNull = projectCol ? Number(projectCol[3]) === 1 : true;
    if (notNull) {
      db.run("PRAGMA foreign_keys = OFF");
      db.run(`
        CREATE TABLE issues_v9 (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          identifier TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL,
          priority TEXT NOT NULL DEFAULT 'none',
          labels_json TEXT NOT NULL DEFAULT '[]',
          assignee TEXT,
          assignee_me INTEGER NOT NULL DEFAULT 0,
          start_date TEXT,
          due_date TEXT,
          processing INTEGER NOT NULL DEFAULT 0,
          thread_id TEXT,
          git_branch TEXT,
          worktree_path TEXT,
          parent_issue_id TEXT,
          creator_name TEXT,
          attachments_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id),
          FOREIGN KEY (parent_issue_id) REFERENCES issues_v9(id) ON DELETE SET NULL
        )
      `);
      db.run(`
        INSERT INTO issues_v9 (
          id, project_id, identifier, title, description, status, priority, labels_json,
          assignee, assignee_me, start_date, due_date, processing, thread_id, git_branch, worktree_path,
          parent_issue_id, creator_name, attachments_json, created_at, updated_at
        )
        SELECT
          id, project_id, identifier, title, description, status, priority, labels_json,
          assignee, assignee_me, start_date, due_date, processing, thread_id, git_branch, worktree_path,
          parent_issue_id, creator_name, attachments_json, created_at, updated_at
        FROM issues
      `);
      db.run("DROP TABLE issues");
      db.run("ALTER TABLE issues_v9 RENAME TO issues");
      db.run("PRAGMA foreign_keys = ON");
    }
    metaSet("schemaVersion", "9");
    persist();
  }
  if (metaGet("schemaVersion") === "9") {
    replaceMockSeedWithGuide();
    metaSet("schemaVersion", "10");
    persist();
  }

  function tableColumns(database, table) {
    const info = database.exec(`PRAGMA table_info(${table})`);
    if (!info.length) return [];
    return info[0].values.map((row) => String(row[1]));
  }

  function copyDirIfExists(from, to) {
    if (!fs.existsSync(from)) return 0;
    fs.mkdirSync(to, { recursive: true });
    let copied = 0;
    for (const name of fs.readdirSync(from)) {
      const src = path.join(from, name);
      const dest = path.join(to, name);
      const st = fs.statSync(src);
      if (st.isDirectory()) {
        copied += copyDirIfExists(src, dest);
        continue;
      }
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
        copied += 1;
      }
    }
    return copied;
  }

  function importTableRows(legacy, table) {
    const srcCols = tableColumns(legacy, table);
    const dstCols = tableColumns(db, table);
    const cols = srcCols.filter((col) => dstCols.includes(col));
    if (!cols.length) return 0;
    const quoted = cols.map((col) => `"${col}"`).join(", ");
    const rows = legacy.exec(`SELECT ${quoted} FROM ${table}`);
    if (!rows.length) return 0;
    const placeholders = cols.map(() => "?").join(", ");
    let count = 0;
    for (const row of rows[0].values) {
      db.run(`INSERT OR IGNORE INTO ${table} (${quoted}) VALUES (${placeholders})`, row);
      count += 1;
    }
    return count;
  }

  function importLegacyCursorTaskboard() {
    if (metaGet("importedLegacyCursorTaskboard")) return;
    const legacyDir = path.join(path.dirname(dir), "local-test.cursor-taskboard");
    const legacyDbPath = path.join(legacyDir, "taskboard.db");
    if (!fs.existsSync(legacyDbPath)) {
      metaSet("importedLegacyCursorTaskboard", "absent");
      persist();
      return;
    }
    const legacy = new SQL.Database(fs.readFileSync(legacyDbPath));
    try {
      const legacyMuqi1 = legacy.exec(`SELECT 1 FROM issues WHERE identifier = 'MUQI-1' LIMIT 1`);
      if (legacyMuqi1.length && legacyMuqi1[0].values.length) {
        db.run(
          "UPDATE issues SET identifier = 'MUQI-GUIDE' WHERE id = ? AND identifier = 'MUQI-1'",
          [GUIDE_ISSUE_ID],
        );
      }
      importTableRows(legacy, "projects");
      const seqRows = legacy.exec("SELECT id, seq FROM projects");
      if (seqRows.length) {
        for (const [id, seq] of seqRows[0].values) {
          db.run("UPDATE projects SET seq = CASE WHEN seq < ? THEN ? ELSE seq END WHERE id = ?", [
            seq,
            seq,
            id,
          ]);
        }
      }
      importTableRows(legacy, "issues");
      importTableRows(legacy, "comments");
      importTableRows(legacy, "activities");
      importTableRows(legacy, "issue_relations");
      copyDirIfExists(path.join(legacyDir, "attachments"), path.join(dir, "attachments"));
      copyDirIfExists(path.join(legacyDir, "sync-prompts"), path.join(dir, "sync-prompts"));
    } finally {
      legacy.close();
    }
    metaSet("importedLegacyCursorTaskboard", "ok");
    persist();
  }

  if (metaGet("schemaVersion") === "10") {
    importLegacyCursorTaskboard();
    metaSet("schemaVersion", "11");
    persist();
  }

  function countIssuesByProject(projectId) {
    const stmt = db.prepare("SELECT COUNT(*) AS c FROM issues WHERE project_id = ?");
    stmt.bind([projectId]);
    const count = stmt.step() ? Number(stmt.getAsObject().c || 0) : 0;
    stmt.free();
    return count;
  }

  function listProjects() {
    const rows = db.exec(
      `SELECT id, name, key_prefix AS keyPrefix, seq,
              folders_json AS foldersJson, git_url AS gitUrl, git_urls_json AS gitUrlsJson
       FROM projects ORDER BY name`,
    );
    if (!rows.length) return [];
    return rows[0].values.map(([id, name, keyPrefix, seq, foldersJson, gitUrl, gitUrlsJson]) => {
      const gitUrls = parseGitUrls(gitUrlsJson, gitUrl);
      return {
        id,
        name,
        keyPrefix,
        seq,
        folders: parseFolders(foldersJson),
        gitUrls,
        gitUrl: gitUrls[0] || null,
        issueCount: countIssuesByProject(id),
      };
    });
  }

  function getProject(projectId) {
    const id = String(projectId || "").trim();
    if (!id) return null;
    return listProjects().find((item) => item.id === id) || null;
  }

  /**
   * @param {string} name
   * @param {string} [preferredId]
   */
  function allocateProjectId(name, preferredId) {
    const raw = String(preferredId || name || "project")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    let base = raw || `project-${Date.now().toString(36)}`;
    let candidate = base;
    let n = 2;
    while (getProject(candidate)) {
      candidate = `${base}-${n}`;
      n += 1;
    }
    return candidate;
  }

  /**
   * @param {string} name
   * @param {string} [preferred]
   */
  function allocateKeyPrefix(name, preferred) {
    const explicit = String(preferred || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "")
      .slice(0, 8);
    if (explicit) return explicit;
    const fromName = String(name || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "")
      .slice(0, 4);
    return fromName || "PROJ";
  }

  /**
   * @param {{
   *   id?: string,
   *   name: string,
   *   keyPrefix?: string,
   *   folders?: string[],
   *   gitUrl?: string | null,
   *   gitUrls?: string[],
   * }} input
   */
  function createProject(input = {}) {
    const name = String(input.name || "").trim();
    if (!name) throw new Error("项目名称不能为空");
    const id = allocateProjectId(name, input.id);
    const keyPrefix = allocateKeyPrefix(name, input.keyPrefix);
    const folders = parseFolders(input.folders);
    const gitUrls = parseGitUrls(
      input.gitUrls !== undefined ? input.gitUrls : null,
      input.gitUrl,
    );
    db.run(
      `INSERT INTO projects (id, name, key_prefix, seq, folders_json, git_url, git_urls_json)
       VALUES (?, ?, ?, 0, ?, ?, ?)`,
      [id, name, keyPrefix, JSON.stringify(folders), gitUrls[0] || null, JSON.stringify(gitUrls)],
    );
    persist();
    return getProject(id);
  }

  /**
   * @param {string} projectId
   * @param {{ name?: string, keyPrefix?: string, folders?: string[], gitUrl?: string | null, gitUrls?: string[] }} patch
   * @returns {{ project: Project & { issueCount?: number }, syncedIssueCount: number }}
   */
  function updateProject(projectId, patch = {}) {
    const current = getProject(projectId);
    if (!current) throw new Error(`项目不存在: ${projectId}`);
    const prevFolders = current.folders || [];
    const nextGitUrls =
      patch.gitUrls !== undefined
        ? parseGitUrls(patch.gitUrls, null)
        : patch.gitUrl !== undefined
          ? parseGitUrls(null, patch.gitUrl)
          : parseGitUrls(current.gitUrls, current.gitUrl);
    const next = {
      name: patch.name !== undefined ? String(patch.name || "").trim() : current.name,
      keyPrefix:
        patch.keyPrefix !== undefined
          ? allocateKeyPrefix(current.name, patch.keyPrefix)
          : current.keyPrefix,
      folders: patch.folders !== undefined ? parseFolders(patch.folders) : current.folders,
      gitUrls: nextGitUrls,
      gitUrl: nextGitUrls[0] || null,
    };
    if (!next.name) throw new Error("项目名称不能为空");
    const foldersChanged =
      patch.folders !== undefined && !foldersMatch(prevFolders, next.folders);
    db.run(
      `UPDATE projects SET name = ?, key_prefix = ?, folders_json = ?, git_url = ?, git_urls_json = ? WHERE id = ?`,
      [
        next.name,
        next.keyPrefix,
        JSON.stringify(next.folders),
        next.gitUrl,
        JSON.stringify(next.gitUrls),
        current.id,
      ],
    );

    let syncedIssueCount = 0;
    if (foldersChanged) {
      const oldKey = normalizeFolderKey(prevFolders);
      const nextWorktree = serializeFoldersToWorktree(next.folders);
      const now = new Date().toISOString();
      const stmt = db.prepare(
        "SELECT id, worktree_path AS worktreePath FROM issues WHERE project_id = ?",
      );
      stmt.bind([current.id]);
      /** @type {Array<{ id: string, worktreePath: string | null }>} */
      const rows = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        rows.push({
          id: String(row.id),
          worktreePath: row.worktreePath ? String(row.worktreePath) : null,
        });
      }
      stmt.free();

      for (const row of rows) {
        const currentKey = normalizeFolderKey(row.worktreePath);
        // 空上下文，或仍等于项目旧文件夹（未手动改过）→ 同步为新文件夹
        const shouldSync = !currentKey || currentKey === oldKey;
        if (!shouldSync) continue;
        if (foldersMatch(row.worktreePath, next.folders)) continue;
        db.run("UPDATE issues SET worktree_path = ?, updated_at = ? WHERE id = ?", [
          nextWorktree,
          now,
          row.id,
        ]);
        syncedIssueCount += 1;
      }
    }

    persist();
    return { project: getProject(current.id), syncedIssueCount };
  }

  /**
   * @param {string} projectId
   * @returns {{ deleted: true, projectId: string, deletedIssues: number }}
   */
  function deleteProject(projectId) {
    const current = getProject(projectId);
    if (!current) throw new Error(`项目不存在: ${projectId}`);
    const remaining = listProjects().filter((item) => item.id !== current.id);
    if (!remaining.length) throw new Error("至少保留一个项目");

    const issueIds = [];
    const idStmt = db.prepare("SELECT id FROM issues WHERE project_id = ?");
    idStmt.bind([current.id]);
    while (idStmt.step()) {
      const row = idStmt.getAsObject();
      issueIds.push(String(row.id));
    }
    idStmt.free();

    for (const issueId of issueIds) {
      db.run("DELETE FROM issue_relations WHERE from_issue_id = ? OR to_issue_id = ?", [
        issueId,
        issueId,
      ]);
      db.run("DELETE FROM comments WHERE issue_id = ?", [issueId]);
      db.run("DELETE FROM activities WHERE issue_id = ?", [issueId]);
    }
    db.run("DELETE FROM issues WHERE project_id = ?", [current.id]);
    db.run("DELETE FROM projects WHERE id = ?", [current.id]);
    persist();
    return { deleted: true, projectId: current.id, deletedIssues: issueIds.length };
  }

  function mapIssue(row) {
    return {
      id: row.id,
      projectId: row.project_id || null,
      identifier: row.identifier,
      title: row.title,
      description: row.description || "",
      status: row.status,
      priority: row.priority || "none",
      labels: JSON.parse(row.labels_json || "[]"),
      assignee: row.assignee,
      assigneeMe: Boolean(row.assignee_me),
      startDate: row.start_date,
      dueDate: row.due_date,
      processing: Boolean(row.processing),
      threadId: row.thread_id,
      gitBranch: row.git_branch || null,
      worktreePath: row.worktree_path || null,
      parentIssueId: row.parent_issue_id || null,
      creatorName: row.creator_name,
      attachments: parseAttachments(row.attachments_json),
      outputs: parseOutputs(row.outputs_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      activities: [],
      comments: [],
      relations: { blockedBy: [], blocks: [], related: [] },
      parentIssue: null,
      childIssues: [],
    };
  }

  /**
   * @param {Array<Record<string, any>>} issues
   */
  function attachIssueHierarchy(issues) {
    const byId = new Map(issues.map((issue) => [issue.id, issue]));
    for (const issue of issues) {
      issue.childIssues = [];
      issue.parentIssue = null;
    }
    for (const issue of issues) {
      const parentId = issue.parentIssueId || null;
      if (!parentId) continue;
      const parent = byId.get(parentId);
      if (!parent) {
        // Orphan: parent missing — treat as root in UI.
        issue.parentIssueId = null;
        continue;
      }
      // Prevent trivial self-parent.
      if (parent.id === issue.id) {
        issue.parentIssueId = null;
        continue;
      }
      issue.parentIssue = {
        id: parent.id,
        identifier: parent.identifier,
        title: parent.title,
      };
      parent.childIssues.push({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        status: issue.status,
        priority: issue.priority,
      });
    }
    return issues;
  }

  /**
   * @param {string} issueId
   */
  function issueSummary(issueId) {
    const stmt = db.prepare(
      "SELECT id, identifier, title, status, project_id AS projectId FROM issues WHERE id = ?",
    );
    stmt.bind([issueId]);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row;
  }

  /**
   * @param {string} issueId
   */
  function loadRelations(issueId) {
    const stmt = db.prepare(
      `SELECT id, from_issue_id AS fromIssueId, to_issue_id AS toIssueId, type, created_at AS createdAt
       FROM issue_relations
       WHERE from_issue_id = ? OR to_issue_id = ?
       ORDER BY created_at ASC`,
    );
    stmt.bind([issueId, issueId]);
    /** @type {{ blockedBy: any[], blocks: any[], related: any[] }} */
    const groups = { blockedBy: [], blocks: [], related: [] };
    const seen = { blockedBy: new Set(), blocks: new Set(), related: new Set() };

    while (stmt.step()) {
      const row = stmt.getAsObject();
      const otherId = row.fromIssueId === issueId ? row.toIssueId : row.fromIssueId;
      const other = issueSummary(otherId);
      if (!other) continue;
      const item = {
        relationId: row.id,
        issueId: other.id,
        identifier: other.identifier,
        title: other.title,
        status: other.status,
        projectId: other.projectId,
        createdAt: row.createdAt,
      };

      if (row.type === "related") {
        if (seen.related.has(other.id)) continue;
        seen.related.add(other.id);
        groups.related.push(item);
        continue;
      }

      if (row.type === "blocks") {
        if (row.fromIssueId === issueId) {
          if (!seen.blocks.has(other.id)) {
            seen.blocks.add(other.id);
            groups.blocks.push(item);
          }
        } else if (!seen.blockedBy.has(other.id)) {
          seen.blockedBy.add(other.id);
          groups.blockedBy.push(item);
        }
        continue;
      }

      if (row.type === "blocked_by") {
        if (row.fromIssueId === issueId) {
          if (!seen.blockedBy.has(other.id)) {
            seen.blockedBy.add(other.id);
            groups.blockedBy.push(item);
          }
        } else if (!seen.blocks.has(other.id)) {
          seen.blocks.add(other.id);
          groups.blocks.push(item);
        }
      }
    }
    stmt.free();
    return groups;
  }

  function loadActivities(issueId) {
    const stmt = db.prepare(
      "SELECT id, kind, actor_name AS actorName, field, before_value AS before, after_value AS after, created_at AS createdAt FROM activities WHERE issue_id = ? ORDER BY created_at ASC",
    );
    stmt.bind([issueId]);
    const items = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      items.push({
        id: row.id,
        kind: row.kind,
        actorName: row.actorName,
        field: row.field,
        before: row.before,
        after: row.after,
        createdAt: row.createdAt,
      });
    }
    stmt.free();
    return items;
  }

  function loadComments(issueId) {
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
        attachments: parseAttachments(attachmentsJson),
      });
    }
    stmt.free();
    return items;
  }

  function listIssues() {
    const result = db.exec("SELECT * FROM issues ORDER BY updated_at DESC");
    if (!result.length) return [];
    const cols = result[0].columns;
    const issues = result[0].values.map((values) => {
      /** @type {Record<string, any>} */
      const row = {};
      cols.forEach((col, index) => {
        row[col] = values[index];
      });
      const issue = mapIssue(row);
      issue.activities = loadActivities(issue.id);
      issue.comments = loadComments(issue.id);
      issue.relations = loadRelations(issue.id);
      return issue;
    });
    return attachIssueHierarchy(issues);
  }

  function getIssue(idOrIdentifier) {
    const key = String(idOrIdentifier || "");
    const lower = key.toLowerCase();
    return (
      listIssues().find(
        (item) => item.id === key || String(item.identifier).toLowerCase() === lower,
      ) || null
    );
  }

  function getSnapshot() {
    return {
      dbPath,
      projects: listProjects(),
      tasks: listIssues(),
    };
  }

  function maxIssueNumberInProject(projectId) {
    const stmt = db.prepare("SELECT identifier FROM issues WHERE project_id = ?");
    stmt.bind([projectId]);
    let max = 0;
    while (stmt.step()) {
      const identifier = String(stmt.getAsObject().identifier || "");
      const match = identifier.match(/(\d+)\s*$/);
      if (match) max = Math.max(max, Number(match[1]) || 0);
    }
    stmt.free();
    return max;
  }

  function maxIssueNumberGlobal() {
    const rows = db.exec("SELECT identifier FROM issues");
    if (!rows.length) return 0;
    let max = 0;
    for (const [identifier] of rows[0].values) {
      const match = String(identifier || "").match(/(\d+)\s*$/);
      if (match) max = Math.max(max, Number(match[1]) || 0);
    }
    return max;
  }

  function nextUnassignedIdentifier() {
    const prefix = String(metaGet("unassignedKeyPrefix") || "OPEN").trim() || "OPEN";
    const baseline = Math.max(Number(metaGet("unassignedSeq") || 0), maxIssueNumberGlobal());
    const next = baseline + 1;
    metaSet("unassignedSeq", String(next));
    return `${prefix}-${next}`;
  }

  function nextIdentifier(projectId) {
    if (!projectId) return nextUnassignedIdentifier();
    const stmt = db.prepare("SELECT key_prefix AS keyPrefix, seq FROM projects WHERE id = ?");
    stmt.bind([projectId]);
    if (!stmt.step()) {
      stmt.free();
      throw new Error(`项目不存在: ${projectId}`);
    }
    const { keyPrefix, seq } = stmt.getAsObject();
    stmt.free();
    // 前缀被改过时 seq 可能落后于历史议题编号，取项目内最大编号续增
    const baseline = Math.max(Number(seq) || 0, maxIssueNumberInProject(projectId));
    const next = baseline + 1;
    db.run("UPDATE projects SET seq = ? WHERE id = ?", [next, projectId]);
    return `${keyPrefix}-${next}`;
  }

  /**
   * @param {unknown} inputProjectId
   * @returns {string | null}
   */
  function resolveCreateProjectId(inputProjectId) {
    // 显式不关联：null / "" / "__none__"
    if (inputProjectId === null || inputProjectId === undefined) return null;
    const requested = String(inputProjectId).trim();
    if (!requested || requested === "__none__" || requested === "none") return null;
    if (getProject(requested)) return requested;
    throw new Error(`项目不存在: ${requested}`);
  }

  function createIssue(input = {}) {
    const projectId = Object.prototype.hasOwnProperty.call(input, "projectId")
      ? resolveCreateProjectId(input.projectId)
      : listProjects()[0]?.id || null;
    const project = projectId ? getProject(projectId) : null;
    const now = new Date().toISOString();
    const id = input.id || `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    let parentIssueId = input.parentIssueId ? String(input.parentIssueId) : null;
    if (parentIssueId) {
      const parent = getIssue(parentIssueId);
      if (!parent) throw new Error(`父议题不存在: ${parentIssueId}`);
      parentIssueId = parent.id;
    }
    const inheritedWorktree =
      input.worktreePath !== undefined
        ? input.worktreePath || null
        : serializeFoldersToWorktree(project?.folders || []);
    const issue = {
      id,
      projectId,
      identifier: input.identifier || nextIdentifier(projectId),
      title: input.title || "新建议题",
      description: input.description || "",
      status: input.status || "todo",
      priority: input.priority || "none",
      labels: input.labels || [],
      assignee: input.assignee || "webhua yang",
      assigneeMe: input.assigneeMe !== false,
      startDate: input.startDate || null,
      dueDate: input.dueDate || null,
      processing: (input.status || "todo") === "in_progress",
      threadId: input.threadId || null,
      gitBranch: input.gitBranch || null,
      worktreePath: inheritedWorktree,
      parentIssueId,
      creatorName: input.creatorName || "webhua yang",
      attachments: parseAttachments(input.attachments || []),
      outputs: parseOutputs(input.outputs || []),
      createdAt: now,
      updatedAt: now,
      activities: [],
      comments: [],
    };
    insertIssueRow(issue);
    persist();
    return getIssue(id);
  }

  function addActivity(issueId, activity) {
    const current = getIssue(issueId);
    if (!current) throw new Error(`议题不存在: ${issueId}`);
    db.run(
      `INSERT INTO activities (id, issue_id, kind, actor_name, field, before_value, after_value, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        activity.id,
        current.id,
        activity.kind || "change",
        activity.actorName || "webhua yang",
        activity.field || null,
        activity.before ?? null,
        activity.after ?? null,
        activity.createdAt || new Date().toISOString(),
      ],
    );
    persist();
  }

  function updateIssue(id, patch = {}) {
    const current = getIssue(id);
    if (!current) throw new Error(`议题不存在: ${id}`);
    const issueId = current.id;

    const nextProjectId =
      patch.projectId !== undefined
        ? patch.projectId
          ? String(patch.projectId).trim() || null
          : null
        : current.projectId || null;
    if (nextProjectId && !getProject(nextProjectId)) {
      throw new Error(`项目不存在: ${nextProjectId}`);
    }

    const next = {
      ...current,
      ...patch,
      id: issueId,
      projectId: nextProjectId,
      identifier: current.identifier,
      labels: patch.labels !== undefined ? patch.labels : current.labels,
      attachments:
        patch.attachments !== undefined
          ? parseAttachments(patch.attachments)
          : current.attachments || [],
      outputs:
        patch.outputs !== undefined ? parseOutputs(patch.outputs) : current.outputs || [],
      updatedAt: new Date().toISOString(),
    };

    // 切换项目关联：上下文为空，或仍等于旧项目文件夹 → 自动挂载新项目文件夹
    // 清除关联时不改动开发上下文
    if (
      patch.projectId !== undefined &&
      nextProjectId &&
      nextProjectId !== (current.projectId || null) &&
      patch.worktreePath === undefined
    ) {
      const oldProject = current.projectId ? getProject(current.projectId) : null;
      const newProject = getProject(nextProjectId);
      const newFolders = newProject?.folders || [];
      const currentKey = normalizeFolderKey(current.worktreePath);
      const oldKey = normalizeFolderKey(oldProject?.folders || []);
      const shouldSync = !currentKey || currentKey === oldKey;
      if (shouldSync && newFolders.length) {
        next.worktreePath = serializeFoldersToWorktree(newFolders);
      }
    }

    if (patch.parentIssueId !== undefined) {
      let parentId = patch.parentIssueId ? String(patch.parentIssueId) : null;
      if (parentId) {
        if (parentId === issueId) throw new Error("不能将议题设为自己的父议题");
        const parent = getIssue(parentId);
        if (!parent) throw new Error(`父议题不存在: ${parentId}`);
        parentId = parent.id;
        // Prevent cycles: walk ancestors of the new parent.
        let cursor = parent;
        const guard = new Set([issueId]);
        while (cursor?.parentIssueId) {
          if (guard.has(cursor.parentIssueId)) {
            throw new Error("不能形成循环的父子关系");
          }
          guard.add(cursor.parentIssueId);
          cursor = getIssue(cursor.parentIssueId);
        }
      }
      next.parentIssueId = parentId;
    }

    if (patch.status !== undefined) {
      next.processing = patch.status === "in_progress";
    } else if (patch.processing !== undefined) {
      next.processing = Boolean(patch.processing);
    }

    if (patch.status && patch.status !== current.status) {
      addActivity(issueId, {
        id: `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        kind: "change",
        actorName: "webhua yang",
        field: "status",
        before: current.status,
        after: patch.status,
        createdAt: next.updatedAt,
      });
    }

    db.run(
      `UPDATE issues SET
        project_id = ?, title = ?, description = ?, status = ?, priority = ?, labels_json = ?,
        assignee = ?, assignee_me = ?, start_date = ?, due_date = ?, processing = ?, thread_id = ?,
        git_branch = ?, worktree_path = ?, parent_issue_id = ?, creator_name = ?, attachments_json = ?,
        outputs_json = ?, updated_at = ?
       WHERE id = ?`,
      [
        next.projectId,
        next.title,
        next.description || "",
        next.status,
        next.priority || "none",
        JSON.stringify(next.labels || []),
        next.assignee || null,
        next.assigneeMe ? 1 : 0,
        next.startDate || null,
        next.dueDate || null,
        next.processing ? 1 : 0,
        next.threadId || null,
        next.gitBranch || null,
        next.worktreePath || null,
        next.parentIssueId || null,
        next.creatorName || null,
        JSON.stringify(parseAttachments(next.attachments || [])),
        JSON.stringify(parseOutputs(next.outputs || [])),
        next.updatedAt,
        issueId,
      ],
    );
    persist();
    return getIssue(issueId);
  }

  function duplicateIssue(id) {
    const current = getIssue(id);
    if (!current) throw new Error(`议题不存在: ${id}`);
    return createIssue({
      projectId: current.projectId,
      title: `${current.title}（副本）`,
      description: current.description,
      status: current.status,
      priority: current.priority,
      labels: [...(current.labels || [])],
      assignee: current.assignee,
      assigneeMe: current.assigneeMe,
      startDate: current.startDate,
      dueDate: current.dueDate,
      creatorName: current.creatorName,
    });
  }

  function addComment(issueId, input = {}) {
    const result = addCommentsBatch(issueId, [input]);
    if (!result.added && !result.updated) {
      // 已存在则直接返回当前议题；空正文等错误仍抛出
      const hasAttachments = parseAttachments(input.attachments).length > 0;
      if (!String(input.body || "").trim() && !hasAttachments) throw new Error("评论不能为空");
      return getIssue(issueId);
    }
    return result.issue;
  }

  /**
   * Insert or update a comment by id (used for chat work-report summary).
   * @param {string} issueId
   * @param {{
   *   id: string,
   *   authorName?: string,
   *   authorId?: string,
   *   authorType?: string,
   *   kind?: string,
   *   body: string,
   *   threadId?: string | null,
   *   parentCommentId?: string | null,
   *   createdAt?: string,
   * }} input
   */
  function upsertComment(issueId, input = {}) {
    const current = getIssue(issueId);
    if (!current) throw new Error(`议题不存在: ${issueId}`);
    const id = current.id;
    const commentId = String(input.id || "").trim();
    const body = String(input.body || "").trim();
    if (!commentId) throw new Error("评论 id 不能为空");
    if (!body) throw new Error("评论不能为空");
    const now = new Date().toISOString();
    const existing = (current.comments || []).find((item) => item.id === commentId);
    if (existing) {
      const kind = resolveCommentKind({
        id: commentId,
        kind: input.kind !== undefined ? input.kind : existing.kind,
        authorType: input.authorType || existing.authorType || "user",
      });
      db.run(
        `UPDATE comments
         SET author_name = ?, author_id = ?, author_type = ?, kind = ?, body = ?, thread_id = ?, parent_comment_id = ?
         WHERE id = ? AND issue_id = ?`,
        [
          input.authorName || existing.authorName || "webhua yang",
          input.authorId || existing.authorId || "me",
          input.authorType || existing.authorType || "user",
          kind,
          body,
          input.threadId !== undefined ? input.threadId : existing.threadId,
          input.parentCommentId !== undefined ? input.parentCommentId : existing.parentCommentId,
          commentId,
          id,
        ],
      );
      db.run("UPDATE issues SET updated_at = ? WHERE id = ?", [now, id]);
      persist();
      return { updated: true, added: false, issue: getIssue(id) };
    }
    return addCommentsBatch(issueId, [input]);
  }

  /**
   * @param {string} issueId
   * @param {Array<{
   *   id?: string,
   *   authorName?: string,
   *   authorId?: string,
   *   authorType?: string,
   *   kind?: string,
   *   body: string,
   *   threadId?: string | null,
   *   parentCommentId?: string | null,
   *   createdAt?: string,
   *   attachments?: Array<{ id?: string, mime?: string, name?: string, relPath: string }>,
   * }>} items
   */
  function addCommentsBatch(issueId, items = []) {
    const current = getIssue(issueId);
    if (!current) throw new Error(`议题不存在: ${issueId}`);
    const id = current.id;
    /** @type {Map<string, any>} */
    const existingById = new Map((current.comments || []).map((item) => [item.id, item]));
    const now = new Date().toISOString();
    let added = 0;
    let updated = 0;

    for (const input of items) {
      const body = String(input.body || "").trim();
      const attachments = parseAttachments(input.attachments);
      if (!body && !attachments.length) continue;
      const commentId = input.id || `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const parentCommentId = input.parentCommentId ? String(input.parentCommentId) : null;
      const kind = resolveCommentKind({
        id: commentId,
        kind: input.kind,
        authorType: input.authorType || "user",
      });
      const existing = existingById.get(commentId);
      if (existing) {
        const nextParent = parentCommentId || existing.parentCommentId || null;
        const nextBody = body || existing.body;
        const nextKind = resolveCommentKind({
          id: commentId,
          kind: input.kind !== undefined ? input.kind : existing.kind,
          authorType: input.authorType || existing.authorType || "user",
        });
        const nextAttachments =
          input.attachments !== undefined ? attachments : parseAttachments(existing.attachments);
        const prevAttachments = parseAttachments(existing.attachments);
        if (
          nextParent !== (existing.parentCommentId || null) ||
          nextBody !== existing.body ||
          nextKind !== (existing.kind || null) ||
          JSON.stringify(nextAttachments) !== JSON.stringify(prevAttachments)
        ) {
          db.run(
            `UPDATE comments SET body = ?, parent_comment_id = ?, kind = ?, thread_id = COALESCE(?, thread_id),
             attachments_json = ?
             WHERE id = ? AND issue_id = ?`,
            [
              nextBody,
              nextParent,
              nextKind,
              input.threadId || null,
              JSON.stringify(nextAttachments),
              commentId,
              id,
            ],
          );
          updated += 1;
        }
        continue;
      }
      if (parentCommentId && !existingById.has(parentCommentId) && !(current.comments || []).some((item) => item.id === parentCommentId)) {
        continue;
      }
      db.run(
        `INSERT INTO comments (id, issue_id, author_name, author_id, author_type, kind, body, thread_id, parent_comment_id, fork_thread_ids_json, attachments_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          commentId,
          id,
          input.authorName || "webhua yang",
          input.authorId || "me",
          input.authorType || "user",
          kind,
          body,
          input.threadId || null,
          parentCommentId,
          JSON.stringify(parseForkThreadIds(input.forkThreadIds || [])),
          JSON.stringify(attachments),
          input.createdAt || now,
        ],
      );
      existingById.set(commentId, { id: commentId, kind, attachments });
      added += 1;
    }

    if (added || updated) {
      db.run("UPDATE issues SET updated_at = ? WHERE id = ?", [now, id]);
      persist();
    }
    return { added, updated, issue: getIssue(id) };
  }

  /**
   * @param {string} issueId
   * @param {{ type: "blocked_by" | "blocks" | "related", targetIssueId: string }} input
   */
  function addRelation(issueId, input = {}) {
    const current = getIssue(issueId);
    if (!current) throw new Error(`议题不存在: ${issueId}`);
    const type = String(input.type || "").trim();
    if (!["blocked_by", "blocks", "related"].includes(type)) {
      throw new Error("关联类型无效");
    }
    const target = getIssue(input.targetIssueId);
    if (!target) throw new Error("目标议题不存在");
    if (target.id === current.id) throw new Error("不能关联自己");

    // Prevent duplicate / reverse duplicate for the same logical edge.
    const existingStmt = db.prepare(
      `SELECT id, from_issue_id AS fromIssueId, to_issue_id AS toIssueId, type
       FROM issue_relations
       WHERE (from_issue_id = ? AND to_issue_id = ?)
          OR (from_issue_id = ? AND to_issue_id = ?)`,
    );
    existingStmt.bind([current.id, target.id, target.id, current.id]);
    while (existingStmt.step()) {
      const row = existingStmt.getAsObject();
      const fromId = row.fromIssueId;
      const toId = row.toIssueId;
      const rowType = row.type;
      if (type === "related" && rowType === "related") {
        existingStmt.free();
        throw new Error("已存在相关关联");
      }
      if (type !== "related" && (rowType === "blocks" || rowType === "blocked_by")) {
        const same =
          (type === "blocks" &&
            ((rowType === "blocks" && fromId === current.id) ||
              (rowType === "blocked_by" && toId === current.id))) ||
          (type === "blocked_by" &&
            ((rowType === "blocked_by" && fromId === current.id) ||
              (rowType === "blocks" && toId === current.id)));
        if (same) {
          existingStmt.free();
          throw new Error("已存在该阻塞关联");
        }
      }
    }
    existingStmt.free();

    const now = new Date().toISOString();
    const relationId = `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    db.run(
      `INSERT INTO issue_relations (id, from_issue_id, to_issue_id, type, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [relationId, current.id, target.id, type, now],
    );
    db.run("UPDATE issues SET updated_at = ? WHERE id = ?", [now, current.id]);
    persist();
    return getIssue(current.id);
  }

  /**
   * @param {string} issueId
   * @param {string} relationId
   */
  function removeRelation(issueId, relationId) {
    const current = getIssue(issueId);
    if (!current) throw new Error(`议题不存在: ${issueId}`);
    const id = String(relationId || "").trim();
    if (!id) throw new Error("缺少关联 ID");

    const stmt = db.prepare(
      "SELECT id, from_issue_id AS fromIssueId, to_issue_id AS toIssueId FROM issue_relations WHERE id = ?",
    );
    stmt.bind([id]);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    if (!row) throw new Error("关联不存在");
    if (row.fromIssueId !== current.id && row.toIssueId !== current.id) {
      throw new Error("关联不属于当前议题");
    }

    db.run("DELETE FROM issue_relations WHERE id = ?", [id]);
    const now = new Date().toISOString();
    db.run("UPDATE issues SET updated_at = ? WHERE id = ?", [now, current.id]);
    persist();
    return getIssue(current.id);
  }

  /**
   * Append a forked composer threadId onto an agent_report comment.
   * @param {string} issueId
   * @param {string} commentId
   * @param {{ threadId: string, bubbleId?: string | null, sourceThreadId?: string | null, createdAt?: string }} fork
   */
  function addCommentFork(issueId, commentId, fork = {}) {
    const current = getIssue(issueId);
    if (!current) throw new Error(`议题不存在: ${issueId}`);
    const id = current.id;
    const cid = String(commentId || "").trim();
    const threadId = String(fork.threadId || "").trim();
    if (!cid) throw new Error("评论 id 不能为空");
    if (!threadId) throw new Error("fork threadId 不能为空");
    const existing = (current.comments || []).find((item) => item.id === cid);
    if (!existing) throw new Error(`评论不存在: ${cid}`);
    const forks = parseForkThreadIds(existing.forkThreadIds);
    if (forks.some((item) => item.threadId === threadId)) {
      return { added: false, issue: current };
    }
    forks.push({
      threadId,
      createdAt: fork.createdAt || new Date().toISOString(),
      bubbleId: fork.bubbleId ? String(fork.bubbleId) : null,
      sourceThreadId: fork.sourceThreadId ? String(fork.sourceThreadId) : null,
    });
    db.run(`UPDATE comments SET fork_thread_ids_json = ? WHERE id = ? AND issue_id = ?`, [
      JSON.stringify(forks),
      cid,
      id,
    ]);
    db.run("UPDATE issues SET updated_at = ? WHERE id = ?", [new Date().toISOString(), id]);
    persist();
    return { added: true, issue: getIssue(id) };
  }

  return {
    dbPath,
    getSnapshot,
    getIssue,
    listProjects,
    getProject,
    createProject,
    updateProject,
    deleteProject,
    createIssue,
    updateIssue,
    duplicateIssue,
    addComment,
    addCommentsBatch,
    upsertComment,
    addCommentFork,
    addActivity,
    addRelation,
    removeRelation,
    persist,
    reloadFromDisk,
    shouldIgnoreExternalChange() {
      return suppressPersistNotify;
    },
    diskMatchesKnownState,
    close() {
      persist();
      db.close();
    },
  };
}

module.exports = { createStore, parseAttachments, parseFolders, parseOutputs };
