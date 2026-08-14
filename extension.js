const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const vscode = require("vscode");
const { createStore } = require("./storage");
const { installRuntime } = require("./skill-install");
const {
  findGitRoot,
  findRepoRoot,
  suggestBranchName,
  suggestWorktreePath,
  listWorktrees,
  listLocalBranches,
  currentBranch,
  createWorktree,
  cloneRepo,
  listRemoteBranches,
  shortWorktreeLabel,
  worktreeFolderName,
  parseWorktreePaths,
  serializeWorktreePaths,
} = require("./git-worktree");
const { syncIssueComposerChat, resolveComposerIdForIssue, composerHasTranscript } = require("./composer-sync");
const { readClipboardImage } = require("./clipboard-image");
const {
  getSyncConfig,
  saveSyncConfig,
  pushDbToGit,
  pullDbFromGit,
  maybeDailyPush,
} = require("./db-sync");
const {
  inspectRepos,
  checkoutBranch,
  createAndCheckoutBranch,
  commitSelected,
} = require("./git-commit");
const execFileAsync = promisify(execFile);
const MCP_SERVER_NAME = "cursor-taskboard";

/** @type {vscode.WebviewPanel | undefined} */
let panel;

/** @type {vscode.WebviewPanel | undefined} */
let outputBookPanel;

/** @type {vscode.WebviewView | undefined} */
let sidebarView;

/** @type {vscode.Uri | undefined} */
let extensionUri;

/** @type {vscode.Uri | undefined} */
let globalStorageUri;

/** @type {vscode.Uri | undefined} */
let attachmentsRootUri;

/** @type {{ type: string, taskId?: string, task?: object, view?: string, bookId?: string, title?: string } | null} */
let pendingPanelMessage = null;

/** @type {boolean} */
let panelReady = false;

/** @type {{ type: string, taskId?: string, bookId?: string, title?: string, view?: string } | null} */
let pendingOutputBookMessage = null;

/** @type {boolean} */
let outputBookPanelReady = false;

/** @type {Awaited<ReturnType<typeof createStore>> | null} */
let store = null;

/** @type {Promise<Awaited<ReturnType<typeof createStore>>> | null} */
let storePromise = null;

/** @type {{ taskctl?: string, skillPath?: string } | null} */
let runtimeConfig = null;

/** @type {NodeJS.Timeout | null} */
let chatSyncTimer = null;

/** @type {string | null} */
let chatSyncIssueId = null;

/** @type {NodeJS.Timeout | null} */
let dbSyncTimer = null;

/** @type {vscode.ExtensionContext | undefined} */
let extensionContext;

const LOCALE_STATE_KEY = "cursorTaskboard.locale";

/**
 * @param {string | undefined | null} lang
 * @returns {"zh" | "en"}
 */
function detectUiLocale(lang) {
  const value = String(lang || "").toLowerCase();
  return value.startsWith("zh") ? "zh" : "en";
}

/**
 * @returns {"zh" | "en"}
 */
function getUiLocale() {
  const stored = extensionContext?.globalState.get(LOCALE_STATE_KEY);
  if (stored === "zh" || stored === "en") return stored;
  return detectUiLocale(vscode.env.language);
}

/**
 * @param {"zh" | "en"} locale
 */
async function setUiLocale(locale) {
  const next = locale === "en" ? "en" : "zh";
  await extensionContext?.globalState.update(LOCALE_STATE_KEY, next);
  const payload = { type: "setLocale", locale: next };
  if (sidebarView) void sidebarView.webview.postMessage(payload);
  if (panel) void panel.webview.postMessage(payload);
  if (outputBookPanel) void outputBookPanel.webview.postMessage(payload);
}

async function pickUiLocale() {
  const current = getUiLocale();
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "中文",
        description: current === "zh" ? "$(check)" : "",
        locale: /** @type {"zh"} */ ("zh"),
      },
      {
        label: "English",
        description: current === "en" ? "$(check)" : "",
        locale: /** @type {"en"} */ ("en"),
      },
    ],
    {
      title: current === "zh" ? "界面语言" : "UI language",
      placeHolder: current === "zh" ? "选择语言" : "Choose language",
    },
  );
  if (!picked?.locale || picked.locale === current) return;
  await setUiLocale(picked.locale);
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
  extensionContext = context;
  extensionUri = context.extensionUri;
  globalStorageUri = context.globalStorageUri;
  attachmentsRootUri = vscode.Uri.joinPath(context.globalStorageUri, "attachments");
  fs.mkdirSync(attachmentsRootUri.fsPath, { recursive: true });
  storePromise = createStore(context.globalStorageUri);
  store = await storePromise;

  try {
    runtimeConfig = installRuntime(context, store.dbPath, {
      attachmentsRoot: attachmentsRootUri.fsPath,
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    void vscode.window.showWarningMessage(`Taskboard skill 安装失败: ${text}`);
  }

  await registerCursorIntegrations(context, store.dbPath);
  startDbSyncScheduler();

  const provider = new TaskboardViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("cursorTaskboard.main", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("cursorTaskboard.open", () => {
      openEditorPanel({ type: "showView", view: "issues" });
    }),
    vscode.commands.registerCommand("cursorTaskboard.openQuery", () => {
      openEditorPanel({ type: "showView", view: "query" });
    }),
    vscode.commands.registerCommand("cursorTaskboard.openSettings", () => {
      openEditorPanel({ type: "showView", view: "settings" });
    }),
    vscode.commands.registerCommand("cursorTaskboard.toggleLocale", () => {
      void pickUiLocale();
    }),
    watchDatabaseFile(store.dbPath),
    {
      dispose() {
        if (chatSyncTimer) {
          clearInterval(chatSyncTimer);
          chatSyncTimer = null;
        }
        if (dbSyncTimer) {
          clearInterval(dbSyncTimer);
          dbSyncTimer = null;
        }
        store?.close();
        store = null;
      },
    },
  );
}

/** Poll hourly; push at most once per day when schedule is enabled. */
function startDbSyncScheduler() {
  if (dbSyncTimer) {
    clearInterval(dbSyncTimer);
    dbSyncTimer = null;
  }
  const tick = () => {
    void (async () => {
      try {
        const db = await ensureStore();
        const result = await maybeDailyPush(db);
        if (result.ran && result.ok !== false) {
          void vscode.window.setStatusBarMessage(
            `Taskboard 已自动备份到 Git${result.skipped ? "（无变更）" : ""}`,
            5000,
          );
        } else if (result.ran && result.ok === false) {
          void vscode.window.showWarningMessage(`Taskboard 每日 Git 备份失败: ${result.error || "未知错误"}`);
        }
      } catch {
        // ignore scheduler errors
      }
    })();
  };
  // 启动后稍晚检查一次，之后每小时
  setTimeout(tick, 20_000);
  dbSyncTimer = setInterval(tick, 60 * 60 * 1000);
}

/**
 * Sync bound Cursor chat bubbles into the issue activity/comments feed.
 * @param {string} issueId
 * @param {{ quiet?: boolean }} [options]
 */
async function syncChatForIssue(issueId, options = {}) {
  const id = String(issueId || "").trim();
  if (!id) return { ok: false, added: 0 };
  const db = await ensureStore();
  try {
    const result = await syncIssueComposerChat(db, id);
    if (result.added > 0) {
      await pushSnapshot();
      if (!options.quiet) {
        void vscode.window.showInformationMessage(`已同步 ${result.added} 条对话到活动列表`);
      }
    }
    return result;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!options.quiet) {
      void vscode.window.showWarningMessage(`同步对话失败: ${text}`);
    }
    return { ok: false, added: 0, error: text };
  }
}

/**
 * Keep syncing the issue currently open in the detail view.
 * @param {string | null | undefined} issueId
 */
function watchChatSyncForIssue(issueId) {
  const id = String(issueId || "").trim() || null;
  chatSyncIssueId = id;
  if (chatSyncTimer) {
    clearInterval(chatSyncTimer);
    chatSyncTimer = null;
  }
  if (!id) return;
  void syncChatForIssue(id, { quiet: true });
  chatSyncTimer = setInterval(() => {
    if (!chatSyncIssueId) return;
    void syncChatForIssue(chatSyncIssueId, { quiet: true });
  }, 12000);
}

/**
 * @param {Record<string, string>} extra
 * @returns {Record<string, string>}
 */
function mcpStdioEnv(extra) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  Object.assign(env, extra);
  return env;
}

/**
 * 远程 SSH/WSL：Shared MCP 在本机 spawn，stdio 命令若是远端路径会被 Canceled。
 * 在扩展宿主起 HTTP MCP，再用 asExternalUri 转给本机客户端。
 * @param {any} cursorApi
 * @param {vscode.ExtensionContext} context
 * @returns {Promise<boolean>}
 */
async function registerMcpHttp(cursorApi, context) {
  const { startMcpHttpServer } = require("./mcp-http");
  let httpHandle;
  try {
    httpHandle = await startMcpHttpServer();
  } catch (error) {
    syncLog("mcp-http-listen-failed", { error: String(error) });
    return false;
  }
  const localUri = vscode.Uri.parse(
    `http://127.0.0.1:${httpHandle.port}/mcp/${httpHandle.token}`,
  );
  let registerUrl = localUri.toString();
  try {
    registerUrl = (await vscode.env.asExternalUri(localUri)).toString();
  } catch (error) {
    syncLog("mcp-asExternalUri-failed", { error: String(error) });
  }
  try {
    cursorApi.mcp.registerServer({
      name: MCP_SERVER_NAME,
      server: { url: registerUrl },
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    syncLog("mcp-http-register-failed", { error: text });
    await httpHandle.close();
    return false;
  }
  syncLog("mcp-registered-http", {
    remote: isRemoteSession(),
    remoteName: vscode.env.remoteName || null,
    port: httpHandle.port,
  });
  context.subscriptions.push({
    dispose() {
      try {
        cursorApi.mcp.unregisterServer?.(MCP_SERVER_NAME);
      } catch {
        // ignore
      }
      void httpHandle.close();
    },
  });
  return true;
}

/**
 * 本地 stdio：用扩展宿主同源运行时，避免精简 PATH 找不到 node。
 * 不要在 register 前 unregister，否则 Cursor createClient 会被 Canceled。
 * @param {any} cursorApi
 * @param {vscode.ExtensionContext} context
 * @param {string} dbPath
 * @returns {boolean}
 */
function registerMcpStdio(cursorApi, context, dbPath) {
  const mcpServerJs = path.join(context.extensionPath, "mcp-server.js");
  const nodeCommand = process.execPath || "node";
  try {
    cursorApi.mcp.registerServer({
      name: MCP_SERVER_NAME,
      server: {
        command: nodeCommand,
        args: [mcpServerJs],
        env: mcpStdioEnv({
          ELECTRON_RUN_AS_NODE: "1",
          CURSOR_TASKBOARD_DB: dbPath,
        }),
      },
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    void vscode.window.showWarningMessage(`Taskboard MCP 注册失败: ${text}`);
    return false;
  }
  syncLog("mcp-registered-stdio", { command: nodeCommand });
  context.subscriptions.push({
    dispose() {
      try {
        cursorApi.mcp.unregisterServer?.(MCP_SERVER_NAME);
      } catch {
        // ignore
      }
    },
  });
  return true;
}

/**
 * Register MCP tools so Agent talks to the extension, not shell CLI.
 * @param {vscode.ExtensionContext} context
 * @param {string} dbPath
 */
async function registerCursorIntegrations(context, dbPath) {
  const cursorApi = /** @type {any} */ (vscode).cursor;
  if (!cursorApi) {
    void vscode.window.showWarningMessage(
      "当前 Cursor 无 vscode.cursor API，Taskboard MCP/skill 注册跳过",
    );
    return;
  }
  if (!cursorApi.mcp?.registerServer) return;

  if (isRemoteSession()) {
    const ok = await registerMcpHttp(cursorApi, context);
    if (ok) return;
    void vscode.window.showWarningMessage(
      "远程 MCP HTTP 注册失败，已回退 stdio；远程窗口上仍可能出现 Canceled",
    );
  }

  registerMcpStdio(cursorApi, context, dbPath);
}

/**
 * @param {string} dbPath
 */
function watchDatabaseFile(dbPath) {
  let timer = null;
  const watcher = fs.watch(dbPath, () => {
    if (store?.shouldIgnoreExternalChange()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void (async () => {
        try {
          const db = await ensureStore();
          if (db.shouldIgnoreExternalChange()) return;
          // Our own persist() already left these exact bytes on disk.
          if (db.diskMatchesKnownState?.()) return;
          db.reloadFromDisk();
          await pushSnapshot();
        } catch {
          // 写入过程中可能短暂不可读，忽略即可
        }
      })();
    }, 200);
  });
  return {
    dispose() {
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}

async function ensureStore() {
  if (store) return store;
  if (!storePromise) throw new Error("Taskboard store 未初始化");
  store = await storePromise;
  return store;
}

/**
 * @param {any} message
 * @param {vscode.Webview | undefined} [except]
 */
function broadcast(message, except) {
  if (sidebarView && sidebarView.webview !== except) {
    void sidebarView.webview.postMessage(message);
  }
  if (panel && panel.webview !== except) {
    void panel.webview.postMessage(message);
  }
}

/**
 * @param {any} snapshot
 * @param {vscode.Webview} webview
 */
function enrichSnapshotForWebview(snapshot, webview) {
  const locale = getUiLocale();
  if (!attachmentsRootUri) return { ...snapshot, locale };
  const tasks = (snapshot.tasks || []).map((task) => enrichIssueForWebview(task, webview));
  return { ...snapshot, tasks, locale };
}

/**
 * @param {any[]} comments
 * @param {vscode.Webview} webview
 */
function enrichCommentsForWebview(comments, webview) {
  if (!attachmentsRootUri) return comments;
  return comments.map((comment) => {
    const attachments = Array.isArray(comment.attachments) ? comment.attachments : [];
    if (!attachments.length) return comment;
    return {
      ...comment,
      attachments: enrichAttachmentsForWebview(attachments, webview),
    };
  });
}

/**
 * @param {Array<{ id?: string, mime?: string, name?: string, relPath?: string, url?: string }>} attachments
 * @param {vscode.Webview} webview
 */
function enrichAttachmentsForWebview(attachments, webview) {
  if (!attachmentsRootUri || !Array.isArray(attachments) || !attachments.length) return attachments || [];
  return attachments.map((item) => {
    const relPath = String(item?.relPath || "").trim();
    if (!relPath || relPath.includes("..")) return item;
    const fileUri = vscode.Uri.joinPath(attachmentsRootUri, ...relPath.split("/"));
    return {
      ...item,
      url: webview.asWebviewUri(fileUri).toString(),
    };
  });
}

/**
 * @param {any} issue
 * @param {vscode.Webview} webview
 */
function enrichIssueForWebview(issue, webview) {
  if (!issue) return issue;
  return {
    ...issue,
    attachments: enrichAttachmentsForWebview(issue.attachments || [], webview),
    comments: enrichCommentsForWebview(issue.comments || [], webview),
  };
}

/**
 * @param {string} filePath
 * @param {string} fallback
 */
function chapterTitleFromMarkdown(filePath, fallback) {
  try {
    const text = fs.readFileSync(filePath, "utf8").slice(0, 4000);
    const match = text.match(/^#\s+(.+)$/m);
    if (match?.[1]) return match[1].trim();
  } catch {
    // ignore
  }
  return fallback;
}

/**
 * 扫描目录书：收集 md 章节（深度 ≤3）
 * @param {string} rootPath
 * @param {{ id?: string, createdAt?: string }} [options]
 */
function scanOutputBook(rootPath, options = {}) {
  const root = path.resolve(String(rootPath || "").trim());
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`目录不存在: ${rootPath || "(empty)"}`);
  }
  /** @type {Array<{ path: string, relPath: string, title: string }>} */
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent?.name || ent.name.startsWith(".")) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!ent.isFile() || !/\.md$/i.test(ent.name)) continue;
      const relPath = path.relative(root, full).split(path.sep).join("/");
      const title = ent.name.replace(/\.md$/i, "");
      files.push({ path: full, relPath, title });
    }
  };
  walk(root, 0);
  const rank = (rel) => {
    const base = path.basename(rel).toLowerCase();
    if (base === "readme.md") return 0;
    if (base === "summary.md") return 1;
    if (base === "index.md") return 2;
    return 10;
  };
  files.sort((a, b) => {
    const ra = rank(a.relPath);
    const rb = rank(b.relPath);
    if (ra !== rb) return ra - rb;
    return a.relPath.localeCompare(b.relPath, "zh");
  });
  const chapters = files.map((file, index) => ({
    id: `ch-${index}-${Buffer.from(file.relPath).toString("base64url").slice(0, 16)}`,
    title: chapterTitleFromMarkdown(file.path, file.title),
    path: file.path,
    relPath: file.relPath,
  }));
  return {
    id: String(options.id || `out-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`),
    title: String(options.title || path.basename(root) || "产出书"),
    rootPath: root,
    chapters,
    createdAt: String(options.createdAt || new Date().toISOString()),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * @param {any} issue
 * @param {any} book
 */
function upsertIssueOutputBook(issue, book) {
  const current = Array.isArray(issue?.outputs) ? issue.outputs : [];
  const root = path.resolve(book.rootPath);
  const existing = current.find((item) => path.resolve(String(item.rootPath || "")) === root);
  if (existing) {
    const nextBook = {
      ...book,
      id: existing.id,
      createdAt: existing.createdAt || book.createdAt,
      title: book.title || existing.title,
    };
    return {
      book: nextBook,
      outputs: current.map((item) => (item.id === existing.id ? nextBook : item)),
    };
  }
  return { book, outputs: [...current, book] };
}

/**
 * @param {{ identifier?: string, title?: string }} issue
 * @param {string} bookRoot
 */
function buildOutputBookSummaryFollowUp(issue, bookRoot) {
  const id = String(issue?.identifier || "").trim() || "未知议题";
  const title = String(issue?.title || "").trim() || "本议题";
  return [
    `e-taskboard 同步处理 ${id}。请立刻调用 MCP issue_get 拉取该议题、关联项目、开发上下文与评论。`,
    "",
    `用户在任务面板点击了「添加产出书」。请基于项目代码与当前产品能力，总结并产出一本目录书（多章节 Markdown），主题围绕「${title} / 产品功能」。`,
    "",
    "要求：",
    `1. 将书落盘到目录：${bookRoot}`,
    "2. 至少包含 README.md（总目录）以及多章 .md（建议：概览、项目、议题与视图、详情、开发上下文、Git/worktree、产出内容、设置与同步、国际化与自动化、MCP 协作）",
    "3. 内容必须对应仓库里真实已有功能，可直接阅读，避免空话",
    "4. 写完后用 comment_add 说明目录路径与章节列表；状态保持或设为 in_review",
    "5. 用户可在面板「产出内容」点 ↻ 刷新章节后打开阅读",
    "",
    "不要只口头描述，必须创建/更新上述 md 文件。",
  ].join("\n");
}

/**
 * @param {string} filePath
 * @param {string} rootPath
 */
function assertPathInsideRoot(filePath, rootPath) {
  const file = path.resolve(filePath);
  const root = path.resolve(rootPath);
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("章节路径不在产出目录内");
  }
  return file;
}

/**
 * @param {string} mime
 * @param {string} [fileName]
 */
function extensionForAttachment(mime, fileName) {
  const fromName = path.extname(String(fileName || "")).replace(/^\./, "").toLowerCase();
  if (fromName && /^[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  const kind = String(mime || "").toLowerCase();
  if (kind === "image/jpeg" || kind === "image/jpg") return "jpg";
  if (kind === "image/webp") return "webp";
  if (kind === "image/gif") return "gif";
  if (kind === "image/png") return "png";
  if (kind === "application/pdf") return "pdf";
  if (kind === "application/zip") return "zip";
  if (kind === "application/json" || kind === "text/json") return "json";
  if (kind.startsWith("text/")) return "txt";
  return "bin";
}

/**
 * Persist uploaded attachments under globalStorage/attachments.
 * @param {string} issueId
 * @param {string} prefix commentId or "issue"
 * @param {Array<{ mime?: string, name?: string, dataBase64?: string }>} items
 * @param {{ imagesOnly?: boolean }} [options]
 */
function saveAttachments(issueId, prefix, items = [], options = {}) {
  if (!attachmentsRootUri || !Array.isArray(items) || !items.length) return [];
  const imagesOnly = Boolean(options.imagesOnly);
  const maxBytes = 25 * 1024 * 1024;
  const safeIssueId = String(issueId || "").replace(/[^a-zA-Z0-9._-]/g, "_") || "issue";
  const safePrefix = String(prefix || "file").replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
  const dir = path.join(attachmentsRootUri.fsPath, safeIssueId);
  fs.mkdirSync(dir, { recursive: true });
  /** @type {Array<{ id: string, mime: string, name: string, relPath: string }>} */
  const saved = [];
  let index = 0;
  for (const item of items) {
    const mime = String(item?.mime || "application/octet-stream").trim() || "application/octet-stream";
    if (imagesOnly && !mime.startsWith("image/")) continue;
    const raw = String(item?.dataBase64 || "");
    const dataBase64 = raw.replace(/^data:[^;]+;base64,/, "");
    if (!dataBase64) continue;
    let buf;
    try {
      buf = Buffer.from(dataBase64, "base64");
    } catch {
      continue;
    }
    if (!buf.length) continue;
    if (buf.length > maxBytes) {
      throw new Error("单个附件不能超过 25 MB");
    }
    const ext = extensionForAttachment(mime, item?.name);
    const fileName = `${safePrefix}-${index}.${ext}`;
    const relPath = `${safeIssueId}/${fileName}`;
    fs.writeFileSync(path.join(dir, fileName), buf);
    const defaultName = mime.startsWith("image/")
      ? `screenshot-${index + 1}.${ext}`
      : `file-${index + 1}.${ext}`;
    saved.push({
      id: `att-${safePrefix}-${index}-${Date.now().toString(36)}`,
      mime,
      name: String(item?.name || defaultName).trim() || defaultName,
      relPath,
    });
    index += 1;
  }
  return saved;
}

/**
 * Persist pasted/uploaded comment images under globalStorage/attachments.
 * @param {string} issueId
 * @param {string} commentId
 * @param {Array<{ mime?: string, name?: string, dataBase64?: string }>} items
 */
function saveCommentAttachments(issueId, commentId, items = []) {
  return saveAttachments(issueId, commentId, items, { imagesOnly: true });
}

/**
 * @returns {vscode.Uri[]}
 */
function webviewLocalRoots() {
  const roots = [];
  if (extensionUri) {
    roots.push(vscode.Uri.joinPath(extensionUri, "media"));
    roots.push(vscode.Uri.joinPath(extensionUri, "node_modules", "sql.js", "dist"));
  }
  if (attachmentsRootUri) roots.push(attachmentsRootUri);
  return roots;
}

/**
 * @param {vscode.Webview | undefined} [targetWebview]
 * @param {vscode.Webview | undefined} [except]
 */
async function pushSnapshot(targetWebview, except) {
  const db = await ensureStore();
  const snapshot = db.getSnapshot();
  if (targetWebview) {
    void targetWebview.postMessage({
      type: "dataSnapshot",
      ...enrichSnapshotForWebview(snapshot, targetWebview),
    });
    return;
  }
  if (sidebarView && sidebarView.webview !== except) {
    void sidebarView.webview.postMessage({
      type: "dataSnapshot",
      ...enrichSnapshotForWebview(snapshot, sidebarView.webview),
    });
  }
  if (panel && panel.webview !== except) {
    void panel.webview.postMessage({
      type: "dataSnapshot",
      ...enrichSnapshotForWebview(snapshot, panel.webview),
    });
  }
  if (outputBookPanel && outputBookPanel.webview !== except) {
    void outputBookPanel.webview.postMessage({
      type: "dataSnapshot",
      ...enrichSnapshotForWebview(snapshot, outputBookPanel.webview),
    });
  }
}

/**
 * @param {{ type: string, taskId?: string, task?: object, view?: string } | null} [message]
 */
function panelTitleForMessage(message) {
  if (message?.type === "showView" && message.view === "query") return "查询";
  if (message?.type === "showView" && message.view === "projects") return "项目管理";
  if (message?.type === "showView" && message.view === "settings") return "设置";
  if (message?.type === "showView" && message.view === "sync") return "同步 db";
  if (message?.type === "showIssue") return "议题";
  return "Taskboard";
}

function openEditorPanel(message = null) {
  if (!extensionUri) return;

  if (message?.type) {
    pendingPanelMessage = message;
  }

  if (panel) {
    if (message?.type) {
      panel.title = panelTitleForMessage(message);
    }
    panel.reveal(vscode.ViewColumn.One, false);
    flushPendingPanelMessage();
    return;
  }

  panelReady = false;
  panel = vscode.window.createWebviewPanel(
    "cursorTaskboard.panel",
    panelTitleForMessage(message),
    { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: webviewLocalRoots(),
    },
  );

  panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");
  panel.webview.html = getHtml(panel.webview, extensionUri, "editor");
  wireMessages(panel.webview, "editor");

  panel.onDidDispose(() => {
    panel = undefined;
    panelReady = false;
    pendingPanelMessage = null;
  });
}

function flushPendingPanelMessage() {
  if (!panel || !panelReady || !pendingPanelMessage) return;
  const payload = pendingPanelMessage;
  pendingPanelMessage = null;
  void panel.webview.postMessage(payload);
}

function flushPendingOutputBookMessage() {
  if (!outputBookPanel || !outputBookPanelReady || !pendingOutputBookMessage) return;
  const payload = pendingOutputBookMessage;
  pendingOutputBookMessage = null;
  void outputBookPanel.webview.postMessage(payload);
}

/**
 * 产出书：在编辑器新开独立标签页（不弹窗、不覆盖议题详情）
 * @param {{ taskId?: string, bookId?: string, title?: string }} message
 */
function openOutputBookEditor(message = {}) {
  if (!extensionUri) return;
  const title = String(message.title || "产出书内容").trim() || "产出书内容";
  pendingOutputBookMessage = {
    type: "showView",
    view: "outputBook",
    taskId: message.taskId,
    bookId: message.bookId,
    title,
  };

  if (outputBookPanel) {
    outputBookPanel.title = title;
    // 与当前编辑器组同列开标签，避免并排分栏
    outputBookPanel.reveal(vscode.ViewColumn.Active, false);
    flushPendingOutputBookMessage();
    return;
  }

  outputBookPanelReady = false;
  outputBookPanel = vscode.window.createWebviewPanel(
    "cursorTaskboard.outputBook",
    title,
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: webviewLocalRoots(),
    },
  );
  outputBookPanel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");
  outputBookPanel.webview.html = getHtml(outputBookPanel.webview, extensionUri, "editor");
  wireMessages(outputBookPanel.webview, "outputBook");
  outputBookPanel.onDidDispose(() => {
    outputBookPanel = undefined;
    outputBookPanelReady = false;
    pendingOutputBookMessage = null;
  });
}

/**
 * Follow-up after user comments on an agent work report in the panel.
 * @param {{ identifier?: string }} issue
 * @param {string} feedbackBody
 */
function buildWorkCommentFollowUp(issue, feedbackBody, options = {}) {
  const id = String(issue?.identifier || "").trim() || "未知议题";
  const feedback = String(feedbackBody || "").trim();
  const syncProcess = Boolean(options.syncProcess);
  const lines = [
    syncProcess
      ? `e-taskboard 同步处理 ${id}。请立刻调用 MCP issue_get 拉取该议题的最新属性（状态、优先级、标签、负责人、日期、开发上下文等）与全部评论，按最新内容继续处理，并同步进度状态。`
      : `用户刚在任务面板提交了评论。请立刻调用 MCP issue_get 拉取议题 ${id} 的最新属性与全部评论，阅读用户反馈后继续处理，并同步进度状态。`,
  ];
  if (feedback) {
    lines.push("", "用户反馈：", feedback);
  }
  return lines.join("\n");
}

/**
 * Follow-up when user asks to sync issue properties from the panel.
 * @param {{ identifier?: string }} issue
 */
function buildSyncPropertiesFollowUp(issue) {
  const id = String(issue?.identifier || "").trim() || "未知议题";
  return [
    `用户在任务面板点击了「同步属性」。请立刻调用 MCP issue_get 拉取议题 ${id} 的最新数据，`,
    "核对其状态、优先级、标签、开始/截止日期、开发上下文等属性是否与当前进展一致；",
    "如需更新请用 issue_update 同步，并简要说明变更。",
  ].join("");
}

/**
 * 确保产出书目录存在并挂到议题；允许尚未有 md。
 * @param {any} db
 * @param {any} issue
 * @param {string} bookRoot
 * @param {string} [title]
 */
function ensureOutputBookOnIssue(db, issue, bookRoot, title) {
  const root = path.resolve(bookRoot);
  fs.mkdirSync(root, { recursive: true });
  const current = Array.isArray(issue.outputs) ? issue.outputs : [];
  const existing = current.find((item) => path.resolve(String(item.rootPath || "")) === root);
  const scanned = scanOutputBook(root, {
    id: existing?.id,
    createdAt: existing?.createdAt,
    title: title || existing?.title || "产品功能书",
  });
  const { book, outputs } = upsertIssueOutputBook(issue, scanned);
  const updated = db.updateIssue(issue.id, { outputs });
  return { book, issue: updated };
}

/** @type {number} */
let lastMacKeystrokeDeniedAt = 0;
/** @type {number} */
let lastAutoSubmitHintAt = 0;

function extensionVersion() {
  try {
    return require("./package.json").version;
  } catch {
    return "unknown";
  }
}

/**
 * Append a line to globalStorage/sync-debug.log.
 * Remote windows give no visible feedback for失败的 composer 命令, so every
 * fill attempt records which command ran and what the selection looked like.
 * @param {string} message
 * @param {Record<string, unknown>} [data]
 */
function syncLog(message, data) {
  try {
    const dir = globalStorageUri?.fsPath;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    const payload = data ? ` ${JSON.stringify(data)}` : "";
    fs.appendFileSync(
      path.join(dir, "sync-debug.log"),
      `${new Date().toISOString()} ${message}${payload}\n`,
      "utf8",
    );
  } catch {
    // logging must never break the flow
  }
}

/** Remote SSH / WSL 等：扩展宿主在远端，本机 AppleScript 无效 */
function isRemoteSession() {
  return Boolean(vscode.env.remoteName);
}

/** 仅本地 macOS 可用 System Events 模拟按键 */
function canUseMacKeystrokes() {
  return process.platform === "darwin" && !isRemoteSession();
}

/**
 * macOS: activate Cursor and send keystrokes via System Events.
 * Needed because Composer follow-up submit has no reliable public command
 * once the chat already has history (`triggerCreateWorktreeButton` no-ops).
 *
 * Requires BOTH:
 * - 隐私与安全性 → 辅助功能 → Cursor
 * - 隐私与安全性 → 自动化 → Cursor → System Events
 *
 * Remote Cursor 下不要走这条路径（osascript 跑在远端，碰不到本机 UI）。
 *
 * @param {Array<'paste' | 'return' | 'cmd-return'>} steps
 * @returns {Promise<boolean>}
 */
async function macComposerKeystrokes(steps) {
  if (!canUseMacKeystrokes()) return false;
  const lines = [
    'tell application "Cursor" to activate',
    "delay 0.22",
    'tell application "System Events"',
    'tell process "Cursor"',
    "set frontmost to true",
  ];
  for (const step of steps) {
    if (step === "paste") {
      lines.push('keystroke "v" using command down');
      lines.push("delay 0.45");
    } else if (step === "return") {
      lines.push("key code 36");
      lines.push("delay 0.22");
    } else if (step === "cmd-return") {
      lines.push("key code 36 using command down");
      lines.push("delay 0.22");
    }
  }
  lines.push("end tell", "end tell");
  try {
    await execFileAsync("osascript", lines.flatMap((line) => ["-e", line]), {
      timeout: 8000,
    });
    return true;
  } catch (error) {
    const detail = [
      error instanceof Error ? error.message : String(error),
      error && typeof error === "object" && "stderr" in error
        ? String(/** @type {{ stderr?: unknown }} */ (error).stderr || "")
        : "",
    ]
      .join("\n")
      .trim();
    // -1743: not authorized to send Apple events to System Events
    if (/(-1743)|System Events|未获得授权|not authorized/i.test(detail)) {
      const now = Date.now();
      if (now - lastMacKeystrokeDeniedAt > 15000) {
        lastMacKeystrokeDeniedAt = now;
        void vscode.window.showWarningMessage(
          "自动发送被 macOS 拦截：请打开「系统设置 → 隐私与安全性 → 自动化」，在 Cursor 下勾选 System Events，然后完全退出并重开 Cursor。",
        );
      }
    }
    return false;
  }
}

/**
 * Focus composer input (best-effort).
 * `composer.focusComposer` only selects the pane. The follow-up action is what
 * moves focus into the React input so the subsequent `type` command lands there.
 * PROJ-1's resolved historical composer is not a worktree composer, so this
 * does not trigger the command's worktree-only createComposer fallback.
 * @param {string} [composerId]
 */
async function focusComposerInput(composerId) {
  const id = isResumableComposerId(composerId) ? String(composerId).trim() : "";
  await revealComposerChrome();
  if (id) {
    const focused = await tryExecuteCommand("composer.focusComposer", id);
    await sleep(isRemoteSession() ? 280 : 200);
    syncLog("focusComposer", {
      id,
      focused,
      selected: await readSelectedComposerIds(),
    });
  }
  const followUp = await tryExecuteCommand("aichat.newfollowupaction");
  await sleep(isRemoteSession() ? 220 : 140);
  syncLog("newfollowupaction", {
    ok: followUp,
    selected: await readSelectedComposerIds(),
  });
}

/**
 * Discover Composer/Chat submit commands available in this Cursor build.
 * @returns {Promise<string[]>}
 */
async function listComposerSubmitCommands() {
  /** @type {string[]} */
  let available = [];
  try {
    available = await vscode.commands.getCommands(true);
  } catch {
    available = [];
  }
  const preferred = [
    "composer.submit",
    "composer.submitChat",
    "composer.send",
    "composer.sendChat",
    "composer.acceptAndSend",
    "aichat.submit",
    "aichat.send",
    "workbench.action.chat.submit",
    "workbench.action.chat.submitWithCodebase",
    "workbench.action.chat.submitSilent",
  ];
  const preferredHit = preferred.filter((cmd) => available.includes(cmd));
  const discovered = available.filter(
    (cmd) =>
      /^(composer|aichat|cursor\.chat|workbench\.action\.chat)\./i.test(cmd) &&
      /(submit|send|acceptAndSend)/i.test(cmd) &&
      !/(cancel|stop|reject|abort|undo)/i.test(cmd) &&
      !preferredHit.includes(cmd),
  );
  return [...preferredHit, ...discovered];
}

/**
 * Focus a composer tab, then best-effort submit the current draft.
 * Empty chats: `composer.triggerCreateWorktreeButton` may work.
 * Chats with history: prefer submit commands; local macOS can fall back to keystrokes.
 * @param {string} [composerId]
 * @param {{ allowEmptyChatSubmitCommand?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
async function submitComposerChat(composerId, options = {}) {
  await focusComposerInput(composerId);
  const id = isResumableComposerId(composerId) ? String(composerId).trim() : "";

  const candidates = await listComposerSubmitCommands();
  for (const cmd of candidates) {
    try {
      if (id) {
        try {
          await vscode.commands.executeCommand(cmd, id);
          return true;
        } catch {
          // some builds only accept zero-arg
        }
      }
      await vscode.commands.executeCommand(cmd);
      return true;
    } catch {
      // try next
    }
  }

  // Local macOS only: native Enter / ⌘Enter for chats with history
  if (await macComposerKeystrokes(["return"])) return true;
  if (await macComposerKeystrokes(["cmd-return"])) return true;

  // Remote / non-mac: try workbench type Enter（无法确认是否真正发出，失败再走后续）
  if (!canUseMacKeystrokes()) {
    try {
      await vscode.commands.executeCommand("type", { text: "\n" });
      await sleep(220);
    } catch {
      // ignore
    }
  }

  // Last resort: empty-chat-only command (may no-op on chats with history)
  if (options.allowEmptyChatSubmitCommand !== false) {
    /** @type {string[]} */
    let available = [];
    try {
      available = await vscode.commands.getCommands(true);
    } catch {
      available = [];
    }
    if (available.includes("composer.triggerCreateWorktreeButton")) {
      try {
        await vscode.commands.executeCommand("composer.triggerCreateWorktreeButton");
        return true;
      } catch {
        // ignore
      }
    }
  }
  return false;
}

function showAutoSubmitHint(filled) {
  const now = Date.now();
  if (now - lastAutoSubmitHintAt < 12000) return;
  lastAutoSubmitHintAt = now;
  if (isRemoteSession()) {
    void vscode.window.showWarningMessage(
      filled
        ? "远程 Cursor 已填入同步提示，但无法自动发送；请在对话输入框按 Enter / ⌘Enter 提交。"
        : "远程 Cursor 未能自动填入同步提示；请确认已打开绑定对话后，再点一次「同步处理」，或手动粘贴后发送。",
    );
    return;
  }
  void vscode.window.showWarningMessage(
    filled
      ? "已填入处理提示，但未能自动发送；请在对话中按 Enter / ⌘Enter 提交。macOS 还需同时允许：辅助功能 → Cursor，以及 自动化 → Cursor → System Events。"
      : "未能自动填入处理提示；请确认对话输入框已聚焦后再试。",
  );
}

/**
 * `composer.addfilestocomposer` skips files already present in the composer's
 * fileSelections, so a stable name silently no-ops from the second click on.
 * @param {string} [issueId]
 */
function syncPromptFileName(issueId) {
  const safeId = String(issueId || "task")
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "task";
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14);
  return `同步处理-${safeId}-${stamp}.md`;
}

/**
 * Write follow-up prompt as a workspace file (vscode-remote URI on SSH).
 * Remote 不能把 file:// 远端路径交给本机 Composer；必须走工作区 URI。
 * @param {string} content
 * @param {string} [issueId]
 * @returns {Promise<vscode.Uri | null>}
 */
async function writeSyncPromptUri(content, issueId) {
  const text = String(content || "").trim();
  if (!text) return null;
  const name = syncPromptFileName(issueId);
  const bytes = Buffer.from(`${text}\n`, "utf8");
  for (const folder of vscode.workspace.workspaceFolders || []) {
    try {
      const dir = vscode.Uri.joinPath(folder.uri, ".cursor", "taskboard-sync-prompts");
      await vscode.workspace.fs.createDirectory(dir);
      const uri = vscode.Uri.joinPath(dir, name);
      await vscode.workspace.fs.writeFile(uri, bytes);
      return uri;
    } catch {
      // try next folder
    }
  }
  if (globalStorageUri) {
    try {
      const dir = vscode.Uri.joinPath(globalStorageUri, "sync-prompts");
      await vscode.workspace.fs.createDirectory(dir);
      const uri = vscode.Uri.joinPath(dir, name);
      await vscode.workspace.fs.writeFile(uri, bytes);
      return uri;
    } catch {
      // fall through
    }
  }
  return null;
}

/**
 * Remote: 把提示文件变成当前编辑器，再调无参 addfilestocomposer。
 * 本机 workbench 会用 activeEditor URI（vscode-remote://），从而 fireShouldForceText。
 * 不要把远端 file:// Uri 当参数传过去——RPC 后 ye.isUri 常失败，命令直接空跑。
 * @param {string} composerId
 * @param {string} content
 * @param {{ issueId?: string }} [options]
 * @returns {Promise<boolean>}
 */
async function fillComposerViaAttachedPrompt(composerId, content, options = {}) {
  const text = String(content || "").trim();
  const id = isResumableComposerId(composerId) ? String(composerId).trim() : "";
  if (!text || !id) return false;

  const uri = await writeSyncPromptUri(text, options.issueId);
  syncLog("promptFile", { uri: uri ? uri.toString() : null });
  if (!uri) return false;

  // addfilestocomposer writes into whichever composer is currently selected,
  // so the bound thread must be the selection before the command runs.
  await revealComposerChrome();
  await tryExecuteCommand("composer.focusComposer", id);
  await sleep(300);
  const selectedBefore = await readSelectedComposerIds();
  syncLog("attach:selection", { id, selectedBefore });

  const attached = await tryExecuteCommand("composer.addfilestocomposer", uri, {
    useExactResource: true,
  });
  await sleep(320);
  syncLog("attach:result", { attached });

  await tryExecuteCommand("composer.focusComposer", id);
  return attached;
}

/**
 * Best-effort: put text into the focused Composer input.
 * `type` and `clipboardPasteAction` only reach Monaco editors, so they cannot
 * write into the Lexical composer input — keep them for local fallbacks only.
 * @param {string} content
 * @returns {Promise<boolean>}
 */
async function fillComposerInput(content) {
  const text = String(content || "");
  if (!text) return false;
  const remote = isRemoteSession();

  // 1) 本地 macOS：System Events ⌘V（React 输入框最稳）
  if (canUseMacKeystrokes()) {
    if (await macComposerKeystrokes(["paste"])) {
      await sleep(280);
      return true;
    }
  }

  // 2) 剪贴板 + paste 命令（Monaco / 部分输入框）
  try {
    await vscode.env.clipboard.writeText(text);
    await sleep(remote ? 280 : 120);
    await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
    await sleep(remote ? 500 : 320);
    return true;
  } catch {
    // fall through
  }

  // 3) 本地非 mac 再试 type
  if (!remote) {
    try {
      await vscode.commands.executeCommand("type", { text });
      await sleep(300);
      return true;
    } catch {
      // ignore
    }
  }

  return false;
}

/**
 * Paste / type follow-up into the bound Composer, optionally submit.
 * @param {string} text
 * @param {{ autoSubmit?: boolean, composerId?: string, quiet?: boolean, issueId?: string }} [options]
 * @returns {Promise<boolean>} true if text was filled (submit may still have failed)
 */
async function injectComposerFollowUp(text, options = {}) {
  const content = String(text || "").trim();
  if (!content) return false;
  const composerId = isResumableComposerId(options.composerId)
    ? String(options.composerId).trim()
    : "";
  const autoSubmit = Boolean(options.autoSubmit);
  const quiet = Boolean(options.quiet);
  const remote = isRemoteSession();

  syncLog("inject:start", {
    version: extensionVersion(),
    remote,
    remoteName: vscode.env.remoteName || null,
    composerId,
    issueId: options.issueId || null,
    autoSubmit,
    length: content.length,
  });

  // Remote: 扩展宿主无法把按键送进本机 Lexical 输入框，只有
  // addfilestocomposer 会走 updateComposerData + fireShouldForceText。
  if (remote && composerId) {
    await vscode.env.clipboard.writeText(content).catch(() => {});
    const attached = await fillComposerViaAttachedPrompt(composerId, content, {
      issueId: options.issueId,
    });
    syncLog("inject:remote-done", { attached });
    if (attached) {
      if (autoSubmit) {
        const submitted = await submitComposerChat(composerId, {
          allowEmptyChatSubmitCommand: false,
        });
        syncLog("inject:remote-submit", { submitted });
        if (!submitted && !quiet) showAutoSubmitHint(true);
      }
      return true;
    }
    if (!quiet) showAutoSubmitHint(false);
    return false;
  }

  await focusComposerInput(composerId);
  await sleep(remote ? 450 : 160);

  const previous = await vscode.env.clipboard.readText().catch(() => "");
  try {
    await vscode.env.clipboard.writeText(content);
    await sleep(100);

    const filled = await fillComposerInput(content);
    syncLog("inject:local-fill", { filled });

    if (!filled) {
      if (!quiet) showAutoSubmitHint(false);
      return false;
    }

    if (!autoSubmit) return true;

    // 本地 mac：填入后可直接 ⌘Enter / Enter
    if (canUseMacKeystrokes()) {
      if (await macComposerKeystrokes(["return"])) return true;
      if (await macComposerKeystrokes(["cmd-return"])) return true;
    }

    const submitted = await submitComposerChat(composerId, {
      allowEmptyChatSubmitCommand: false,
    });
    if (!submitted && !quiet) {
      // 填入成功即可；远程自动发送本就不保证
      showAutoSubmitHint(true);
    }
    return true;
  } catch {
    if (!quiet) showAutoSubmitHint(false);
    return false;
  } finally {
    if (!remote && previous !== undefined) {
      await sleep(180);
      try {
        await vscode.env.clipboard.writeText(previous);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Prefill prompt for Taskboard → Cursor Agent chat.
 * Includes development context so the agent works against the bound branch/worktree.
 * @param {{ identifier?: string, title?: string, gitBranch?: string | null, worktreePath?: string | null }} issue
 */
function buildNativeChatPrompt(issue) {
  const id = String(issue?.identifier || "").trim() || "未知议题";
  const title = String(issue?.title || "").trim();
  const branch = String(issue?.gitBranch || "").trim();
  const paths = parseWorktreePaths(issue?.worktreePath);

  const lines = [
    `e-taskboard 处理任务面板任务 ${id}，并同步进度状态。`,
  ];
  if (title) lines.push(`议题主题：${title}`);
  if (branch || paths.length) {
    lines.push("开发上下文：");
    if (branch) lines.push(`- 分支：${branch}`);
    if (paths.length) {
      if (paths.length === 1) {
        lines.push(`- 工作目录：${paths[0]}`);
      } else {
        lines.push("- 工作目录（可多选）：");
        for (const p of paths) lines.push(`  - ${p}`);
      }
      lines.push("请优先在上述目录中进行改动，避免污染无关工作区。");
    } else {
      lines.push("尚未绑定工作目录；可在议题详情填写/多选已有文件夹，或创建 worktree。");
    }
  } else {
    lines.push("开发上下文：未绑定分支/工作目录。");
  }
  return lines.join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string[]} ids
 */
async function firstAvailableCommand(ids) {
  const all = await vscode.commands.getCommands(true);
  return ids.find((id) => all.includes(id));
}

/**
 * @returns {Promise<string[]>}
 */
async function readSelectedComposerIds() {
  try {
    const ids = await vscode.commands.executeCommand("composer.getOrderedSelectedComposerIds");
    if (Array.isArray(ids)) {
      return ids.filter((item) => typeof item === "string" && item);
    }
  } catch {
    // ignore
  }
  return [];
}

/**
 * Cursor composer.openComposer(composerId, options) requires a UUID string id.
 * Mock ids, non-strings, or the deeplink-shaped `{ type, id }` object trigger
 * host errors like "n.startsWith is not a function" / stuck Loading Chat.
 * @param {unknown} threadId
 */
function isResumableComposerId(threadId) {
  if (typeof threadId !== "string") return false;
  const id = threadId.trim();
  if (!id) return false;
  if (/demo/i.test(id)) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/**
 * Reveal Cursor Agent / Composer chrome (secondary side bar).
 * Remote SSH 下会话多在 Auxiliary Bar 的 editor 里，不先展开会「像没打开」。
 * 只用 focus，避免 toggle 把已打开的侧栏又关掉。
 */
async function revealComposerChrome() {
  try {
    await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
  } catch {
    // older builds
  }
}

/**
 * @param {string} command
 * @param {...unknown} args
 */
async function tryExecuteCommand(command, ...args) {
  try {
    await vscode.commands.executeCommand(command, ...args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open / focus an existing Cursor chat by composer UUID.
 * Keep this close to 0.3.134: openComposer(id) + focusComposer(id).
 * Never createNew / chat.open / glass.openAgentById / aichat.newfollowupaction —
 * those spawn「New Agent」instead of the bound thread.
 * @param {string} threadId
 * @param {{ title?: string }} [options]
 * @returns {Promise<boolean>}
 */
async function openExistingComposer(threadId, options = {}) {
  if (!isResumableComposerId(threadId)) return false;
  const id = String(threadId || "").trim();
  if (!id) return false;
  const title = String(options.title || "").trim();
  const remote = isRemoteSession();

  // Preload conversation blobs in this window (side-effect; return value may not serialize).
  await tryExecuteCommand("composer.getComposerHandleById", id);

  const before = await readSelectedComposerIds();
  if (before.includes(id)) {
    await tryExecuteCommand("composer.focusComposer", id);
    await sleep(remote ? 220 : 80);
    if (title) await syncComposerChatTitle(id, title);
    return true;
  }

  await revealComposerChrome();

  // 与昨天可用的远程路径一致：string UUID + pane。不要传 {type,id}。
  const opened =
    (await tryExecuteCommand("composer.openComposer", id, {
      openInNewTab: true,
      view: "pane",
      focusMainInputBox: true,
    })) ||
    (await tryExecuteCommand("composer.openComposer", id, {
      openInNewTab: true,
      focusMainInputBox: true,
    })) ||
    (await tryExecuteCommand("composer.openComposer", id)) ||
    (await tryExecuteCommand("composer.focusComposer", id));

  if (!opened) return false;

  await sleep(remote ? 420 : 160);
  await tryExecuteCommand("composer.focusComposer", id);
  await sleep(remote ? 200 : 40);
  if (title) await syncComposerChatTitle(id, title);
  return true;
}

/**
 * Best-effort: read the currently selected composer / chat id.
 * @returns {Promise<string | null>}
 */
async function readSelectedComposerId() {
  const ids = await readSelectedComposerIds();
  return ids[0] || null;
}

/**
 * Chat tab title should match the issue subject (议题主题).
 * @param {{ title?: string, identifier?: string } | null | undefined} issue
 */
function composerChatTitle(issue) {
  const title = String(issue?.title || "").trim();
  if (title) return title;
  const id = String(issue?.identifier || "").trim();
  return id || "Taskboard";
}

/**
 * Best-effort: sync Cursor chat pane title to the issue subject.
 * New chats should set partialState.name (composer.name); this covers pane chrome.
 * @param {string} composerId
 * @param {string} title
 */
async function syncComposerChatTitle(composerId, title) {
  const id = String(composerId || "").trim();
  const name = String(title || "").trim();
  if (!id || !name) return;
  try {
    await vscode.commands.executeCommand("composer.updateTitle", id, name);
  } catch {
    // Older Cursor builds may not expose composer.updateTitle.
  }
}

/**
 * Create a new Agent chat and prefill prompt via internal commands (no deeplink).
 * @param {string} prompt
 * @param {{ title?: string }} [options]
 * @returns {Promise<{ ok: boolean, composerId: string | null }>}
 */
async function openNewComposerWithPrompt(prompt, options = {}) {
  const text = String(prompt || "");
  if (!text) return { ok: false, composerId: null };
  const title = String(options.title || "").trim();
  const autoSubmit = Boolean(options.autoSubmit);
  const remote = isRemoteSession();

  const createCommand = await firstAvailableCommand([
    "composer.createNew",
    "composer.newAgentChat",
    "composer.createNewComposerTab",
    "aichat.newchataction",
  ]);

  const beforeIds = await readSelectedComposerIds();

  /** @type {any} */
  let created = null;
  let opened = false;

  // 远程优先走 Cursor 原生「带 query 开聊」：内部会 createComposer + fireShouldForceText，
  // 比从远端 EH 去 type/粘贴 React 输入框可靠得多。
  if (remote) {
    try {
      await vscode.commands.executeCommand("workbench.action.chat.open", { query: text });
      opened = true;
      await sleep(600);
    } catch {
      try {
        await vscode.commands.executeCommand("workbench.action.chat.open", text);
        opened = true;
        await sleep(600);
      } catch {
        opened = false;
      }
    }
  }

  // Prefer createNew(partialState.text[+autoSubmit]) — Cursor createComposer 会在
  // autoSubmit 时直接 submitChatMaybeAbortCurrent(composerId, text)。
  if (!opened && createCommand) {
    try {
      created = await vscode.commands.executeCommand(createCommand, {
        partialState: {
          text,
          richText: text,
          unifiedMode: "agent",
          ...(title ? { name: title } : {}),
        },
        unifiedMode: "agent",
        openInNewTab: true,
        view: "pane",
        source: "taskboard",
        autoSubmit,
      });
      opened = true;
    } catch {
      opened = false;
    }
  }

  // 远程：chat.open 已填入后，再用 createNew(autoSubmit) 可能重复；只补提交
  if (!opened && createCommand) {
    try {
      await vscode.commands.executeCommand(createCommand);
      await injectComposerFollowUp(text, { autoSubmit });
      opened = true;
    } catch {
      opened = false;
    }
  }

  if (!opened) return { ok: false, composerId: null };

  await sleep(autoSubmit ? (remote ? 900 : 450) : 200);
  const afterIds = await readSelectedComposerIds();
  const fromResult =
    created && typeof created === "object" && typeof created.composerId === "string"
      ? created.composerId
      : typeof created === "string"
        ? created
        : null;
  const newlySelected = afterIds.find((item) => !beforeIds.includes(item)) || null;
  // Prefer create result, then newly appeared selection — never reuse the previous chat id.
  const composerId = fromResult || newlySelected || null;
  if (composerId && title) {
    await syncComposerChatTitle(composerId, title);
  }
  // 若 create 的 autoSubmit 未真正发出（草稿仍在输入框），补提交
  if (autoSubmit && composerId) {
    await sleep(remote ? 700 : 350);
    const submitted = await submitComposerChat(composerId, {
      allowEmptyChatSubmitCommand: true,
    });
    if (!submitted) showAutoSubmitHint(true);
  }
  return { ok: true, composerId };
}

async function ensureRuntimeReady(dbPath) {
  if (runtimeConfig?.skillPath && fs.existsSync(runtimeConfig.skillPath)) return;
  runtimeConfig = installRuntime(
    { extensionPath: extensionUri?.fsPath || "" },
    dbPath,
    { attachmentsRoot: attachmentsRootUri?.fsPath },
  );
}

/**
 * @param {string} taskId issue id or identifier
 * @param {{
 *   threadId?: string,
 *   preferExisting?: boolean,
 *   followUpText?: string,
 *   autoSubmit?: boolean,
 * }} [options]
 */
async function openNativeChat(taskId, options = {}) {
  const id = String(taskId || "").trim();
  const preferredThreadId = isResumableComposerId(options.threadId)
    ? String(options.threadId).trim()
    : "";
  const followUpText = String(options.followUpText || "").trim();
  const autoSubmit = Boolean(options.autoSubmit);

  if (!id && !preferredThreadId) {
    void vscode.window.showWarningMessage("缺少任务编号");
    return;
  }

  const db = await ensureStore();
  const issue = id ? db.getIssue(id) : null;
  if (id && !issue) {
    void vscode.window.showWarningMessage(`议题不存在: ${id}`);
    return;
  }

  try {
    if (db.dbPath) await ensureRuntimeReady(db.dbPath);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`无法准备 skill/MCP: ${text}`);
    return;
  }

  // Drop stale mock bindings so UI no longer offers "打开已有对话".
  if (issue?.threadId && !isResumableComposerId(issue.threadId)) {
    db.updateIssue(issue.id, { threadId: null });
    await pushSnapshot();
    issue.threadId = null;
  }

  const chatTitle = issue ? composerChatTitle(issue) : "";

  // 议题已绑定会话时默认续写（含远程 SSH）。仅 fork / 显式 preferExisting:false 才新建。
  // 注意：webview 若漏传 preferExisting，Boolean(undefined)===false 会误新建 —— 这里按「非 false」判断。
  // 绑定 ID 若是从未发送的空草稿（标题 New Agent），改打开真正有 transcript 的会话。
  const boundThreadId =
    preferredThreadId ||
    (isResumableComposerId(issue?.threadId) ? String(issue.threadId).trim() : "");
  const resolvedThreadId = issue
    ? resolveComposerIdForIssue({
        threadId: boundThreadId || issue.threadId,
        identifier: issue.identifier,
        title: issue.title,
      })
    : boundThreadId;
  const existingThreadId = isResumableComposerId(resolvedThreadId)
    ? String(resolvedThreadId).trim()
    : boundThreadId;
  if (
    issue &&
    existingThreadId &&
    existingThreadId !== String(issue.threadId || "").trim()
  ) {
    db.updateIssue(issue.id, { threadId: existingThreadId });
    issue.threadId = existingThreadId;
    await pushSnapshot();
  }
  const forceNew = options.preferExisting === false;
  if (existingThreadId && !forceNew) {
    const opened = await openExistingComposer(existingThreadId, {
      title: chatTitle || undefined,
    });
    if (opened) {
      if (followUpText) {
        const remote = isRemoteSession();
        // 远程先写入剪贴板，保证即使用 type/粘贴失败，用户也能 Ctrl+V
        if (remote) {
          try {
            await vscode.env.clipboard.writeText(followUpText);
          } catch {
            // ignore
          }
        }
        await sleep(remote ? 280 : 220);
        await injectComposerFollowUp(followUpText, {
          autoSubmit: remote ? false : autoSubmit,
          composerId: existingThreadId,
          issueId: issue?.identifier || issue?.id || "",
          quiet: false,
        });
      }
      return;
    }
    // 打不开也不新建，避免「同步处理」/自动化把原会话绑丢
    void vscode.window.showWarningMessage(
      `无法打开已绑定对话（${existingThreadId.slice(0, 8)}…）。请在 Chat 历史里确认该会话仍在，或先解绑后再开新对话。`,
    );
    return;
  }

  if (!issue) {
    void vscode.window.showWarningMessage("缺少议题，无法新建对话");
    return;
  }

  const prompt = followUpText
    ? `${buildNativeChatPrompt(issue)}\n\n${followUpText}`
    : buildNativeChatPrompt(issue);
  const { ok, composerId } = await openNewComposerWithPrompt(prompt, {
    title: chatTitle,
    autoSubmit,
  });
  if (!ok) {
    void vscode.window.showErrorMessage(
      "当前 Cursor 未找到可用的新建对话命令（composer.createNew / composer.newAgentChat）",
    );
    return;
  }

  // Bind the new conversation so later "在对话中打开" resumes it.
  // 不要用空草稿覆盖已经有真实聊天记录的 threadId（否则「查看对话」会打开 New Agent）。
  if (composerId) {
    const previous = String(issue.threadId || "").trim();
    const previousHasHistory = composerHasTranscript(previous);
    const createdHasHistory = composerHasTranscript(composerId);
    if (previousHasHistory && !createdHasHistory) {
      void vscode.window.showWarningMessage(
        "已打开输入框，但未改绑原会话（避免空草稿覆盖已有对话）。",
      );
    } else {
      db.updateIssue(issue.id, { threadId: composerId });
      await pushSnapshot();
    }
  } else {
    void vscode.window.showWarningMessage(
      "已打开新对话，但未能读取会话 ID；下次仍可能新建。",
    );
  }
}

/**
 * Native Cursor Fork Chat via composer.duplicateChat, then record threadId on the report.
 * Does not rebind the issue's primary threadId — a report may accumulate many forks.
 * @param {string} taskId
 * @param {{ commentId?: string, bubbleId?: string | null }} [options]
 */
async function forkChatForReport(taskId, options = {}) {
  const id = String(taskId || "").trim();
  const commentId = String(options.commentId || "").trim();
  if (!id || !commentId) {
    void vscode.window.showWarningMessage("缺少议题或汇报编号");
    return;
  }

  const db = await ensureStore();
  const issue = db.getIssue(id);
  if (!issue) {
    void vscode.window.showWarningMessage(`议题不存在: ${id}`);
    return;
  }
  const report = (issue.comments || []).find((item) => item.id === commentId);
  if (!report) {
    void vscode.window.showWarningMessage(`汇报不存在: ${commentId}`);
    return;
  }

  const sourceThreadId = [issue.threadId, report.threadId]
    .map((value) => String(value || "").trim())
    .find((value) => isResumableComposerId(value));
  if (!sourceThreadId) {
    void vscode.window.showWarningMessage("当前议题未绑定可 Fork 的对话，请先打开/绑定对话");
    return;
  }

  const bubbleId = String(options.bubbleId || "").trim() || null;
  const beforeIds = await readSelectedComposerIds();

  try {
    /** @type {any} */
    const payload = { composerId: sourceThreadId };
    if (bubbleId) payload.bubbleId = bubbleId;
    await vscode.commands.executeCommand("composer.duplicateChat", payload);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Fork Chat 失败（composer.duplicateChat）: ${text}`);
    return;
  }

  await sleep(220);
  let afterIds = await readSelectedComposerIds();
  let forkThreadId = afterIds.find((item) => !beforeIds.includes(item) && item !== sourceThreadId) || null;
  if (!forkThreadId) {
    await sleep(280);
    afterIds = await readSelectedComposerIds();
    forkThreadId = afterIds.find((item) => !beforeIds.includes(item) && item !== sourceThreadId) || null;
  }
  if (!forkThreadId) {
    const focused = await readSelectedComposerId();
    if (focused && focused !== sourceThreadId && isResumableComposerId(focused)) {
      forkThreadId = focused;
    }
  }

  if (!forkThreadId || !isResumableComposerId(forkThreadId)) {
    void vscode.window.showWarningMessage(
      "已触发 Cursor Fork，但未能读取新 threadId；请在 Cursor 中确认后手动同步。",
    );
    return;
  }

  const title = `${composerChatTitle(issue)} (Fork)`;
  await syncComposerChatTitle(forkThreadId, title);

  try {
    db.addCommentFork(issue.id, commentId, {
      threadId: forkThreadId,
      bubbleId,
      sourceThreadId,
    });
    await pushSnapshot();
    void vscode.window.showInformationMessage(`已 Fork 并记录到该汇报（${forkThreadId.slice(0, 8)}…）`);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Fork 已创建，但记录失败: ${text}`);
  }
}

/**
 * @returns {Promise<string | null>}
 */
async function resolveWorkspaceGitRoot() {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return findGitRoot(folder);
}

/**
 * @param {string} taskId
 * @param {"create" | "switch" | "bind" | "pick" | "open" | "unbind" | "remove-path" | "add-path" | string} action
 * @param {{ branch?: string, path?: string, paths?: string[], items?: Array<{ gitRoot?: string, branch?: string, path?: string, sourcePaths?: string[] }> }} [options]
 */
async function handleDevContextAction(taskId, action, options = {}) {
  const id = String(taskId || "").trim();
  if (!id) {
    void vscode.window.showWarningMessage("缺少议题编号");
    return;
  }

  const db = await ensureStore();
  const issue = db.getIssue(id);
  if (!issue) {
    void vscode.window.showWarningMessage(`议题不存在: ${id}`);
    return;
  }

  const currentPaths = parseWorktreePaths(issue.worktreePath);

  if (action === "unbind") {
    db.updateIssue(issue.id, { gitBranch: null, worktreePath: null });
    await pushSnapshot();
    void vscode.window.showInformationMessage("已解绑开发上下文（未删除磁盘上的文件夹/worktree）");
    return;
  }

  if (action === "remove-path") {
    const target = String(options.path || "").trim();
    if (!target) return;
    const next = currentPaths.filter((item) => item !== target);
    db.updateIssue(issue.id, { worktreePath: serializeWorktreePaths(next) });
    await pushSnapshot();
    return;
  }

  if (action === "add-path") {
    const extras = [
      ...parseWorktreePaths(options.path),
      ...(Array.isArray(options.paths) ? options.paths : []),
    ]
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    if (!extras.length) return;
    const next = serializeWorktreePaths([...currentPaths, ...extras]);
    db.updateIssue(issue.id, { worktreePath: next });
    await pushSnapshot();
    return;
  }

  if (action === "pick") {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: "绑定文件夹",
      title: "选择已有文件夹（可多选）",
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    if (!uris?.length) return;
    const picked = uris.map((uri) => uri.fsPath);
    db.updateIssue(issue.id, {
      worktreePath: serializeWorktreePaths([...currentPaths, ...picked]),
    });
    await pushSnapshot();
    void vscode.window.showInformationMessage(
      picked.length === 1 ? `已绑定文件夹：${picked[0]}` : `已绑定 ${picked.length} 个文件夹`,
    );
    return;
  }

  if (action === "open") {
    const preferred = String(options.path || "").trim();
    const existing = currentPaths.filter((item) => fs.existsSync(item));
    if (!existing.length && !(preferred && fs.existsSync(preferred))) {
      void vscode.window.showWarningMessage("尚未绑定有效的文件夹路径");
      return;
    }
    let worktreePath = preferred && fs.existsSync(preferred) ? preferred : existing[0];
    if (!preferred && existing.length > 1) {
      const pickedPath = await vscode.window.showQuickPick(
        existing.map((item) => ({ label: path.basename(item), description: item, path: item })),
        { title: "选择要打开的文件夹" },
      );
      if (!pickedPath) return;
      worktreePath = pickedPath.path;
    }
    const choice = await vscode.window.showQuickPick(
      [
        { label: "在新窗口打开", description: worktreePath, action: "window" },
        { label: "在终端打开", description: "cwd = 所选文件夹", action: "terminal" },
        { label: "在文件管理器中显示", action: "reveal" },
      ],
      { title: "打开开发上下文" },
    );
    if (!choice) return;
    if (choice.action === "window") {
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(worktreePath), true);
    } else if (choice.action === "terminal") {
      const term = vscode.window.createTerminal({ name: issue.gitBranch || issue.identifier, cwd: worktreePath });
      term.show();
    } else {
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(worktreePath));
    }
    return;
  }

  if (action === "open-workspace") {
    const existing = currentPaths.filter((item) => fs.existsSync(item));
    if (!existing.length) {
      void vscode.window.showWarningMessage("尚未绑定有效的文件夹路径");
      return;
    }
    if (existing.length === 1) {
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(existing[0]), true);
      return;
    }
    const workspaceDir = path.join(os.homedir(), ".cursor-taskboard", "workspaces");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const safeId = String(issue.identifier || issue.id || "issue").replace(/[^\w.-]+/g, "_");
    const workspaceFile = path.join(workspaceDir, `${safeId}.code-workspace`);
    const content = {
      folders: existing.map((folderPath) => ({
        path: folderPath,
        name: path.basename(folderPath),
      })),
    };
    fs.writeFileSync(workspaceFile, `${JSON.stringify(content, null, 2)}\n`, "utf8");
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(workspaceFile), true);
    return;
  }

  /**
   * 将同一主仓库下的绑定路径替换为 nextPath。
   * @param {string[]} paths
   * @param {string} repoRoot
   * @param {string} nextPath
   */
  async function replaceRepoBoundPaths(paths, repoRoot, nextPath) {
    const rootKey = path.resolve(repoRoot);
    const kept = [];
    for (const folder of paths) {
      const root = await findRepoRoot(folder);
      if (root && path.resolve(root) === rootKey) continue;
      kept.push(folder);
    }
    kept.push(path.resolve(nextPath));
    return [...new Set(kept)];
  }

  if (action === "switch") {
    const rawItems = Array.isArray(options.items) ? options.items : [];
    /** @type {Array<{ gitRoot: string, path: string, branch: string }>} */
    let items = rawItems
      .map((item) => ({
        gitRoot: String(item?.gitRoot || "").trim(),
        path: String(item?.path || "").trim(),
        branch: String(item?.branch || "").trim(),
      }))
      .filter((item) => item.gitRoot && item.path);

    if (!items.length) {
      const singlePath = String(options.path || "").trim();
      if (!singlePath) throw new Error("请选择要切换的 worktree");
      const root = (await findRepoRoot(singlePath)) || "";
      items = [{ gitRoot: root, path: singlePath, branch: String(options.branch || "").trim() }];
    }

    let nextPaths = [...currentPaths];
    /** @type {string[]} */
    const switched = [];
    for (const item of items) {
      const target = path.resolve(item.path);
      if (!fs.existsSync(target)) {
        throw new Error(`路径不存在: ${target}`);
      }
      const repoRoot = path.resolve(item.gitRoot || (await findRepoRoot(target)) || "");
      if (!repoRoot) throw new Error(`无法识别仓库: ${target}`);
      nextPaths = await replaceRepoBoundPaths(nextPaths, repoRoot, target);
      switched.push(target);
    }

    const branches = [
      ...new Set(
        items
          .map((item) => item.branch)
          .filter(Boolean)
          .concat(
            await Promise.all(
              switched.map(async (folder) => (await currentBranch(folder)) || ""),
            ),
          )
          .filter(Boolean),
      ),
    ];
    const nextBranch =
      branches.length === 1
        ? branches[0]
        : branches.find((name) => name === suggestBranchName(issue)) || branches[0] || issue.gitBranch;

    db.updateIssue(issue.id, {
      gitBranch: nextBranch || null,
      worktreePath: serializeWorktreePaths(nextPaths),
    });
    db.addActivity(issue.id, {
      id: `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      kind: "devctx",
      actorName: "webhua yang",
      field: "worktree",
      before: "切换 worktree",
      after: switched.join("\n"),
      createdAt: new Date().toISOString(),
    });
    await pushSnapshot();
    void vscode.window.showInformationMessage(
      switched.length === 1 ? `已切换开发上下文：${switched[0]}` : `已切换 ${switched.length} 个仓库的 worktree`,
    );
    return;
  }

  if (action === "create") {
    const rawItems = Array.isArray(options.items) ? options.items : [];
    /** @type {Array<{ gitRoot: string, branch: string, parentFolder: string, sourcePaths: string[] }>} */
    let items = rawItems
      .map((item) => ({
        gitRoot: String(item?.gitRoot || "").trim(),
        branch: String(item?.branch || "").trim(),
        parentFolder: String(item?.path || "").trim(),
        sourcePaths: Array.isArray(item?.sourcePaths)
          ? item.sourcePaths.map((p) => String(p || "").trim()).filter(Boolean)
          : [],
      }))
      .filter((item) => item.gitRoot && item.branch && item.parentFolder);

    // 兼容旧单仓库入参：回退到当前工作区 git root
    if (!items.length) {
      const fallbackRoot = await resolveWorkspaceGitRoot();
      const branchName = String(options.branch || "").trim();
      const parentFolder = String(options.path || "").trim();
      if (!fallbackRoot) throw new Error("当前工作区不是 git 仓库，无法创建 worktree");
      if (!branchName || !parentFolder) throw new Error("请为每个 git 仓库选择分支");
      items = [
        {
          gitRoot: fallbackRoot,
          branch: branchName,
          parentFolder,
          sourcePaths: [],
        },
      ];
    }

    try {
      /** @type {Array<{ path: string, branch: string, reused: boolean, gitRoot: string }>} */
      const created = [];
      /** @type {string[]} */
      const errors = [];

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `创建 worktree（${items.length}）…`,
        },
        async () => {
          for (const item of items) {
            const root = path.resolve(item.gitRoot);
            if (!(await findRepoRoot(root))) {
              errors.push(`${path.basename(root)}: 不是有效 git 仓库`);
              continue;
            }
            const parent = path.resolve(item.parentFolder);
            if (fs.existsSync(parent) && !fs.statSync(parent).isDirectory()) {
              errors.push(`${path.basename(root)}: 存放目录无效`);
              continue;
            }
            fs.mkdirSync(parent, { recursive: true });
            const targetPath = path.join(parent, worktreeFolderName(item.branch));
            try {
              const result = await createWorktree(root, item.branch, { path: targetPath });
              created.push({
                ...result,
                gitRoot: root,
              });
            } catch (error) {
              const text = error instanceof Error ? error.message : String(error);
              errors.push(`${path.basename(root)}: ${text}`);
            }
          }
        },
      );

      if (!created.length) {
        throw new Error(errors[0] || "创建 worktree 失败");
      }

      let nextPaths = [...currentPaths];
      for (const item of created) {
        nextPaths = await replaceRepoBoundPaths(nextPaths, item.gitRoot, item.path);
      }
      const branches = [...new Set(created.map((item) => item.branch).filter(Boolean))];
      const nextBranch =
        branches.length === 1
          ? branches[0]
          : branches.find((name) => name === suggestBranchName(issue)) || branches[0] || issue.gitBranch;

      db.updateIssue(issue.id, {
        gitBranch: nextBranch || null,
        worktreePath: serializeWorktreePaths(nextPaths),
      });
      db.addActivity(issue.id, {
        id: `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        kind: "devctx",
        actorName: "webhua yang",
        field: "worktree",
        before: created
          .map(
            (item) =>
              `${path.basename(item.gitRoot)} → ${item.branch}${item.reused ? "（复用）" : ""}`,
          )
          .join("\n"),
        after: created.map((item) => item.path).join("\n"),
        createdAt: new Date().toISOString(),
      });
      await pushSnapshot();

      const okText =
        created.length === 1
          ? created[0].reused
            ? `已复用 worktree：${shortWorktreeLabel(created[0].path, created[0].gitRoot)}`
            : `已创建 worktree：${shortWorktreeLabel(created[0].path, created[0].gitRoot)}`
          : `已为 ${created.length} 个仓库切换到 worktree 上下文`;
      if (errors.length) {
        void vscode.window.showWarningMessage(`${okText}；部分失败：${errors.join("；")}`);
      } else {
        void vscode.window.showInformationMessage(okText);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`创建 worktree 失败: ${text}`);
      throw error;
    }
    return;
  }

  const gitRoot = await resolveWorkspaceGitRoot();
  if (!gitRoot) {
    const msg = "当前工作区不是 git 仓库，无法管理 worktree";
    void vscode.window.showErrorMessage(msg);
    return;
  }

  if (action === "bind") {
    const trees = (await listWorktrees(gitRoot)).filter((item) => !item.bare && item.path !== gitRoot);
    if (!trees.length) {
      void vscode.window.showInformationMessage("没有可绑定的 worktree，也可点「选择文件夹」绑定任意目录");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      trees.map((item) => ({
        label: item.branch || "(detached)",
        description: shortWorktreeLabel(item.path, gitRoot),
        detail: item.path,
        item,
      })),
      { title: "绑定已有 git worktree（可多选）", canPickMany: true },
    );
    if (!picked?.length) return;
    const paths = picked.map((row) => row.item.path);
    const branch = picked[0]?.item?.branch || issue.gitBranch || null;
    db.updateIssue(issue.id, {
      gitBranch: branch,
      worktreePath: serializeWorktreePaths([...currentPaths, ...paths]),
    });
    await pushSnapshot();
    void vscode.window.showInformationMessage(
      paths.length === 1
        ? `已绑定 worktree: ${picked[0].item.branch || shortWorktreeLabel(paths[0], gitRoot)}`
        : `已绑定 ${paths.length} 个 worktree`,
    );
    return;
  }
}

/**
 * @param {string} taskId
 */
async function prepareCreateWorktree(taskId) {
  const id = String(taskId || "").trim();
  const db = await ensureStore();
  const issue = id ? db.getIssue(id) : null;
  if (!issue) throw new Error(`议题不存在: ${id}`);

  const boundPaths = parseWorktreePaths(issue.worktreePath);
  if (!boundPaths.length) {
    throw new Error("请先选择文件夹作为开发上下文，再管理 worktree");
  }

  const suggestedBranch = suggestBranchName(issue);
  /** @type {Map<string, { gitRoot: string, sourcePaths: string[] }>} */
  const byRoot = new Map();
  /** @type {string[]} */
  const nonGitFolders = [];

  for (const folder of boundPaths) {
    if (!folder || !fs.existsSync(folder)) {
      nonGitFolders.push(folder);
      continue;
    }
    const root = await findRepoRoot(folder);
    if (!root) {
      nonGitFolders.push(folder);
      continue;
    }
    const key = path.resolve(root);
    const entry = byRoot.get(key) || { gitRoot: key, sourcePaths: [] };
    entry.sourcePaths.push(folder);
    byRoot.set(key, entry);
  }

  if (!byRoot.size) {
    throw new Error("已绑定文件夹都不是 git 仓库，无法管理 worktree");
  }

  const repos = [];
  for (const entry of byRoot.values()) {
    const branches = await listLocalBranches(entry.gitRoot);
    const activePath = entry.sourcePaths[0] || entry.gitRoot;
    const activeBranch = (await currentBranch(activePath)) || (await currentBranch(entry.gitRoot));
    const activeSet = new Set(entry.sourcePaths.map((item) => path.resolve(item)));
    const worktrees = (await listWorktrees(entry.gitRoot))
      .filter((item) => !item.bare)
      .map((item) => {
        const abs = path.resolve(item.path);
        return {
          path: abs,
          branch: item.branch || (item.detached ? "(detached)" : ""),
          detached: Boolean(item.detached),
          isMain: abs === path.resolve(entry.gitRoot),
          isActive: activeSet.has(abs),
        };
      });

    // 若绑定路径不在 worktree 列表中（少见），补一条便于切换
    for (const folder of entry.sourcePaths) {
      const abs = path.resolve(folder);
      if (!worktrees.some((item) => item.path === abs)) {
        worktrees.unshift({
          path: abs,
          branch: (await currentBranch(abs)) || activeBranch || "",
          detached: false,
          isMain: abs === path.resolve(entry.gitRoot),
          isActive: true,
        });
      }
    }

    repos.push({
      gitRoot: entry.gitRoot,
      sourcePaths: entry.sourcePaths,
      activePath,
      currentBranch: activeBranch,
      branches,
      worktrees,
      defaultFolder: path.join(entry.gitRoot, ".cursor", "worktrees"),
      suggestedBranch,
    });
  }

  return {
    repos,
    nonGitFolders,
    suggestedBranch,
    issueId: issue.id,
    identifier: issue.identifier,
  };
}

/**
 * @param {vscode.Webview} webview
 * @param {"sidebar" | "editor"} surface
 */
function wireMessages(webview, surface) {
  webview.onDidReceiveMessage(async (message) => {
    try {
      if (message?.type === "ready") {
        void webview.postMessage({ type: "setLocale", locale: getUiLocale() });
        await pushSnapshot(webview);
        if (surface === "editor") {
          panelReady = true;
          flushPendingPanelMessage();
        }
        if (surface === "outputBook") {
          outputBookPanelReady = true;
          flushPendingOutputBookMessage();
        }
        return;
      }

      if (message?.type === "ui.setLocale") {
        const locale = message.locale === "en" ? "en" : "zh";
        await setUiLocale(locale);
        if (message.requestId) {
          void webview.postMessage({
            type: "storeResult",
            requestId: message.requestId,
            ok: true,
            locale,
          });
        }
        return;
      }

      if (message?.type === "openIssueInEditor") {
        openEditorPanel({
          type: "showIssue",
          taskId: message.taskId,
        });
        return;
      }

      if (message?.type === "openViewInEditor") {
        openEditorPanel({
          type: "showView",
          view: message.view || "issues",
          taskId: message.taskId,
          bookId: message.bookId,
          title: message.title,
          section: message.section,
        });
        return;
      }

      if (message?.type === "openOutputBookInEditor") {
        openOutputBookEditor({
          taskId: message.taskId,
          bookId: message.bookId,
          title: message.title,
        });
        return;
      }

      if (message?.type === "openNativeChat") {
        // 仅 fork / 显式 preferExisting:false 时新建；漏传时仍续写议题已绑定的 threadId
        const forceNew = Boolean(message.fork) || message.preferExisting === false;
        await openNativeChat(String(message.taskId || ""), {
          threadId: forceNew ? undefined : message.threadId ? String(message.threadId) : undefined,
          preferExisting: forceNew ? false : true,
          followUpText: message.followUpText ? String(message.followUpText) : "",
          autoSubmit: Boolean(message.autoSubmit),
        });
        // 打开对话后立刻尝试同步到活动列表
        void syncChatForIssue(String(message.taskId || ""), { quiet: true });
        return;
      }

      if (message?.type === "afterWorkComment") {
        const taskId = String(message.taskId || "");
        const feedback = String(message.body || "").trim();
        const syncProcess = Boolean(message.syncProcess);
        const db = await ensureStore();
        const issue = db.getIssue(taskId);
        if (!issue) {
          void vscode.window.showWarningMessage(`议题不存在: ${taskId}`);
          return;
        }
        const threadId = isResumableComposerId(message.threadId)
          ? String(message.threadId).trim()
          : isResumableComposerId(issue.threadId)
            ? String(issue.threadId).trim()
            : "";
        await openNativeChat(taskId, {
          threadId: threadId || undefined,
          preferExisting: Boolean(threadId),
          followUpText: buildWorkCommentFollowUp(issue, feedback, { syncProcess }),
          autoSubmit: true,
        });
        void syncChatForIssue(taskId, { quiet: true });
        return;
      }

      if (message?.type === "clipboard.readImage") {
        try {
          const image = await readClipboardImage();
          void webview.postMessage({
            type: "storeResult",
            requestId: message.requestId,
            ok: true,
            image: image || null,
          });
        } catch (error) {
          void webview.postMessage({
            type: "storeResult",
            requestId: message.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (message?.type === "forkChat") {
        await forkChatForReport(String(message.taskId || ""), {
          commentId: message.commentId ? String(message.commentId) : "",
          bubbleId: message.bubbleId ? String(message.bubbleId) : null,
        });
        return;
      }

      if (message?.type === "watchChatSync") {
        watchChatSyncForIssue(message.taskId ? String(message.taskId) : null);
        return;
      }

      if (message?.type === "syncChat") {
        const result = await syncChatForIssue(String(message.taskId || ""), {
          quiet: Boolean(message.quiet),
        });
        if (message.requestId) {
          void webview.postMessage({
            type: "storeResult",
            requestId: message.requestId,
            ok: Boolean(result?.ok !== false),
            added: result?.added || 0,
            reason: result?.reason,
            error: result?.error,
          });
        }
        return;
      }

      if (message?.type === "batchProcessIssues") {
        const issueIds = Array.isArray(message.issueIds)
          ? message.issueIds.map((item) => String(item || "").trim()).filter(Boolean)
          : [];
        // 自动提交需要更长间隔，避免焦点/粘贴抢跑导致只填不发
        const gapMs = Math.max(1200, Math.min(4000, Number(message.gapMs) || 1800));
        const limit = Math.min(issueIds.length, 5);
        let started = 0;
        let failed = 0;
        const errors = [];
        try {
          const db = await ensureStore();
          db.reloadFromDisk();
          for (let i = 0; i < limit; i += 1) {
            const issueId = issueIds[i];
            const issue = db.getIssue(issueId);
            if (!issue) {
              failed += 1;
              errors.push(`${issueId}: 不存在`);
              continue;
            }
            try {
              const comments = Array.isArray(issue.comments) ? issue.comments : [];
              const lastUser = [...comments]
                .reverse()
                .find(
                  (item) =>
                    item?.kind === "user_comment" ||
                    (item?.authorType === "user" && item?.kind !== "chat_turn"),
                );
              const feedback = String(lastUser?.body || "").trim();
              const threadId = isResumableComposerId(issue.threadId)
                ? String(issue.threadId).trim()
                : "";
              await openNativeChat(issue.identifier || issue.id, {
                threadId: threadId || undefined,
                preferExisting: Boolean(threadId),
                followUpText: buildWorkCommentFollowUp(issue, feedback, { syncProcess: true }),
                autoSubmit: true,
              });
              started += 1;
            } catch (error) {
              failed += 1;
              errors.push(
                `${issue.identifier || issueId}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            if (i < limit - 1) await sleep(gapMs);
          }
          await pushSnapshot();
          if (message.requestId) {
            void webview.postMessage({
              type: "storeResult",
              requestId: message.requestId,
              ok: started > 0 || failed === 0,
              started,
              failed,
              error: errors.length ? errors.slice(0, 3).join("；") : undefined,
            });
          }
        } catch (error) {
          if (message.requestId) {
            void webview.postMessage({
              type: "storeResult",
              requestId: message.requestId,
              ok: false,
              started,
              failed,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return;
      }

      if (message?.type === "syncProperties") {
        const taskId = String(message.taskId || "");
        try {
          const db = await ensureStore();
          db.reloadFromDisk();
          const issue = db.getIssue(taskId);
          if (!issue) {
            throw new Error(`议题不存在: ${taskId}`);
          }
          await pushSnapshot();
          const threadId = isResumableComposerId(issue.threadId)
            ? String(issue.threadId).trim()
            : "";
          let notifiedAgent = false;
          if (threadId) {
            await openNativeChat(taskId, {
              threadId,
              preferExisting: true,
              followUpText: buildSyncPropertiesFollowUp(issue),
              autoSubmit: true,
            });
            void syncChatForIssue(taskId, { quiet: true });
            notifiedAgent = true;
          }
          if (message.requestId) {
            void webview.postMessage({
              type: "storeResult",
              requestId: message.requestId,
              ok: true,
              notifiedAgent,
            });
          }
        } catch (error) {
          if (message.requestId) {
            void webview.postMessage({
              type: "storeResult",
              requestId: message.requestId,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return;
      }

      if (message?.type === "devContext.action") {
        try {
          await handleDevContextAction(String(message.taskId || ""), String(message.action || ""), {
            branch: message.branch ? String(message.branch) : "",
            path: message.path ? String(message.path) : "",
            paths: Array.isArray(message.paths) ? message.paths.map((item) => String(item || "")) : [],
            items: Array.isArray(message.items) ? message.items : [],
          });
          if (message.requestId) {
            void webview.postMessage({ type: "storeResult", requestId: message.requestId, ok: true });
          }
        } catch (error) {
          if (message.requestId) {
            void webview.postMessage({
              type: "storeResult",
              requestId: message.requestId,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          } else {
            throw error;
          }
        }
        return;
      }

      if (message?.type === "git.inspect") {
        try {
          const paths = Array.isArray(message.paths)
            ? message.paths.map((item) => String(item || "").trim()).filter(Boolean)
            : [];
          const repos = await inspectRepos(paths);
          void webview.postMessage({
            type: "storeResult",
            requestId: message.requestId,
            ok: true,
            repos,
          });
        } catch (error) {
          void webview.postMessage({
            type: "storeResult",
            requestId: message.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (message?.type === "git.checkout") {
        try {
          const repo = await checkoutBranch(String(message.path || ""), String(message.branch || ""));
          void webview.postMessage({
            type: "storeResult",
            requestId: message.requestId,
            ok: true,
            repo,
          });
        } catch (error) {
          void webview.postMessage({
            type: "storeResult",
            requestId: message.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (message?.type === "git.createBranch") {
        try {
          const repo = await createAndCheckoutBranch(
            String(message.path || ""),
            String(message.branch || ""),
            { from: message.from ? String(message.from) : "" },
          );
          void webview.postMessage({
            type: "storeResult",
            requestId: message.requestId,
            ok: true,
            repo,
          });
        } catch (error) {
          void webview.postMessage({
            type: "storeResult",
            requestId: message.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (message?.type === "git.commit") {
        try {
          const repo = await commitSelected(String(message.path || ""), {
            files: Array.isArray(message.files) ? message.files.map((item) => String(item || "")) : [],
            message: String(message.message || ""),
            push: Boolean(message.push),
          });
          void webview.postMessage({
            type: "storeResult",
            requestId: message.requestId,
            ok: true,
            repo,
          });
        } catch (error) {
          void webview.postMessage({
            type: "storeResult",
            requestId: message.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (message?.type === "git.listRemoteBranches") {
        try {
          const branches = await listRemoteBranches(String(message.url || ""));
          void webview.postMessage({
            type: "storeResult",
            requestId: message.requestId,
            ok: true,
            branches,
          });
        } catch (error) {
          void webview.postMessage({
            type: "storeResult",
            requestId: message.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (message?.type === "git.cloneOnly") {
        try {
          const gitUrl = String(message.gitUrl || "").trim();
          const branch = String(message.branch || "").trim();
          const cloneDest = String(message.cloneDest || "").trim();
          if (!gitUrl) throw new Error("请填写 git 地址");
          if (!branch) throw new Error("请选择分支");
          if (!cloneDest) throw new Error("请指定克隆目标目录");
          await cloneRepo(gitUrl, cloneDest, { branch });
          void webview.postMessage({
            type: "storeResult",
            requestId: message.requestId,
            ok: true,
            path: cloneDest,
            branch,
            gitUrl,
          });
        } catch (error) {
          void webview.postMessage({
            type: "storeResult",
            requestId: message.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (message?.type === "git.cloneAsContext") {
        try {
          const taskId = String(message.taskId || "").trim();
          const gitUrl = String(message.gitUrl || "").trim();
          const branch = String(message.branch || "").trim();
          const cloneDest = String(message.cloneDest || "").trim();
          if (!taskId) throw new Error("缺少议题编号");
          if (!gitUrl) throw new Error("请填写 git 地址");
          if (!branch) throw new Error("请选择分支");
          if (!cloneDest) throw new Error("请指定克隆目标目录");

          const db = await ensureStore();
          const issue = db.getIssue(taskId);
          if (!issue) throw new Error(`议题不存在: ${taskId}`);

          await cloneRepo(gitUrl, cloneDest, { branch });
          const currentPaths = parseWorktreePaths(issue.worktreePath);
          db.updateIssue(issue.id, {
            worktreePath: serializeWorktreePaths([...currentPaths, cloneDest]),
            gitBranch: branch,
          });
          await pushSnapshot(undefined, webview);
          void webview.postMessage({
            type: "storeResult",
            requestId: message.requestId,
            ok: true,
            path: cloneDest,
            branch,
          });
        } catch (error) {
          void webview.postMessage({
            type: "storeResult",
            requestId: message.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (message?.type === "devContext.prepareCreate") {
        try {
          const payload = await prepareCreateWorktree(String(message.taskId || ""));
          void webview.postMessage({
            type: "storeResult",
            requestId: message.requestId,
            ok: true,
            ...payload,
          });
        } catch (error) {
          void webview.postMessage({
            type: "storeResult",
            requestId: message.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (message?.type === "devContext.pickFolder") {
        const defaultFolder = String(message.defaultFolder || "").trim();
        const defaultUri = defaultFolder
          ? vscode.Uri.file(defaultFolder)
          : vscode.workspace.workspaceFolders?.[0]?.uri;

        // QuickPick 会显示 title / placeHolder（macOS 上 OpenDialog 常常看不到提问文案）
        const choice = await vscode.window.showQuickPick(
          [
            ...(defaultFolder
              ? [
                  {
                    label: "$(folder) 使用当前目录",
                    description: defaultFolder,
                    detail: "独立目录，可与主工作区并行开发、互不冲突",
                    path: defaultFolder,
                  },
                ]
              : []),
            {
              label: "$(file-directory) 浏览选择文件夹…",
              detail: "打开系统文件夹选择器",
              browse: true,
            },
            {
              label: "$(edit) 手动输入路径…",
              detail: "粘贴或输入 worktree 父目录绝对路径",
              edit: true,
            },
          ],
          {
            title: "worktree 路径",
            placeHolder: "请选择 worktree 存放的文件夹（父目录）",
            ignoreFocusOut: true,
          },
        );

        if (!choice) {
          void webview.postMessage({
            type: "storeResult",
            requestId: message.requestId,
            ok: true,
            cancelled: true,
          });
          return;
        }

        /** @type {string | undefined} */
        let pickedPath = choice.path;
        if (choice.browse) {
          const uris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: "选为 worktree 父目录",
            title: "选择 worktree 所在文件夹",
            defaultUri,
          });
          pickedPath = uris?.[0]?.fsPath;
        } else if (choice.edit) {
          const typed = await vscode.window.showInputBox({
            title: "worktree 路径",
            prompt: "独立目录，可与主工作区并行开发、互不冲突",
            value: defaultFolder || defaultUri?.fsPath || "",
            placeHolder: "例如 /Users/you/project/.cursor/worktrees",
            ignoreFocusOut: true,
            validateInput: (value) => (String(value || "").trim() ? null : "路径不能为空"),
          });
          if (typed == null) {
            void webview.postMessage({
              type: "storeResult",
              requestId: message.requestId,
              ok: true,
              cancelled: true,
            });
            return;
          }
          pickedPath = String(typed).trim();
        }

        if (!pickedPath) {
          void webview.postMessage({
            type: "storeResult",
            requestId: message.requestId,
            ok: true,
            cancelled: true,
          });
          return;
        }

        void webview.postMessage({
          type: "storeResult",
          requestId: message.requestId,
          ok: true,
          path: pickedPath,
        });
        return;
      }

      if (message?.type === "toast" && message.text) {
        void vscode.window.showInformationMessage(String(message.text));
        return;
      }

      if (message?.type === "sync.getConfig") {
        const db = await ensureStore();
        void webview.postMessage({
          type: "storeResult",
          requestId: message.requestId,
          ok: true,
          sync: getSyncConfig(),
          dbPath: db.dbPath,
        });
        return;
      }

      if (message?.type === "sync.saveConfig") {
        const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
        const sync = saveSyncConfig({
          mode: payload.mode,
          gitUrl: payload.gitUrl,
          branch: payload.branch,
          scheduleEnabled: payload.scheduleEnabled,
          scheduleHour: payload.scheduleHour,
        });
        void webview.postMessage({
          type: "storeResult",
          requestId: message.requestId,
          ok: true,
          sync,
        });
        return;
      }

      if (message?.type === "sync.push") {
        const db = await ensureStore();
        const result = await pushDbToGit(db, { message: message.commitMessage });
        await pushSnapshot(undefined, webview);
        void webview.postMessage({
          type: "storeResult",
          requestId: message.requestId,
          ok: true,
          ...result,
        });
        return;
      }

      if (message?.type === "sync.pull" || message?.type === "sync.merge") {
        const db = await ensureStore();
        const direction = message.type === "sync.merge" ? "merge" : "pull";
        const confirmed = await vscode.window.showWarningMessage(
          direction === "merge"
            ? "将用 Git 上的数据库覆盖本地（会先备份当前库）。确定继续？"
            : "将从 Git 拉取数据库并覆盖本地（会先备份当前库）。确定继续？",
          { modal: true },
          "继续",
        );
        if (confirmed !== "继续") {
          void webview.postMessage({
            type: "storeResult",
            requestId: message.requestId,
            ok: true,
            cancelled: true,
          });
          return;
        }
        const result = await pullDbFromGit(db, { direction });
        await pushSnapshot(undefined, webview);
        void webview.postMessage({
          type: "storeResult",
          requestId: message.requestId,
          ok: true,
          ...result,
        });
        return;
      }

      if (message?.type === "store.createProject") {
        const db = await ensureStore();
        const payload = { ...(message.payload || {}) };
        const source = String(payload.source || "folders").trim();
        let folders = Array.isArray(payload.folders)
          ? payload.folders.map((item) => String(item || "").trim()).filter(Boolean)
          : [];
        let gitUrls = Array.isArray(payload.gitUrls)
          ? payload.gitUrls.map((item) => String(item || "").trim()).filter(Boolean)
          : [];
        let gitUrl = payload.gitUrl ? String(payload.gitUrl).trim() : null;

        if (source === "git") {
          if (!gitUrl) throw new Error("请填写 git 地址");
          const cloneDest = String(payload.cloneDest || "").trim();
          if (!cloneDest) throw new Error("请指定克隆目标文件夹");
          const branch = payload.branch ? String(payload.branch).trim() : "";
          await cloneRepo(gitUrl, cloneDest, branch ? { branch } : {});
          folders = [...new Set([...folders, cloneDest])];
          gitUrls = [...new Set([gitUrl, ...gitUrls])];
        } else if (!folders.length && !gitUrls.length) {
          throw new Error("请至少选择一个文件夹，或添加 git 仓库");
        }

        if (gitUrl && !gitUrls.includes(gitUrl)) gitUrls = [gitUrl, ...gitUrls];

        const project = db.createProject({
          name: payload.name,
          keyPrefix: payload.keyPrefix,
          folders,
          gitUrls,
        });
        await pushSnapshot(undefined, webview);
        void webview.postMessage({
          type: "storeResult",
          requestId: message.requestId,
          ok: true,
          project,
        });
        return;
      }

      if (message?.type === "store.updateProject") {
        const db = await ensureStore();
        const result = db.updateProject(message.projectId, message.payload || {});
        await pushSnapshot(undefined, webview);
        void webview.postMessage({
          type: "storeResult",
          requestId: message.requestId,
          ok: true,
          project: result.project,
          syncedIssueCount: result.syncedIssueCount || 0,
        });
        return;
      }

      if (message?.type === "ui.confirm") {
        const confirmLabel = String(message.confirmLabel || "确定").trim() || "确定";
        const choice = await vscode.window.showWarningMessage(
          String(message.message || "确认继续？"),
          {
            modal: true,
            detail: message.detail ? String(message.detail) : undefined,
          },
          confirmLabel,
        );
        void webview.postMessage({
          type: "storeResult",
          requestId: message.requestId,
          ok: true,
          confirmed: choice === confirmLabel,
        });
        return;
      }

      if (message?.type === "store.deleteProject") {
        const db = await ensureStore();
        const result = db.deleteProject(message.projectId);
        await pushSnapshot(undefined, webview);
        void webview.postMessage({
          type: "storeResult",
          requestId: message.requestId,
          ok: true,
          ...result,
          projects: db.listProjects(),
        });
        return;
      }

      if (message?.type === "project.pickFolders") {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: true,
          openLabel: "选择项目文件夹",
          title: "选择一个或多个项目文件夹",
          defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        });
        void webview.postMessage({
          type: "storeResult",
          requestId: message.requestId,
          ok: true,
          cancelled: !uris?.length,
          folders: (uris || []).map((uri) => uri.fsPath),
        });
        return;
      }

      if (message?.type === "project.openWorkspace") {
        const db = await ensureStore();
        const project = db.getProject(message.projectId);
        if (!project) throw new Error(`项目不存在: ${message.projectId}`);
        const folders = (Array.isArray(project.folders) ? project.folders : [])
          .map((item) => String(item || "").trim())
          .filter((item) => item && fs.existsSync(item));
        if (!folders.length) {
          void vscode.window.showWarningMessage("该项目尚未绑定有效文件夹");
          return;
        }
        if (folders.length === 1) {
          await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(folders[0]), true);
          return;
        }
        const workspaceDir = path.join(os.homedir(), ".cursor-taskboard", "workspaces");
        fs.mkdirSync(workspaceDir, { recursive: true });
        const safeId = String(project.keyPrefix || project.id || "project").replace(/[^\w.-]+/g, "_");
        const workspaceFile = path.join(workspaceDir, `project-${safeId}.code-workspace`);
        const content = {
          folders: folders.map((folderPath) => ({
            path: folderPath,
            name: path.basename(folderPath),
          })),
        };
        fs.writeFileSync(workspaceFile, `${JSON.stringify(content, null, 2)}\n`, "utf8");
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(workspaceFile), true);
        return;
      }

      if (message?.type === "project.pickCloneDest") {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: "选择父目录",
          title: "选择 git clone 的父目录",
          defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        });
        void webview.postMessage({
          type: "storeResult",
          requestId: message.requestId,
          ok: true,
          cancelled: !uris?.length,
          folder: uris?.[0]?.fsPath || null,
        });
        return;
      }

      if (message?.type === "store.addIssueAttachments") {
        const db = await ensureStore();
        const issueRef = db.getIssue(message.taskId);
        if (!issueRef) throw new Error(`议题不存在: ${message.taskId}`);
        const raw = Array.isArray(message.attachments) ? message.attachments : [];
        const saved = saveAttachments(issueRef.id, `issue-${Date.now().toString(36)}`, raw);
        if (!saved.length) throw new Error("没有可保存的附件");
        const next = [...(issueRef.attachments || []), ...saved];
        const issue = db.updateIssue(issueRef.id, { attachments: next });
        await pushSnapshot(undefined, webview);
        void webview.postMessage({
          type: "storeResult",
          requestId: message.requestId,
          ok: true,
          issue: enrichIssueForWebview(issue, webview),
        });
        return;
      }

      if (message?.type === "store.removeIssueAttachment") {
        const db = await ensureStore();
        const issueRef = db.getIssue(message.taskId);
        if (!issueRef) throw new Error(`议题不存在: ${message.taskId}`);
        const attachmentId = String(message.attachmentId || "").trim();
        const current = Array.isArray(issueRef.attachments) ? issueRef.attachments : [];
        const target = current.find((item) => item.id === attachmentId);
        const next = current.filter((item) => item.id !== attachmentId);
        if (target?.relPath && attachmentsRootUri && !String(target.relPath).includes("..")) {
          const filePath = path.join(attachmentsRootUri.fsPath, ...String(target.relPath).split("/"));
          try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          } catch {
            // ignore cleanup failure
          }
        }
        const issue = db.updateIssue(issueRef.id, { attachments: next });
        await pushSnapshot(undefined, webview);
        void webview.postMessage({
          type: "storeResult",
          requestId: message.requestId,
          ok: true,
          issue: enrichIssueForWebview(issue, webview),
        });
        return;
      }

      if (message?.type === "attachment.open") {
        const relPath = String(message.relPath || "").trim();
        if (!relPath || relPath.includes("..") || !attachmentsRootUri) {
          void vscode.window.showWarningMessage("附件路径无效");
          return;
        }
        const fileUri = vscode.Uri.file(path.join(attachmentsRootUri.fsPath, ...relPath.split("/")));
        if (!fs.existsSync(fileUri.fsPath)) {
          void vscode.window.showWarningMessage("附件文件不存在");
          return;
        }
        await vscode.commands.executeCommand("vscode.open", fileUri);
        return;
      }

      if (message?.type === "outputs.summarizeBook") {
        const db = await ensureStore();
        const issueRef = db.getIssue(message.taskId);
        if (!issueRef) throw new Error(`议题不存在: ${message.taskId}`);
        const contextPaths = parseWorktreePaths(issueRef.worktreePath);
        const project = issueRef.projectId ? db.getProject(issueRef.projectId) : null;
        const projectFolders = Array.isArray(project?.folders) ? project.folders.filter(Boolean) : [];
        const base = contextPaths[0] || projectFolders[0] || "";
        if (!base || !fs.existsSync(base)) {
          throw new Error("请先绑定开发上下文或项目文件夹，再总结产出书");
        }
        const bookRoot = path.join(base, "docs", "product-book");
        const bookTitle =
          String(message.title || "").trim() ||
          `${issueRef.identifier || "议题"} 产品功能书`;
        const { book, issue } = ensureOutputBookOnIssue(db, issueRef, bookRoot, bookTitle);
        await pushSnapshot(undefined, webview);
        void webview.postMessage({
          type: "storeResult",
          requestId: message.requestId,
          ok: true,
          book,
          bookRoot,
          issue: enrichIssueForWebview(issue, webview),
        });
        // 续写/打开对话并注入总结提示
        await openNativeChat(issueRef.identifier || issueRef.id, {
          threadId: issueRef.threadId || undefined,
          preferExisting: Boolean(issueRef.threadId),
          autoSubmit: true,
          followUpText: buildOutputBookSummaryFollowUp(issueRef, bookRoot),
        });
        return;
      }

      if (message?.type === "outputs.pickFolder") {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: "选择目录",
          title: "选择产出书目录",
          defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        });
        if (!uris?.length) {
          void webview.postMessage({
            type: "storeResult",
            requestId: message.requestId,
            ok: true,
            cancelled: true,
          });
          return;
        }
        void webview.postMessage({
          type: "storeResult",
          requestId: message.requestId,
          ok: true,
          folder: uris[0].fsPath,
        });
        return;
      }

      if (message?.type === "outputs.saveConfig") {
        const db = await ensureStore();
        const issueRef = db.getIssue(message.taskId);
        if (!issueRef) throw new Error(`议题不存在: ${message.taskId}`);
        const current = Array.isArray(issueRef.outputs) ? issueRef.outputs : [];
        const incoming = Array.isArray(message.books) ? message.books : [];
        /** @type {any[]} */
        const next = [];
        for (const item of incoming) {
          const id = String(item?.id || "").trim();
          const existing = current.find((book) => book.id === id);
          if (!existing) continue;
          const rootPath = String(item?.rootPath || "").trim();
          const title = String(item?.title || "").trim() || existing.title || path.basename(rootPath) || "产出书";
          if (!rootPath) throw new Error("产出书路径不能为空");
          if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
            throw new Error(`目录不存在: ${rootPath}`);
          }
          next.push(
            scanOutputBook(rootPath, {
              id: existing.id,
              createdAt: existing.createdAt,
              title,
            }),
          );
        }
        const issue = db.updateIssue(issueRef.id, { outputs: next });
        await pushSnapshot(undefined, webview);
        void webview.postMessage({
          type: "storeResult",
          requestId: message.requestId,
          ok: true,
          issue: enrichIssueForWebview(issue, webview),
        });
        return;
      }

      if (message?.type === "outputs.pickBook") {
        const db = await ensureStore();
        const issueRef = db.getIssue(message.taskId);
        if (!issueRef) throw new Error(`议题不存在: ${message.taskId}`);
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: "绑定产出书",
          title: "选择已有产出目录书（含各章节 .md）",
          defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        });
        if (!uris?.length) {
          void webview.postMessage({
            type: "storeResult",
            requestId: message.requestId,
            ok: true,
            cancelled: true,
          });
          return;
        }
        const book = scanOutputBook(uris[0].fsPath);
        if (!book.chapters.length) {
          throw new Error("该目录下没有找到 .md 章节文件");
        }
        const { book: nextBook, outputs } = upsertIssueOutputBook(issueRef, book);
        const issue = db.updateIssue(issueRef.id, { outputs });
        await pushSnapshot(undefined, webview);
        void webview.postMessage({
          type: "storeResult",
          requestId: message.requestId,
          ok: true,
          book: nextBook,
          issue: enrichIssueForWebview(issue, webview),
        });
        return;
      }

      if (message?.type === "outputs.refreshBook") {
        const db = await ensureStore();
        const issueRef = db.getIssue(message.taskId);
        if (!issueRef) throw new Error(`议题不存在: ${message.taskId}`);
        const bookId = String(message.bookId || "").trim();
        const current = Array.isArray(issueRef.outputs) ? issueRef.outputs : [];
        const existing = current.find((item) => item.id === bookId);
        if (!existing) throw new Error("产出书不存在");
        const book = scanOutputBook(existing.rootPath, {
          id: existing.id,
          createdAt: existing.createdAt,
        });
        const next = current.map((item) => (item.id === bookId ? book : item));
        const issue = db.updateIssue(issueRef.id, { outputs: next });
        await pushSnapshot(undefined, webview);
        void webview.postMessage({
          type: "storeResult",
          requestId: message.requestId,
          ok: true,
          book,
          issue: enrichIssueForWebview(issue, webview),
        });
        return;
      }

      if (message?.type === "outputs.readChapter") {
        const filePath = String(message.path || "").trim();
        const rootPath = String(message.rootPath || "").trim();
        if (!filePath || !rootPath) throw new Error("缺少章节路径");
        const safePath = assertPathInsideRoot(filePath, rootPath);
        if (!fs.existsSync(safePath)) throw new Error("章节文件不存在");
        const content = fs.readFileSync(safePath, "utf8");
        void webview.postMessage({
          type: "storeResult",
          requestId: message.requestId,
          ok: true,
          content,
          path: safePath,
        });
        return;
      }

      if (message?.type === "outputs.openChapter") {
        const filePath = String(message.path || "").trim();
        const rootPath = String(message.rootPath || "").trim();
        if (!filePath || !rootPath) {
          void vscode.window.showWarningMessage("章节路径无效");
          return;
        }
        try {
          const safePath = assertPathInsideRoot(filePath, rootPath);
          if (!fs.existsSync(safePath)) {
            void vscode.window.showWarningMessage("章节文件不存在");
            return;
          }
          await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(safePath));
        } catch (error) {
          void vscode.window.showWarningMessage(
            error instanceof Error ? error.message : "打开章节失败",
          );
        }
        return;
      }

      if (message?.type === "store.createIssue") {
        const db = await ensureStore();
        const issue = db.createIssue(message.payload || {});
        await pushSnapshot(undefined, webview);
        void webview.postMessage({
          type: "storeResult",
          requestId: message.requestId,
          ok: true,
          issue: enrichIssueForWebview(issue, webview),
        });
        return;
      }

      if (message?.type === "store.updateIssue") {
        const db = await ensureStore();
        const issue = db.updateIssue(message.taskId, message.payload || {});
        await pushSnapshot(undefined, webview);
        void webview.postMessage({ type: "storeResult", requestId: message.requestId, ok: true, issue });
        return;
      }

      if (message?.type === "store.duplicateIssue") {
        const db = await ensureStore();
        const issue = db.duplicateIssue(message.taskId);
        await pushSnapshot(undefined, webview);
        void webview.postMessage({ type: "storeResult", requestId: message.requestId, ok: true, issue });
        return;
      }

      if (message?.type === "store.addComment") {
        const db = await ensureStore();
        const payload = { ...(message.payload || {}) };
        const rawAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
        const issueRef = db.getIssue(message.taskId);
        if (!issueRef) throw new Error(`议题不存在: ${message.taskId}`);
        const commentId =
          String(payload.id || "").trim() ||
          `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        const attachments = saveCommentAttachments(issueRef.id, commentId, rawAttachments);
        delete payload.dataBase64;
        const issue = db.addComment(message.taskId, {
          ...payload,
          id: commentId,
          attachments,
        });
        await pushSnapshot(undefined, webview);
        void webview.postMessage({
          type: "storeResult",
          requestId: message.requestId,
          ok: true,
          issue: enrichIssueForWebview(issue, webview),
        });
        return;
      }

      if (message?.type === "store.addRelation") {
        const db = await ensureStore();
        const issue = db.addRelation(message.taskId, message.payload || {});
        await pushSnapshot(undefined, webview);
        void webview.postMessage({ type: "storeResult", requestId: message.requestId, ok: true, issue });
        return;
      }

      if (message?.type === "store.removeRelation") {
        const db = await ensureStore();
        const issue = db.removeRelation(message.taskId, message.relationId);
        await pushSnapshot(undefined, webview);
        void webview.postMessage({ type: "storeResult", requestId: message.requestId, ok: true, issue });
        return;
      }

      if (message?.type === "store.getSnapshot") {
        await pushSnapshot(webview);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      void webview.postMessage({
        type: "storeResult",
        requestId: message?.requestId,
        ok: false,
        error: text,
      });
      void vscode.window.showErrorMessage(`Taskboard 存储失败: ${text}`);
    }
  });
}

/**
 * @param {vscode.Webview} webview
 * @param {vscode.Uri} uri
 * @param {"sidebar" | "editor"} surface
 */
function getHtml(webview, uri, surface) {
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(uri, "media", "styles.css"));
  const i18nUri = webview.asWebviewUri(vscode.Uri.joinPath(uri, "media", "i18n.js"));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(uri, "media", "main.js"));
  const nonce = getNonce();
  const locale = getUiLocale();

  return `<!DOCTYPE html>
<html lang="${locale === "zh" ? "zh-CN" : "en"}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Muqi Task</title>
</head>
<body data-surface="${surface}" data-locale="${locale}">
  <div id="app" class="workspace"></div>
  <script nonce="${nonce}" src="${i18nUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

class TaskboardViewProvider {
  /**
   * @param {vscode.Uri} extensionUri
   */
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
  }

  /**
   * @param {vscode.WebviewView} webviewView
   */
  resolveWebviewView(webviewView) {
    sidebarView = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: webviewLocalRoots(),
    };
    webviewView.webview.html = getHtml(webviewView.webview, this.extensionUri, "sidebar");
    wireMessages(webviewView.webview, "sidebar");
    webviewView.onDidDispose(() => {
      if (sidebarView === webviewView) sidebarView = undefined;
    });
  }
}

function deactivate() {
  if (dbSyncTimer) {
    clearInterval(dbSyncTimer);
    dbSyncTimer = null;
  }
  store?.close();
  store = null;
}

module.exports = { activate, deactivate };
