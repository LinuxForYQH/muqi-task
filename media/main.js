(() => {
  const vscode = acquireVsCodeApi();
  const surface = document.body.getAttribute("data-surface") || "editor";
  const isSidebar = surface === "sidebar";
  const I18n = window.TaskboardI18n || {
    detectLocale: (lang) => (String(lang || "").toLowerCase().startsWith("zh") ? "zh" : "en"),
    normalize: (locale) => (locale === "en" ? "en" : "zh"),
    t: (_locale, key) => key,
  };

  const BOARD_COLUMNS = ["todo", "in_progress", "blocked", "in_review"];
  const QUERY_STATUSES = ["backlog", "done", "canceled"];
  const STATUS_ORDER = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"];
  const STATUS_TONES = {
    todo: "todo",
    in_progress: "progress",
    blocked: "blocked",
    in_review: "review",
    backlog: "backlog",
    done: "done",
    canceled: "backlog",
  };

  const ALL_PROJECT_ID = "__all__";

  /** @param {string} key @param {Record<string, string | number>} [vars] */
  function t(key, vars) {
    return I18n.t(state.locale || "zh", key, vars);
  }

  /** @param {string} status */
  function statusTone(status) {
    return STATUS_TONES[status] || "todo";
  }

  /** Compatibility shape: STATUS[x].label / .tone */
  const STATUS = new Proxy(
    {},
    {
      get(_target, prop) {
        const key = String(prop);
        if (!(key in STATUS_TONES)) {
          return { label: key, tone: "todo" };
        }
        return { label: t(`status.${key}`), tone: statusTone(key) };
      },
      ownKeys() {
        return STATUS_ORDER.slice();
      },
      getOwnPropertyDescriptor(_target, prop) {
        const key = String(prop);
        if (!(key in STATUS_TONES)) return undefined;
        return {
          enumerable: true,
          configurable: true,
          value: { label: t(`status.${key}`), tone: statusTone(key) },
        };
      },
    },
  );

  const PRIORITY_KEYS = ["none", "urgent", "high", "medium", "low"];
  const PRIORITY_LABELS = new Proxy(
    {},
    {
      get(_target, prop) {
        const key = String(prop);
        return t(`priority.${key}`);
      },
      ownKeys() {
        return PRIORITY_KEYS;
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (!PRIORITY_KEYS.includes(String(prop))) return undefined;
        return { enumerable: true, configurable: true, value: t(`priority.${String(prop)}`) };
      },
    },
  );

  /** 列表状态分组默认全部折叠 */
  function defaultCollapsedGroups() {
    return Object.fromEntries(STATUS_ORDER.map((status) => [status, true]));
  }

  const state = {
    ready: false,
    dbPath: "",
    locale: I18n.normalize(
      document.body.getAttribute("data-locale") ||
        I18n.detectLocale(navigator.language || navigator.languages?.[0] || "en"),
    ),
    projects: [],
    tasks: [],
    projectId: ALL_PROJECT_ID, // 默认展示全部项目
    view: "list",
    queryStatus: "backlog",
    search: "",
    projectQuery: "",
    selectedTaskId: null,
    projectMenuOpen: false,
    dragTaskId: null,
    editingDescription: false,
    contextMenu: null, // { taskId, x, y, submenu }
    priorityMenuTaskId: null,
    /** @type {Record<string, boolean>} status -> collapsed；默认全部折叠 */
    collapsedGroups: defaultCollapsedGroups(),
    /** @type {{ id: string, authorName: string, authorType?: string, body: string, attachments?: any[], threadId?: string | null } | null} */
    replyTo: null,
    /**
     * 评论框待发送截图（粘贴/选图预览）
     * @type {Array<{ id: string, mime: string, name: string, dataUrl: string }>}
     */
    pendingCommentImages: [],
    /** 评论框正文草稿（render 后需保留） */
    commentDraft: "",
    /** 下一次 render 后滚到并聚焦底部评论框 */
    focusCommentInput: false,
    /** @type {{ type: "blocked_by" | "blocks" | "related", query: string } | null} */
    relationPicker: null,
    /** @type {{ query: string } | null} */
    labelPicker: null,
    /** @type {Record<string, boolean>} work-report commentId -> expanded */
    expandedReports: {},
    /**
     * 创建 worktree 前端向导
     * @type {null | {
     *   taskId: string,
     *   step: 1 | 2,
     *   gitRoot: string,
     *   folderPath: string,
     *   branches: string[],
     *   suggestedBranch: string,
     *   branchQuery: string,
     *   selectedBranch: string,
     *   loading: boolean,
     *   busy: boolean,
     *   error: string,
     * }}
     */
    worktreeWizard: null,
    /**
     * 开发上下文 Git 提交弹窗
     * @type {null | {
     *   taskId: string,
     *   loading: boolean,
     *   busy: boolean,
     *   error: string,
     *   message: string,
     *   activeIndex: number,
     *   creatingBranch: boolean,
     *   newBranchName: string,
     *   busyMode: "" | "commit" | "push",
     *   repos: Array<{
     *     folderPath: string,
     *     isGit: boolean,
     *     error: string,
     *     gitRoot: string,
     *     branch: string,
     *     branches: string[],
     *     files: Array<{ path: string, oldPath?: string, code: string, label: string, selected: boolean }>,
     *   }>,
     * }}
     */
    gitDialog: null,
    /**
     * 选择 git → 选分支 → clone（议题上下文或项目）
     * @type {null | {
     *   mode: "issue" | "project",
     *   taskId: string,
     *   gitUrl: string,
     *   cloneParent: string,
     *   cloneFolderName: string,
     *   branches: string[],
     *   selectedBranch: string,
     *   fetching: boolean,
     *   busy: boolean,
     *   error: string,
     * }}
     */
    gitSelectDialog: null,
    /**
     * 新建/编辑项目表单
     * @type {null | {
     *   mode: "create" | "edit",
     *   projectId: string | null,
     *   name: string,
     *   keyPrefix: string,
     *   source: "folders" | "git",
     *   folders: string[],
     *   gitUrls: string[],
     *   gitUrl: string,
     *   cloneParent: string,
     *   cloneFolderName: string,
     *   busy: boolean,
     *   error: string,
     * }}
     */
    projectWizard: null,
    /**
     * 同步配置（全局 DB 备份）
     * @type {null | {
     *   mode: "local" | "git",
     *   gitUrl: string,
     *   branch: string,
     *   scheduleEnabled: boolean,
     *   scheduleHour: number,
     *   lastSyncAt: string | null,
     *   lastPushAt: string | null,
     *   lastSyncDirection: string | null,
     *   lastSyncError: string | null,
     *   dbPath: string,
     *   busy: boolean,
     *   message: string,
     *   error: string,
     * }}
     */
    syncConfig: null,
    /** 设置页子项：null 为选项列表，sync 为同步 db */
    settingsSection: null,
    /** 活动流当前展示的对话条数（从最新往前）；默认预览条数 */
    activityShowCount: 5,
    /** 详情右侧属性栏是否向右折叠（默认折叠） */
    propertiesCollapsed: true,
    /** @type {Record<string, boolean>} parentIssueId -> expanded in list */
    expandedSubIssues: {},
    /** @type {{ query: string } | null} */
    parentPicker: null,
    /**
     * 同步属性对话框
     * @type {null | { taskId: string, identifier: string, hasThread: boolean, busy: boolean, error: string }}
     */
    syncPropsDialog: null,
    /**
     * 自动化：扫描有评论的议题并批量打开对话
     * @type {null | {
     *   items: Array<{ id: string, identifier: string, title: string, status: string, hasThread: boolean, commentPreview: string, selected: boolean }>,
     *   busy: boolean,
     *   progress: string,
     *   error: string,
     * }}
     */
    automationDialog: null,
    /**
     * 产出目录书查看器
     * @type {null | {
     *   taskId: string,
     *   bookId: string,
     *   title: string,
     *   rootPath: string,
     *   chapters: Array<{ id: string, title: string, path: string, relPath: string }>,
     *   activeChapterId: string | null,
     *   content: string,
     *   busy: boolean,
     *   error: string,
     * }}
     */
    outputBookDialog: null,
    /** 产出书目录侧栏是否折叠 */
    outputBookTocCollapsed: false,
    /**
     * 产出书阅读位置，跨重渲染保留滚动条
     * @type {null | { top: number, tocTop: number | null, bookId: string, chapterId: string }}
     */
    outputBookScroll: null,
    /** @type {null | { taskId: string, bookId: string, title?: string }} */
    pendingOutputBookOpen: null,
    /**
     * 产出书路径配置弹窗
     * @type {null | {
     *   taskId: string,
     *   books: Array<{ id: string, title: string, rootPath: string }>,
     *   busy: boolean,
     *   error: string,
     *   message: string,
     * }}
     */
    outputConfigDialog: null,
  };

  const AUTOMATION_BATCH_LIMIT = 5;
  const AUTOMATION_SCAN_STATUSES = ["in_review", "in_progress", "blocked"];

  const ACTIVITY_PREVIEW_COUNT = 5;
  const ACTIVITY_EXPAND_STEP = 4;

  let submenuIntentTimer = null;
  let contextMenuOutsideHandler = null;

  function clearSubmenuIntent() {
    if (submenuIntentTimer) {
      clearTimeout(submenuIntentTimer);
      submenuIntentTimer = null;
    }
  }

  function clampContextSubmenuPanel(panel) {
    if (!panel) return;
    panel.style.transform = "none";
    const panelRect = panel.getBoundingClientRect();
    let shift = 0;
    if (panelRect.bottom > window.innerHeight - 8) {
      shift = window.innerHeight - 8 - panelRect.bottom;
    } else if (panelRect.top < 8) {
      shift = 8 - panelRect.top;
    }
    if (shift) panel.style.transform = `translateY(${shift}px)`;
  }

  /**
   * 仅切换子菜单时就地更新，避免整页 render + 入场动画造成闪烁
   * @returns {boolean}
   */
  function patchContextSubmenu() {
    const menuEl = app.querySelector(".task-context-menu");
    const menu = state.contextMenu;
    if (!menuEl || !menu) return false;
    const task = state.tasks.find((item) => item.id === menu.taskId);
    if (!task) return false;

    menuEl.querySelectorAll(".context-menu-item-anchor").forEach((anchor) => {
      const btn = anchor.querySelector(":scope > [data-submenu]");
      if (!btn || btn.getAttribute("data-menu-action")) return;
      const name = btn.getAttribute("data-submenu");
      if (!name) return;
      const open = menu.submenu === name;
      btn.setAttribute("data-open", open ? "true" : "false");
      btn.setAttribute("aria-expanded", String(open));

      const oldPanel = anchor.querySelector(":scope > .context-submenu");
      if (oldPanel) oldPanel.remove();
      if (!open) return;

      const html = renderSubmenuPanel(name, task);
      if (!html) return;
      anchor.insertAdjacentHTML("beforeend", html);
      const panel = anchor.querySelector(":scope > .context-submenu");
      if (!panel) return;
      panel.addEventListener("pointerenter", () => clearSubmenuIntent());
      panel.querySelectorAll("[data-menu-action]").forEach((actionBtn) => {
        actionBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          runContextMenuAction(
            task,
            actionBtn.getAttribute("data-menu-action"),
            actionBtn.getAttribute("data-menu-value") || "",
          );
        });
      });
      requestAnimationFrame(() => clampContextSubmenuPanel(panel));
    });
    return true;
  }

  function setContextSubmenu(name) {
    if (!state.contextMenu) return;
    if (state.contextMenu.submenu === name) return;
    state.contextMenu = { ...state.contextMenu, submenu: name || null };
    if (!patchContextSubmenu()) render();
  }

  function scheduleContextSubmenu(name, delay = 120) {
    clearSubmenuIntent();
    if (state.contextMenu?.submenu === name) return;
    submenuIntentTimer = setTimeout(() => {
      submenuIntentTimer = null;
      setContextSubmenu(name);
    }, delay);
  }

  function runContextMenuAction(task, action, value = "") {
    if (!task || !action) return;
    clearSubmenuIntent();
    state.contextMenu = null;
    if (action === "set-status") {
      void persistUpdate(task.id, { status: value, processing: value === "in_progress" });
      return;
    }
    if (action === "set-priority") {
      void persistUpdate(task.id, { priority: value });
      return;
    }
    if (action === "toggle-label") {
      const labels = new Set(task.labels || []);
      if (labels.has(value)) labels.delete(value);
      else labels.add(value);
      void persistUpdate(task.id, { labels: [...labels] });
      return;
    }
    if (action === "edit") {
      openTask(task.id);
      return;
    }
    if (action === "duplicate") {
      void persistDuplicate(task.id);
      return;
    }
    if (action === "copy-id") {
      copyText(task.identifier, `${task.identifier} 已复制`);
      render();
      return;
    }
    if (action === "copy-title") {
      copyText(task.title, "议题标题已复制");
      render();
      return;
    }
    if (action === "copy-md") {
      copyText(`**${task.identifier}** ${task.title}`, "Markdown 已复制");
      render();
      return;
    }
    if (action === "open-chat") {
      vscode.postMessage({
        type: "openNativeChat",
        taskId: task.identifier,
        threadId: task.threadId || undefined,
        preferExisting: Boolean(task.threadId),
      });
      render();
      return;
    }
    if (action === "archive") {
      void persistUpdate(task.id, { status: "canceled", processing: false });
      vscode.postMessage({
        type: "toast",
        text: task.parentIssueId
          ? `已归档子议题 ${task.identifier}（移至「取消」）`
          : `已归档 ${task.identifier}`,
      });
      return;
    }
    render();
  }

  function bindContextMenuOutsideClose(menuEl) {
    if (contextMenuOutsideHandler) {
      document.removeEventListener("pointerdown", contextMenuOutsideHandler, true);
      contextMenuOutsideHandler = null;
    }
    contextMenuOutsideHandler = (event) => {
      if (!state.contextMenu) return;
      if (menuEl.contains(event.target)) return;
      clearSubmenuIntent();
      state.contextMenu = null;
      document.removeEventListener("pointerdown", contextMenuOutsideHandler, true);
      contextMenuOutsideHandler = null;
      render();
    };
    document.addEventListener("pointerdown", contextMenuOutsideHandler, true);
  }

  let requestSeq = 0;
  /** @type {Map<string, { resolve: Function, reject: Function }>} */
  const pendingRequests = new Map();
  let titleSaveTimer = null;
  let descriptionSaveTimer = null;

  function applySnapshot(snapshot) {
    state.ready = true;
    state.dbPath = snapshot.dbPath || "";
    state.projects = snapshot.projects || [];
    state.tasks = snapshot.tasks || [];
    if (state.selectedTaskId && !state.tasks.some((task) => task.id === state.selectedTaskId)) {
      state.selectedTaskId = null;
    }
  }

  function storeRequest(type, payload = {}, options = {}) {
    const requestId = `req-${Date.now()}-${++requestSeq}`;
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 8000;
    return new Promise((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject });
      vscode.postMessage({ type, requestId, ...payload });
      setTimeout(() => {
        if (!pendingRequests.has(requestId)) return;
        pendingRequests.delete(requestId);
        reject(new Error("请求超时"));
      }, timeoutMs);
    });
  }

  function shouldPreserveEditorFocus() {
    const id = document.activeElement?.id;
    return id === "issue-title-input" || id === "issue-description-input" || id === "comment-input";
  }

  async function persistUpdate(taskId, patch, options = {}) {
    const optimistic = state.tasks.find((item) => item.id === taskId);
    if (optimistic) {
      Object.assign(optimistic, patch, { updatedAt: new Date().toISOString() });
      if (patch.status !== undefined) {
        optimistic.processing = patch.status === "in_progress";
      }
    }
    if (!options.silent) render();
    try {
      const result = await storeRequest("store.updateIssue", { taskId, payload: patch });
      if (result.issue) {
        upsertTask(result.issue);
        if (!shouldPreserveEditorFocus()) render();
      }
    } catch (error) {
      vscode.postMessage({ type: "toast", text: error.message || "更新失败" });
      vscode.postMessage({ type: "store.getSnapshot" });
    }
  }

  async function persistCreate(payload) {
    try {
      const result = await storeRequest("store.createIssue", { payload });
      if (result.issue) {
        upsertTask(result.issue);
        render();
      }
      return result.issue;
    } catch (error) {
      vscode.postMessage({ type: "toast", text: error.message || "创建失败" });
      return null;
    }
  }

  async function persistDuplicate(taskId) {
    try {
      const result = await storeRequest("store.duplicateIssue", { taskId });
      if (result.issue) {
        upsertTask(result.issue);
        render();
      }
      return result.issue;
    } catch (error) {
      vscode.postMessage({ type: "toast", text: error.message || "复制失败" });
      return null;
    }
  }

  async function persistComment(taskId, body, options = {}) {
    const parentCommentId = options.parentCommentId || null;
    const replyThreadId = options.threadId || null;
    const notifyAgent = Boolean(options.notifyAgent);
    const syncProcess = Boolean(options.syncProcess);
    const pendingImages = Array.isArray(options.attachments) ? options.attachments : [];
    const attachments = pendingImages.map((item) => ({
      mime: item.mime,
      name: item.name,
      dataBase64: item.dataUrl,
    }));
    try {
      const result = await storeRequest("store.addComment", {
        taskId,
        payload: {
          body,
          parentCommentId,
          attachments,
        },
      });
      if (result.issue) {
        upsertTask(result.issue);
        state.replyTo = null;
        state.pendingCommentImages = [];
        state.commentDraft = "";
        render();
        if (notifyAgent) {
          const commentInput = document.getElementById("comment-input");
          if (commentInput && typeof commentInput.blur === "function") commentInput.blur();
          const task = state.tasks.find((item) => item.id === taskId) || result.issue;
          const imageNote = attachments.length ? `\n\n（附 ${attachments.length} 张截图，请 issue_get 查看）` : "";
          vscode.postMessage({
            type: "afterWorkComment",
            taskId: task?.identifier || taskId,
            threadId: replyThreadId || task?.threadId || "",
            body: `${body || "（仅截图反馈）"}${imageNote}`,
            syncProcess,
          });
        }
        return result.issue;
      }
      return null;
    } catch (error) {
      vscode.postMessage({ type: "toast", text: error.message || "评论失败" });
      return null;
    }
  }

  function renderCommentAttachments(attachments) {
    const items = Array.isArray(attachments) ? attachments : [];
    if (!items.length) return "";
    return `
      <div class="comment-attachments">
        ${items
          .map((item) => {
            const src = String(item.url || "").trim();
            const isImage = String(item.mime || "").startsWith("image/");
            if (!src) {
              return `<div class="comment-attachment-missing">${escapeHtml(item.name || "截图")}</div>`;
            }
            if (!isImage) {
              return `
                <button type="button" class="comment-attachment-file" data-action="open-attachment" data-rel-path="${escapeHtml(item.relPath || "")}" title="${escapeHtml(item.name || "附件")}">
                  ${ICONS.paperclip}
                  <span>${escapeHtml(item.name || "附件")}</span>
                </button>
              `;
            }
            return `
              <a class="comment-attachment" href="${escapeHtml(src)}" title="${escapeHtml(item.name || "截图")}" target="_blank" rel="noreferrer">
                <img src="${escapeHtml(src)}" alt="${escapeHtml(item.name || "截图")}" loading="lazy" />
              </a>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function renderIssueContextSection(task) {
    const linked = task.projectId
      ? (state.projects || []).find((item) => item.id === task.projectId)
      : null;
    const linkedFolders = Array.isArray(linked?.folders) ? linked.folders.filter(Boolean) : [];
    const worktreePaths = parseWorktreePaths(task.worktreePath);
    return `
      <section class="issue-context-section" aria-label="项目与开发上下文">
        <div class="issue-context-grid">
          <div class="issue-context-block">
            <header class="issue-context-heading">
              <h2>${escapeHtml(t("detail.projectLink"))}</h2>
            </header>
            <div class="project-assoc-editor issue-context-editor">
              <select data-field="projectId" aria-label="项目关联">
                <option value=""${!task.projectId ? " selected" : ""}>${escapeHtml(t("detail.noProject"))}</option>
                ${(state.projects || [])
                  .map(
                    (project) =>
                      `<option value="${escapeHtml(project.id)}"${task.projectId === project.id ? " selected" : ""}>${escapeHtml(project.name)}</option>`,
                  )
                  .join("")}
              </select>
              ${
                !task.projectId
                  ? `<div class="devctx-empty">未关联项目</div>`
                  : !linked
                    ? `<div class="devctx-empty">项目不存在或已删除</div>`
                    : `<div class="project-assoc-meta" title="${escapeHtml([linked.name, linked.keyPrefix ? `前缀 ${linked.keyPrefix}` : "", ...(linkedFolders.length ? linkedFolders : ["未绑定文件夹"])].filter(Boolean).join(" · "))}">
                        <span>前缀 ${escapeHtml(linked.keyPrefix || "-")}</span>
                        ${
                          linkedFolders.length
                            ? linkedFolders
                                .map(
                                  (folder) =>
                                    `<span class="devctx-folder-chip" title="${escapeHtml(folder)}">
                                      <span class="devctx-folder-icon">${ICONS.folder}</span>
                                      <span class="devctx-folder-name">${escapeHtml(folderDisplayName(folder) || folder)}</span>
                                    </span>`,
                                )
                                .join("")
                            : `<span class="devctx-empty">未绑定文件夹</span>`
                        }
                      </div>`
              }
            </div>
          </div>
          <div class="issue-context-block">
            <header class="issue-context-heading">
              <h2>${escapeHtml(t("detail.devContext"))}</h2>
              <button
                type="button"
                class="devctx-btn issue-context-heading-action"
                data-action="git-commit-open"
                data-task-id="${escapeHtml(task.id)}"
                ${worktreePaths.length ? "" : "disabled"}
                title="${escapeHtml(t("detail.gitCommitTitle"))}"
              >${escapeHtml(t("detail.gitCommit"))}</button>
            </header>
            <div class="devctx-editor issue-context-editor">
              ${
                worktreePaths.length
                  ? `<div class="devctx-folder-list">
                      ${worktreePaths
                        .map((folderPath) => {
                          const display = contextFolderDisplay(folderPath, worktreePaths);
                          return `<span class="devctx-folder-chip${display.isWorktree ? " is-worktree" : ""}" title="${escapeHtml(display.title)}">
                            <button
                              type="button"
                              class="devctx-folder-btn"
                              data-action="devctx-open"
                              data-task-id="${escapeHtml(task.id)}"
                              data-path="${escapeHtml(folderPath)}"
                              aria-label="${escapeHtml(display.label)}"
                            >
                              <span class="devctx-folder-icon">${ICONS.folder}</span>
                              ${renderContextFolderName(display)}
                            </button>
                            <button
                              type="button"
                              class="devctx-path-remove"
                              data-action="devctx-remove-path"
                              data-task-id="${escapeHtml(task.id)}"
                              data-path="${escapeHtml(folderPath)}"
                              aria-label="${escapeHtml(display.label)}"
                            >×</button>
                          </span>`;
                        })
                        .join("")}
                    </div>`
                  : `<div class="devctx-empty">${escapeHtml(t("detail.unbound"))}</div>`
              }
              <div class="devctx-actions">
                <button type="button" class="devctx-btn primary" data-action="devctx-pick" data-task-id="${escapeHtml(task.id)}">${escapeHtml(t("detail.pickFolder"))}</button>
                <button type="button" class="devctx-btn" data-action="git-select-open" data-task-id="${escapeHtml(task.id)}">${escapeHtml(t("detail.selectGit"))}</button>
                <button type="button" class="devctx-btn" data-action="devctx-create" data-task-id="${escapeHtml(task.id)}">${escapeHtml(t("detail.worktreeManage"))}</button>
                <button
                  type="button"
                  class="devctx-btn devctx-btn-workspace"
                  data-action="devctx-open-workspace"
                  data-task-id="${escapeHtml(task.id)}"
                  ${worktreePaths.length ? "" : "disabled"}
                  title="${escapeHtml(t("detail.openWorkspaceTitle"))}"
                >${escapeHtml(t("detail.openWorkspace"))}</button>
              </div>
            </div>
          </div>
        </div>
      </section>
    `;
  }

  function renderIssueOutputs(task) {
    const items = Array.isArray(task?.outputs) ? task.outputs : [];
    return `
      <section class="issue-outputs" aria-label="${escapeHtml(t("outputs.title"))}">
        <header class="attachments-heading outputs-heading">
          <div>
            <h2>${escapeHtml(t("outputs.title"))}</h2>
            <span>${items.length}</span>
          </div>
          <div class="outputs-heading-actions">
            <button
              class="ghost-link outputs-config-btn"
              type="button"
              data-action="outputs-config-open"
              data-task-id="${escapeHtml(task.id)}"
              title="${escapeHtml(t("outputs.configHint"))}"
            >
              ${ICONS.gear}
              <span>${escapeHtml(t("outputs.config"))}</span>
            </button>
            <button class="ghost-link" type="button" data-action="outputs-add" data-task-id="${escapeHtml(task.id)}" title="${escapeHtml(t("outputs.addHint"))}">
              ${ICONS.book}
              <span>${escapeHtml(t("outputs.add"))}</span>
            </button>
          </div>
        </header>
        ${
          items.length
            ? `<div class="issue-output-list" role="list">
                ${items
                  .map((book) => {
                    const chapterCount = Array.isArray(book.chapters) ? book.chapters.length : 0;
                    return `
                      <div class="issue-output-card" role="listitem">
                        <button
                          type="button"
                          class="issue-output-main"
                          data-action="outputs-open"
                          data-task-id="${escapeHtml(task.id)}"
                          data-book-id="${escapeHtml(book.id)}"
                          title="${escapeHtml(book.rootPath || book.title || "")}"
                        >
                          <span class="issue-output-icon" aria-hidden="true">${ICONS.book}</span>
                          <span class="issue-output-text">
                            <strong>${escapeHtml(book.title || t("outputs.untitled"))}</strong>
                            <span>${escapeHtml(t("outputs.chapterCount", { n: chapterCount }))}</span>
                          </span>
                        </button>
                        <div class="issue-output-actions">
                          <button
                            type="button"
                            class="issue-output-icon-btn"
                            data-action="outputs-refresh"
                            data-task-id="${escapeHtml(task.id)}"
                            data-book-id="${escapeHtml(book.id)}"
                            title="${escapeHtml(t("outputs.refresh"))}"
                          >↻</button>
                          <button
                            type="button"
                            class="issue-attachment-remove"
                            data-action="outputs-remove"
                            data-task-id="${escapeHtml(task.id)}"
                            data-book-id="${escapeHtml(book.id)}"
                            title="${escapeHtml(t("outputs.remove"))}"
                          >×</button>
                        </div>
                      </div>
                    `;
                  })
                  .join("")}
              </div>`
            : `<p class="attachments-empty">${escapeHtml(t("outputs.empty"))}</p>`
        }
      </section>
    `;
  }

  function openOutputConfigDialog(task) {
    if (!task) return;
    const books = (Array.isArray(task.outputs) ? task.outputs : []).map((book) => ({
      id: book.id,
      title: book.title || t("outputs.untitled"),
      rootPath: book.rootPath || "",
    }));
    state.outputConfigDialog = {
      taskId: task.id,
      books,
      busy: false,
      error: "",
      message: "",
    };
    render();
  }

  function readOutputConfigFromDom() {
    const dialog = state.outputConfigDialog;
    if (!dialog) return [];
    return (dialog.books || []).map((book) => {
      const titleInput = app.querySelector(`[data-output-config-title="${book.id}"]`);
      const pathInput = app.querySelector(`[data-output-config-path="${book.id}"]`);
      return {
        id: book.id,
        title:
          titleInput instanceof HTMLInputElement
            ? titleInput.value.trim()
            : String(book.title || "").trim(),
        rootPath:
          pathInput instanceof HTMLInputElement
            ? pathInput.value.trim()
            : String(book.rootPath || "").trim(),
      };
    });
  }

  function renderOutputConfigDialog() {
    const dialog = state.outputConfigDialog;
    if (!dialog) return "";
    const books = Array.isArray(dialog.books) ? dialog.books : [];
    return `
      <div class="sync-props-backdrop" data-output-config-backdrop="1" role="presentation">
        <div class="sync-props-dialog output-config-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(t("outputs.configTitle"))}">
          <header class="sync-props-header">
            <div>
              <h3>${escapeHtml(t("outputs.configTitle"))}</h3>
              <p>${escapeHtml(t("outputs.configDesc"))}</p>
            </div>
            <button type="button" class="sync-props-close" data-action="outputs-config-close" aria-label="${escapeHtml(t("outputs.close"))}" ${dialog.busy ? "disabled" : ""}>×</button>
          </header>
          <div class="sync-props-body output-config-body">
            ${
              books.length
                ? `<div class="output-config-list">
                    ${books
                      .map(
                        (book, index) => `
                          <article class="output-config-row" data-book-id="${escapeHtml(book.id)}">
                            <div class="output-config-row-head">
                              <strong>${escapeHtml(t("outputs.configBookN", { n: index + 1 }))}</strong>
                              <button
                                type="button"
                                class="ghost-link"
                                data-action="outputs-config-remove"
                                data-book-id="${escapeHtml(book.id)}"
                                ${dialog.busy ? "disabled" : ""}
                              >${escapeHtml(t("outputs.configRemove"))}</button>
                            </div>
                            <label class="project-field">
                              <span>${escapeHtml(t("outputs.configName"))}</span>
                              <input
                                type="text"
                                data-output-config-title="${escapeHtml(book.id)}"
                                value="${escapeHtml(book.title || "")}"
                                ${dialog.busy ? "disabled" : ""}
                              />
                            </label>
                            <label class="project-field">
                              <span>${escapeHtml(t("outputs.configPath"))}</span>
                              <div class="output-config-path-row">
                                <input
                                  type="text"
                                  data-output-config-path="${escapeHtml(book.id)}"
                                  value="${escapeHtml(book.rootPath || "")}"
                                  placeholder="${escapeHtml(t("outputs.configPathPlaceholder"))}"
                                  ${dialog.busy ? "disabled" : ""}
                                />
                                <button
                                  type="button"
                                  class="devctx-btn"
                                  data-action="outputs-config-pick"
                                  data-book-id="${escapeHtml(book.id)}"
                                  ${dialog.busy ? "disabled" : ""}
                                >${escapeHtml(t("outputs.configPick"))}</button>
                              </div>
                            </label>
                          </article>`,
                      )
                      .join("")}
                  </div>`
                : `<p class="attachments-empty">${escapeHtml(t("outputs.configEmpty"))}</p>`
            }
            ${dialog.error ? `<div class="sync-props-error">${escapeHtml(dialog.error)}</div>` : ""}
            ${dialog.message ? `<div class="sync-ok">${escapeHtml(dialog.message)}</div>` : ""}
          </div>
          <footer class="sync-props-footer output-config-footer">
            <button
              type="button"
              class="devctx-btn"
              data-action="outputs-bind"
              data-task-id="${escapeHtml(dialog.taskId)}"
              title="${escapeHtml(t("outputs.bindHint"))}"
              ${dialog.busy ? "disabled" : ""}
            >${escapeHtml(t("outputs.bind"))}</button>
            <div class="output-config-footer-right">
              <button type="button" class="devctx-btn" data-action="outputs-config-close" ${dialog.busy ? "disabled" : ""}>${escapeHtml(t("common.cancel"))}</button>
              <button type="button" class="devctx-btn primary" data-action="outputs-config-save" ${dialog.busy || !books.length ? "disabled" : ""}>
                ${dialog.busy ? escapeHtml(t("outputs.configSaving")) : escapeHtml(t("outputs.configSave"))}
              </button>
            </div>
          </footer>
        </div>
      </div>
    `;
  }

  function renderOutputBookPage() {
    const dialog = state.outputBookDialog;
    if (!dialog) {
      return `
        <section class="output-book-page" aria-label="${escapeHtml(t("outputs.title"))}">
          <div class="output-book-empty">${escapeHtml(t("outputs.missing"))}</div>
        </section>
      `;
    }
    const chapters = Array.isArray(dialog.chapters) ? dialog.chapters : [];
    const activeId = dialog.activeChapterId || chapters[0]?.id || "";
    const tocCollapsed = Boolean(state.outputBookTocCollapsed);
    const bookTitle = dialog.title || t("outputs.untitled");
    return `
      <section class="output-book-page${tocCollapsed ? " is-toc-collapsed" : ""}" aria-label="${escapeHtml(bookTitle)}">
        <div class="output-book-body">
          ${
            tocCollapsed
              ? `<button
                  type="button"
                  class="output-book-toc-expand-rail"
                  data-action="outputs-toggle-toc"
                  title="${escapeHtml(t("outputs.expandToc"))}"
                  aria-expanded="false"
                  aria-label="${escapeHtml(t("outputs.expandToc"))}"
                >
                  <span class="output-book-toc-expand-icon" aria-hidden="true">${ICONS.chevronRight}</span>
                  <span class="output-book-toc-expand-label">${escapeHtml(t("outputs.toc"))}</span>
                </button>`
              : `<aside class="output-book-toc" aria-label="${escapeHtml(t("outputs.toc"))}">
            <div class="output-book-toc-head">
              <h3 title="${escapeHtml(bookTitle)}">${escapeHtml(bookTitle)}</h3>
              <button
                type="button"
                class="output-book-toc-collapse-btn"
                data-action="outputs-toggle-toc"
                title="${escapeHtml(t("outputs.collapseToc"))}"
                aria-expanded="true"
                aria-label="${escapeHtml(t("outputs.collapseToc"))}"
              >
                <span aria-hidden="true">${ICONS.chevronLeft}</span>
              </button>
            </div>
            ${
              chapters.length
                ? chapters
                    .map(
                      (chapter) => `
                        <button
                          type="button"
                          class="output-book-toc-item${chapter.id === activeId ? " is-active" : ""}"
                          data-action="outputs-select-chapter"
                          data-chapter-id="${escapeHtml(chapter.id)}"
                          title="${escapeHtml(chapter.relPath || chapter.path || "")}"
                        >
                          <span>${escapeHtml(chapter.title || chapter.relPath || t("outputs.untitledChapter"))}</span>
                        </button>`,
                    )
                    .join("")
                : `<div class="output-book-empty">${escapeHtml(t("outputs.noChapters"))}</div>`
            }
          </aside>`
          }
          <section class="output-book-content" aria-label="${escapeHtml(t("outputs.preview"))}">
            ${
              dialog.busy
                ? `<div class="output-book-empty">${escapeHtml(t("outputs.loading"))}</div>`
                : dialog.error
                  ? `<div class="output-book-empty is-error">${escapeHtml(dialog.error)}</div>`
                  : dialog.content
                    ? `<div class="output-book-markdown is-markdown">${renderMarkdown(dialog.content)}</div>`
                    : `<div class="output-book-empty">${escapeHtml(t("outputs.pickChapter"))}</div>`
            }
          </section>
        </div>
      </section>
    `;
  }

  async function loadOutputChapter(chapterId) {
    const dialog = state.outputBookDialog;
    if (!dialog) return;
    const chapter = (dialog.chapters || []).find((item) => item.id === chapterId);
    if (!chapter) return;
    state.outputBookDialog = {
      ...dialog,
      activeChapterId: chapter.id,
      busy: true,
      error: "",
    };
    render();
    try {
      const result = await storeRequest(
        "outputs.readChapter",
        { path: chapter.path, rootPath: dialog.rootPath },
        { timeoutMs: 15000 },
      );
      if (!state.outputBookDialog || state.outputBookDialog.bookId !== dialog.bookId) return;
      state.outputBookDialog = {
        ...state.outputBookDialog,
        content: String(result.content || ""),
        busy: false,
        error: "",
      };
      render();
    } catch (error) {
      if (!state.outputBookDialog || state.outputBookDialog.bookId !== dialog.bookId) return;
      state.outputBookDialog = {
        ...state.outputBookDialog,
        content: "",
        busy: false,
        error: error instanceof Error ? error.message : t("outputs.readFailed"),
      };
      render();
    }
  }

  function applyOutputBookState(task, bookId) {
    const book = (Array.isArray(task?.outputs) ? task.outputs : []).find((item) => item.id === bookId);
    if (!book) {
      state.outputBookDialog = null;
      return false;
    }
    const chapters = Array.isArray(book.chapters) ? book.chapters : [];
    const sameBook = state.outputBookDialog?.bookId === book.id;
    state.outputBookDialog = {
      taskId: task.id,
      bookId: book.id,
      title: book.title || t("outputs.untitled"),
      rootPath: book.rootPath || "",
      chapters,
      activeChapterId: sameBook
        ? state.outputBookDialog.activeChapterId || chapters[0]?.id || null
        : chapters[0]?.id || null,
      content: sameBook ? state.outputBookDialog.content || "" : "",
      busy: !sameBook && Boolean(chapters[0]),
      error: "",
    };
    return true;
  }

  function tryApplyPendingOutputBook() {
    const pending = state.pendingOutputBookOpen;
    if (!pending || state.view !== "outputBook") return false;
    const task = state.tasks.find((item) => item.id === pending.taskId);
    if (!task) return false;
    if (!applyOutputBookState(task, pending.bookId)) return false;
    state.pendingOutputBookOpen = null;
    const chapterId = state.outputBookDialog?.activeChapterId;
    if (chapterId && !state.outputBookDialog?.content) {
      void loadOutputChapter(chapterId);
    }
    return true;
  }

  function openOutputBook(task, bookId) {
    const book = (Array.isArray(task?.outputs) ? task.outputs : []).find((item) => item.id === bookId);
    if (!book) {
      vscode.postMessage({ type: "toast", text: t("outputs.missing") });
      return;
    }
    // 编辑器新开独立标签页阅读，不弹窗
    vscode.postMessage({
      type: "openOutputBookInEditor",
      taskId: task.id,
      bookId: book.id,
      title: book.title || t("outputs.untitled"),
    });
  }

  function renderIssueAttachments(task) {
    const items = Array.isArray(task?.attachments) ? task.attachments : [];
    return `
      <section class="issue-attachments" aria-label="附件">
        <header class="attachments-heading">
          <div>
            <h2>附件</h2>
            <span>${items.length}</span>
          </div>
          <button class="ghost-link" type="button" data-action="pick-issue-attachment">${ICONS.paperclip} 添加附件</button>
        </header>
        ${
          items.length
            ? `<div class="issue-attachment-list">
                ${items
                  .map((item) => {
                    const isImage = String(item.mime || "").startsWith("image/");
                    const src = String(item.url || "").trim();
                    if (isImage && src) {
                      return `
                        <div class="issue-attachment-card is-image">
                          <button type="button" class="issue-attachment-thumb" data-action="open-attachment" data-rel-path="${escapeHtml(item.relPath || "")}" title="${escapeHtml(item.name || "图片")}">
                            <img src="${escapeHtml(src)}" alt="${escapeHtml(item.name || "图片")}" loading="lazy" />
                          </button>
                          <div class="issue-attachment-meta">
                            <span class="issue-attachment-name" title="${escapeHtml(item.name || "图片")}">${escapeHtml(item.name || "图片")}</span>
                            <button type="button" class="issue-attachment-remove" data-action="remove-issue-attachment" data-attachment-id="${escapeHtml(item.id || "")}" title="删除附件">×</button>
                          </div>
                        </div>
                      `;
                    }
                    return `
                      <div class="issue-attachment-card">
                        <button type="button" class="issue-attachment-file" data-action="open-attachment" data-rel-path="${escapeHtml(item.relPath || "")}" title="${escapeHtml(item.name || "附件")}">
                          ${ICONS.paperclip}
                          <span>${escapeHtml(item.name || "附件")}</span>
                        </button>
                        <button type="button" class="issue-attachment-remove" data-action="remove-issue-attachment" data-attachment-id="${escapeHtml(item.id || "")}" title="删除附件">×</button>
                      </div>
                    `;
                  })
                  .join("")}
              </div>`
            : `<p class="attachments-empty">添加图片、文档或其他文件，单个文件不超过 25 MB。</p>`
        }
        <input id="issue-attachment-input" class="composer-file-input" type="file" multiple tabindex="-1" aria-hidden="true" />
      </section>
    `;
  }

  function openProjectsManage() {
    state.projectMenuOpen = false;
    state.projectQuery = "";
    state.selectedTaskId = null;
    state.editingDescription = false;
    if (isSidebar) {
      vscode.postMessage({ type: "openViewInEditor", view: "projects" });
      return;
    }
    state.view = "projects";
    render();
  }

  function openSyncSettings() {
    state.projectMenuOpen = false;
    state.projectQuery = "";
    state.selectedTaskId = null;
    state.editingDescription = false;
    if (isSidebar) {
      vscode.postMessage({ type: "openViewInEditor", view: "sync" });
      return;
    }
    state.view = "sync";
    void loadSyncConfig();
    render();
  }

  async function loadSyncConfig() {
    try {
      const result = await storeRequest("sync.getConfig", {}, { timeoutMs: 10000 });
      state.syncConfig = {
        mode: result.sync?.mode === "git" ? "git" : "local",
        gitUrl: result.sync?.gitUrl || "",
        branch: result.sync?.branch || "main",
        scheduleEnabled: Boolean(result.sync?.scheduleEnabled),
        scheduleHour: Number(result.sync?.scheduleHour ?? 3) || 3,
        lastSyncAt: result.sync?.lastSyncAt || null,
        lastPushAt: result.sync?.lastPushAt || null,
        lastSyncDirection: result.sync?.lastSyncDirection || null,
        lastSyncError: result.sync?.lastSyncError || null,
        dbPath: result.dbPath || state.dbPath || "",
        busy: false,
        message: "",
        error: "",
      };
      render();
    } catch (error) {
      state.syncConfig = {
        mode: "local",
        gitUrl: "",
        branch: "main",
        scheduleEnabled: false,
        scheduleHour: 3,
        lastSyncAt: null,
        lastPushAt: null,
        lastSyncDirection: null,
        lastSyncError: null,
        dbPath: state.dbPath || "",
        busy: false,
        message: "",
        error: error instanceof Error ? error.message : String(error),
      };
      render();
    }
  }

  function syncConfigFromDom() {
    const cfg = state.syncConfig;
    if (!cfg) return cfg;
    const modeEl = app.querySelector('[data-sync-field="mode"]');
    const gitUrlEl = app.querySelector('[data-sync-field="gitUrl"]');
    const branchEl = app.querySelector('[data-sync-field="branch"]');
    const scheduleEl = app.querySelector('[data-sync-field="scheduleEnabled"]');
    const hourEl = app.querySelector('[data-sync-field="scheduleHour"]');
    if (modeEl instanceof HTMLSelectElement) cfg.mode = modeEl.value === "git" ? "git" : "local";
    if (gitUrlEl instanceof HTMLInputElement) cfg.gitUrl = gitUrlEl.value;
    if (branchEl instanceof HTMLInputElement) cfg.branch = branchEl.value;
    if (scheduleEl instanceof HTMLInputElement) cfg.scheduleEnabled = scheduleEl.checked;
    if (hourEl instanceof HTMLInputElement) cfg.scheduleHour = Number(hourEl.value) || 3;
    return cfg;
  }

  function bindSyncSettingsFields() {
    app.querySelectorAll("[data-sync-field]").forEach((input) => {
      const field = input.getAttribute("data-sync-field");
      if (!field || !state.syncConfig) return;
      const handler = () => {
        const prevMode = state.syncConfig.mode;
        const prevSchedule = state.syncConfig.scheduleEnabled;
        syncConfigFromDom();
        if (field === "mode" || field === "scheduleEnabled") {
          if (state.syncConfig.mode !== prevMode || state.syncConfig.scheduleEnabled !== prevSchedule) {
            render();
          }
        }
      };
      input.addEventListener("change", handler);
      if (input instanceof HTMLInputElement && input.type === "text") {
        input.addEventListener("input", () => syncConfigFromDom());
      }
    });
  }

  function renderSettingsPage() {
    if (state.settingsSection === "sync") {
      return renderSyncSettingsPage({ showBack: true });
    }
    return `
      <section class="settings-page" aria-label="${escapeHtml(t("settings.title"))}">
        <header class="settings-page-header">
          <div>
            <h2>${escapeHtml(t("settings.title"))}</h2>
            <p>${escapeHtml(t("settings.desc"))}</p>
          </div>
        </header>
        <div class="settings-list" role="list">
          <button
            type="button"
            class="settings-item"
            role="listitem"
            data-action="settings-open-sync"
          >
            <span class="settings-item-main">
              <strong>${escapeHtml(t("sync.open"))}</strong>
              <span>${escapeHtml(t("sync.desc"))}</span>
            </span>
            <span class="settings-item-chevron" aria-hidden="true">›</span>
          </button>
        </div>
      </section>
    `;
  }

  function renderSyncSettingsPage(options = {}) {
    const showBack = Boolean(options.showBack);
    const backBtn = showBack
      ? `<button type="button" class="devctx-btn" data-action="settings-back">${escapeHtml(t("settings.back"))}</button>`
      : "";
    if (!state.syncConfig) {
      void loadSyncConfig();
      return `
        <section class="sync-page" aria-label="${escapeHtml(t("sync.title"))}">
          <header class="sync-page-header">
            <div>
              <h2>${escapeHtml(t("sync.title"))}</h2>
              <p>${escapeHtml(t("loading"))}</p>
            </div>
            ${backBtn}
          </header>
        </section>
      `;
    }
    const cfg = state.syncConfig;
    const isGit = cfg.mode === "git";
    return `
      <section class="sync-page" aria-label="${escapeHtml(t("sync.title"))}">
        <header class="sync-page-header">
          <div>
            <h2>${escapeHtml(t("sync.title"))}</h2>
            <p>默认使用本机 SQLite；可选配置 Git 仓库做每日备份，也可手动推送 / 拉回合并</p>
          </div>
          ${backBtn}
        </header>
        <div class="sync-card">
          <label class="project-field">
            <span>存储模式</span>
            <select data-sync-field="mode" ${cfg.busy ? "disabled" : ""}>
              <option value="local"${!isGit ? " selected" : ""}>本地 SQLite（默认）</option>
              <option value="git"${isGit ? " selected" : ""}>Git 备份</option>
            </select>
          </label>
          <label class="project-field">
            <span>本地数据库</span>
            <input type="text" value="${escapeHtml(cfg.dbPath || state.dbPath || "")}" readonly />
          </label>
          ${
            isGit
              ? `<label class="project-field">
                  <span>Git 仓库地址</span>
                  <input type="text" data-sync-field="gitUrl" value="${escapeHtml(cfg.gitUrl)}" placeholder="https://github.com/org/taskboard-backup.git" ${cfg.busy ? "disabled" : ""} />
                </label>
                <label class="project-field">
                  <span>分支</span>
                  <input type="text" data-sync-field="branch" value="${escapeHtml(cfg.branch || "main")}" placeholder="main" ${cfg.busy ? "disabled" : ""} />
                </label>
                <label class="sync-check">
                  <input type="checkbox" data-sync-field="scheduleEnabled" ${cfg.scheduleEnabled ? "checked" : ""} ${cfg.busy ? "disabled" : ""} />
                  <span>每天自动提交备份一次</span>
                </label>
                <label class="project-field sync-hour-field">
                  <span>每日备份时刻（本地小时，0–23）</span>
                  <input type="number" min="0" max="23" data-sync-field="scheduleHour" value="${escapeHtml(String(cfg.scheduleHour ?? 3))}" ${cfg.busy || !cfg.scheduleEnabled ? "disabled" : ""} />
                </label>`
              : `<p class="wt-wizard-hint">本地模式仅保存在本机 SQLite，不访问远程仓库。</p>`
          }
          <div class="sync-meta">
            <div>上次同步：${escapeHtml(cfg.lastSyncAt ? exactTime(cfg.lastSyncAt) : "尚未同步")}${cfg.lastSyncDirection ? `（${escapeHtml(cfg.lastSyncDirection)}）` : ""}</div>
            <div>上次推送：${escapeHtml(cfg.lastPushAt ? exactTime(cfg.lastPushAt) : "—")}</div>
            ${cfg.lastSyncError ? `<div class="wt-wizard-error">上次错误：${escapeHtml(cfg.lastSyncError)}</div>` : ""}
            ${cfg.message ? `<div class="sync-ok">${escapeHtml(cfg.message)}</div>` : ""}
            ${cfg.error ? `<div class="wt-wizard-error">${escapeHtml(cfg.error)}</div>` : ""}
          </div>
          <div class="sync-actions">
            <button type="button" class="devctx-btn primary" data-action="sync-save" ${cfg.busy ? "disabled" : ""}>保存配置</button>
            <button type="button" class="devctx-btn" data-action="sync-push" ${cfg.busy || !isGit ? "disabled" : ""}>${cfg.busy ? "处理中…" : "同步到 Git"}</button>
            <button type="button" class="devctx-btn" data-action="sync-pull" ${cfg.busy || !isGit ? "disabled" : ""}>从 Git 拉回</button>
            <button type="button" class="devctx-btn" data-action="sync-merge" ${cfg.busy || !isGit ? "disabled" : ""}>合并 Git 到本地</button>
          </div>
          <p class="wt-wizard-hint">拉回 / 合并会先备份当前本地库再覆盖。SQLite 为二进制文件，合并策略为「远端优先 + 本地备份」。</p>
        </div>
      </section>
    `;
  }

  function openProjectCreateForm() {
    state.projectWizard = {
      mode: "create",
      projectId: null,
      name: "",
      keyPrefix: "",
      source: "folders",
      folders: [],
      gitUrls: [],
      gitUrl: "",
      cloneParent: "",
      cloneFolderName: "",
      busy: false,
      error: "",
    };
    render();
  }

  function openProjectEditForm(projectId) {
    const project = (state.projects || []).find((item) => item.id === projectId);
    if (!project) {
      vscode.postMessage({ type: "toast", text: "项目不存在" });
      return;
    }
    const folders = Array.isArray(project.folders) ? [...project.folders] : [];
    const gitUrls = Array.isArray(project.gitUrls)
      ? [...project.gitUrls]
      : project.gitUrl
        ? [String(project.gitUrl)]
        : [];
    state.projectWizard = {
      mode: "edit",
      projectId: project.id,
      name: project.name || "",
      keyPrefix: project.keyPrefix || "",
      source: "folders",
      folders,
      gitUrls,
      gitUrl: gitUrls[0] || "",
      cloneParent: "",
      cloneFolderName: "",
      busy: false,
      error: "",
    };
    render();
  }

  function closeProjectCreateForm() {
    state.projectWizard = null;
    render();
  }

  /** 从 DOM 回写向导字段，避免侧栏无议题时输入监听未绑定导致 state 为空 */
  function syncProjectWizardFromDom() {
    if (!state.projectWizard) return state.projectWizard;
    const patch = {};
    app.querySelectorAll("[data-project-field]").forEach((input) => {
      if (!(input instanceof HTMLInputElement)) return;
      const field = input.getAttribute("data-project-field");
      if (!field) return;
      patch[field] = input.value;
    });
    state.projectWizard = { ...state.projectWizard, ...patch };
    return state.projectWizard;
  }

  function projectWizardCanSubmit(wizard = state.projectWizard) {
    if (!wizard || wizard.busy) return false;
    const name = String(wizard.name || "").trim();
    if (!name) return false;
    const folders = Array.isArray(wizard.folders) ? wizard.folders : [];
    const gitUrls = Array.isArray(wizard.gitUrls) ? wizard.gitUrls : [];
    // 名称必填；至少有一个本地文件夹，或已登记 git（编辑时允许仅保留 git）
    if (folders.length > 0) return true;
    if (wizard.mode === "edit" && gitUrls.length > 0) return true;
    return false;
  }

  function refreshProjectWizardSubmit() {
    const wizard = syncProjectWizardFromDom();
    const submit = app.querySelector('[data-action="project-wizard-submit"]');
    if (submit instanceof HTMLButtonElement) {
      submit.disabled = !projectWizardCanSubmit(wizard);
    }
  }

  function bindProjectWizardFields() {
    app.querySelectorAll("[data-project-field]").forEach((input) => {
      if (!(input instanceof HTMLInputElement)) return;
      input.addEventListener("input", () => {
        if (!state.projectWizard) return;
        const field = input.getAttribute("data-project-field");
        if (!field) return;
        state.projectWizard = { ...state.projectWizard, [field]: input.value, error: "" };
        refreshProjectWizardSubmit();
      });
    });
    refreshProjectWizardSubmit();
  }

  function renderProjectCreateForm() {
    const wizard = state.projectWizard;
    if (!wizard) return "";
    const isEdit = wizard.mode === "edit";
    const gitUrls = Array.isArray(wizard.gitUrls) ? wizard.gitUrls : [];
    const canSubmit = projectWizardCanSubmit(wizard);
    const foldersBlock = `
      <div class="project-section-label">${escapeHtml(t("project.folders"))}</div>
      <div class="project-folder-row">
        <button type="button" class="devctx-btn primary" data-action="project-pick-folders" ${wizard.busy ? "disabled" : ""}>${escapeHtml(t("project.pickFolders"))}</button>
      </div>
      <div class="project-folder-list">
        ${
          wizard.folders.length
            ? wizard.folders
                .map(
                  (folder, index) => `
                    <span class="devctx-folder-chip" title="${escapeHtml(folder)}">
                      <span class="devctx-folder-icon">${ICONS.folder}</span>
                      <span class="devctx-folder-name">${escapeHtml(folderDisplayName(folder) || folder)}</span>
                      <button type="button" class="devctx-path-remove" data-action="project-remove-folder" data-index="${index}" aria-label="remove">×</button>
                    </span>
                  `,
                )
                .join("")
            : `<div class="devctx-empty">${escapeHtml(t("project.emptyFolders"))}</div>`
        }
      </div>
    `;
    const gitBlock = `
      <div class="project-section-label">${escapeHtml(t("project.gits"))}</div>
      <div class="project-folder-row">
        <button type="button" class="devctx-btn" data-action="project-add-git" ${wizard.busy || state.gitSelectDialog ? "disabled" : ""}>${escapeHtml(t("project.addGit"))}</button>
      </div>
      <div class="project-folder-list project-git-list">
        ${
          gitUrls.length
            ? gitUrls
                .map(
                  (url, index) => `
                    <span class="devctx-folder-chip is-worktree" title="${escapeHtml(url)}">
                      <span class="devctx-folder-icon">${ICONS.branch}</span>
                      <span class="devctx-folder-name">
                        <span class="devctx-folder-leaf">${escapeHtml(guessRepoFolderName(url))}</span>
                      </span>
                      <button type="button" class="devctx-path-remove" data-action="project-remove-git" data-index="${index}" aria-label="remove">×</button>
                    </span>
                  `,
                )
                .join("")
            : `<div class="devctx-empty">${escapeHtml(t("project.emptyGits"))}</div>`
        }
      </div>
    `;
    return `
      <section class="project-create-panel" aria-label="${escapeHtml(isEdit ? t("project.editTitle") : t("project.createTitle"))}">
        <header class="project-create-header">
          <div>
            <h3>${escapeHtml(isEdit ? t("project.editTitle") : t("project.createTitle"))}</h3>
            <p>${escapeHtml(isEdit ? t("project.editDesc") : t("project.createDesc"))}</p>
          </div>
          <button type="button" class="ghost-link" data-action="project-wizard-close">${escapeHtml(t("project.cancel"))}</button>
        </header>
        ${wizard.error ? `<div class="wt-wizard-error">${escapeHtml(wizard.error)}</div>` : ""}
        <div class="project-create-body">
          <label class="project-field">
            <span>${escapeHtml(t("project.name"))}</span>
            <input type="text" data-project-field="name" value="${escapeHtml(wizard.name)}" placeholder="my-app" ${wizard.busy ? "disabled" : ""} />
          </label>
          <label class="project-field">
            <span>${escapeHtml(t("project.prefix"))}</span>
            <input type="text" data-project-field="keyPrefix" value="${escapeHtml(wizard.keyPrefix)}" placeholder="APP" ${wizard.busy ? "disabled" : ""} />
          </label>
          ${foldersBlock}
          ${gitBlock}
          <p class="wt-wizard-hint">${escapeHtml(t("project.hint"))}</p>
        </div>
        <footer class="project-create-footer">
          <button type="button" class="devctx-btn primary" data-action="project-wizard-submit" ${canSubmit ? "" : "disabled"}>
            ${escapeHtml(
              wizard.busy
                ? isEdit
                  ? t("project.saving")
                  : t("project.creating")
                : isEdit
                  ? t("project.save")
                  : t("project.createBtn"),
            )}
          </button>
        </footer>
      </section>
    `;
  }

  function renderProjectsPage() {
    const projects = state.projects || [];
    return `
      <section class="projects-page" aria-label="${escapeHtml(t("project.pageTitle"))}">
        <header class="projects-page-header">
          <div>
            <h2>${escapeHtml(t("project.pageTitle"))}</h2>
            <p>${escapeHtml(t("project.pageDesc"))}</p>
          </div>
          <button type="button" class="devctx-btn primary" data-action="project-create-open" ${state.projectWizard ? "disabled" : ""}>
            ${escapeHtml(t("project.create"))}
          </button>
        </header>
        ${renderProjectCreateForm()}
        <div class="projects-list" role="list">
          ${
            projects.length
              ? projects
                  .map((project) => {
                    const folders = Array.isArray(project.folders) ? project.folders : [];
                    const gitUrls = Array.isArray(project.gitUrls)
                      ? project.gitUrls
                      : project.gitUrl
                        ? [project.gitUrl]
                        : [];
                    const issueCount = Number(project.issueCount || 0);
                    return `
                      <article class="project-card" role="listitem">
                        <div class="project-card-main">
                          <div class="project-card-title">
                            <span class="avatar">P</span>
                            <div class="project-card-copy">
                              <h3>${escapeHtml(project.name)}</h3>
                              <div class="project-card-meta">
                                <span>${escapeHtml(t("project.prefixLabel", { prefix: project.keyPrefix || "-" }))}</span>
                                <span>${escapeHtml(t("project.issuesCount", { n: issueCount }))}</span>
                                ${gitUrls.length ? `<span>${escapeHtml(t("project.gitCount", { n: gitUrls.length }))}</span>` : ""}
                              </div>
                            </div>
                          </div>
                          <div class="project-card-folders">
                            ${
                              folders.length
                                ? folders
                                    .map(
                                      (folder) => `
                                        <span class="devctx-folder-chip" title="${escapeHtml(folder)}">
                                          <span class="devctx-folder-icon">${ICONS.folder}</span>
                                          <span class="devctx-folder-name">${escapeHtml(folderDisplayName(folder) || folder)}</span>
                                        </span>
                                      `,
                                    )
                                    .join("")
                                : `<span class="devctx-empty">${escapeHtml(t("project.noFolders"))}</span>`
                            }
                            ${gitUrls
                              .map(
                                (url) => `
                                  <span class="devctx-folder-chip is-worktree" title="${escapeHtml(url)}">
                                    <span class="devctx-folder-icon">${ICONS.branch}</span>
                                    <span class="devctx-folder-name">${escapeHtml(guessRepoFolderName(url))}</span>
                                  </span>`,
                              )
                              .join("")}
                          </div>
                        </div>
                        <footer class="project-card-footer">
                          <button
                            type="button"
                            class="devctx-btn primary"
                            data-action="project-open-workspace"
                            data-project-id="${escapeHtml(project.id)}"
                            title="${escapeHtml(t("project.openWorkspaceTitle"))}"
                            ${folders.length ? "" : "disabled"}
                          >${escapeHtml(t("project.openWorkspace"))}</button>
                          <div class="project-card-footer-right">
                            <button
                              type="button"
                              class="devctx-btn"
                              data-action="project-edit"
                              data-project-id="${escapeHtml(project.id)}"
                              ${state.projectWizard ? "disabled" : ""}
                            >${escapeHtml(t("project.edit"))}</button>
                            <button
                              type="button"
                              class="devctx-btn danger"
                              data-action="project-delete"
                              data-project-id="${escapeHtml(project.id)}"
                              data-project-name="${escapeHtml(project.name)}"
                              data-issue-count="${issueCount}"
                            >${escapeHtml(t("project.delete"))}</button>
                          </div>
                        </footer>
                      </article>
                    `;
                  })
                  .join("")
              : `<div class="projects-empty">
                  <strong>${escapeHtml(t("project.empty"))}</strong>
                  <span>${escapeHtml(t("project.emptyHint"))}</span>
                </div>`
          }
        </div>
      </section>
    `;
  }

  async function persistCreateProject() {
    const wizard = syncProjectWizardFromDom();
    if (!wizard) return;
    const name = String(wizard.name || "").trim();
    if (!name) {
      wizard.error = "请填写项目名称";
      render();
      return;
    }
    if (!projectWizardCanSubmit(wizard)) {
      wizard.error =
        wizard.mode === "edit"
          ? "请至少保留一个文件夹或 git 仓库"
          : "请至少选择一个文件夹（可先「添加 git」克隆）";
      render();
      return;
    }
    wizard.busy = true;
    wizard.error = "";
    render();
    try {
      const gitUrls = Array.isArray(wizard.gitUrls) ? wizard.gitUrls : [];
      if (wizard.mode === "edit" && wizard.projectId) {
        const result = await storeRequest(
          "store.updateProject",
          {
            projectId: wizard.projectId,
            payload: {
              name,
              keyPrefix: String(wizard.keyPrefix || "").trim(),
              folders: wizard.folders,
              gitUrls,
            },
          },
          { timeoutMs: 60000 },
        );
        if (result.project?.id) {
          state.projects = (state.projects || []).map((item) =>
            item.id === result.project.id ? result.project : item,
          );
          state.projectWizard = null;
          state.view = "projects";
          render();
          const synced = Number(result.syncedIssueCount || 0);
          vscode.postMessage({
            type: "toast",
            text:
              synced > 0
                ? `已更新项目 ${result.project.name}，并同步 ${synced} 个议题的开发上下文`
                : `已更新项目 ${result.project.name}`,
          });
          vscode.postMessage({ type: "store.getSnapshot" });
        }
        return;
      }

      const payload = {
        name,
        keyPrefix: String(wizard.keyPrefix || "").trim(),
        source: "folders",
        folders: wizard.folders,
        gitUrls,
      };
      const result = await storeRequest("store.createProject", { payload }, { timeoutMs: 120000 });
      if (result.project?.id) {
        state.projects = [
          result.project,
          ...(state.projects || []).filter((item) => item.id !== result.project.id),
        ];
        state.projectId = result.project.id;
        state.projectWizard = null;
        state.view = "projects";
        render();
        vscode.postMessage({ type: "toast", text: `已创建项目 ${result.project.name}` });
        vscode.postMessage({ type: "store.getSnapshot" });
      }
    } catch (error) {
      wizard.busy = false;
      wizard.error = error instanceof Error ? error.message : String(error);
      render();
    }
  }

  async function persistAddIssueAttachments(taskId, files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    const maxBytes = 25 * 1024 * 1024;
    /** @type {Array<{ mime: string, name: string, dataBase64: string }>} */
    const attachments = [];
    for (const file of list) {
      if (file.size > maxBytes) {
        vscode.postMessage({ type: "toast", text: `${file.name || "文件"} 超过 25 MB` });
        continue;
      }
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取文件失败"));
        reader.readAsDataURL(file);
      });
      attachments.push({
        mime: file.type || "application/octet-stream",
        name: file.name || "file",
        dataBase64: dataUrl,
      });
    }
    if (!attachments.length) return;
    try {
      const result = await storeRequest("store.addIssueAttachments", {
        taskId,
        attachments,
      });
      if (result.issue) {
        upsertTask(result.issue);
        render();
      }
    } catch (error) {
      vscode.postMessage({
        type: "toast",
        text: error instanceof Error ? error.message : "添加附件失败",
      });
    }
  }

  function renderPendingCommentImages() {
    const items = state.pendingCommentImages || [];
    if (!items.length) return "";
    return `
      <div class="composer-image-preview" aria-label="待发送截图">
        ${items
          .map(
            (item) => `
          <div class="composer-image-thumb" data-pending-image-id="${escapeHtml(item.id)}">
            <img src="${escapeHtml(item.dataUrl)}" alt="${escapeHtml(item.name)}" />
            <button type="button" class="composer-image-remove" data-action="remove-pending-image" data-image-id="${escapeHtml(item.id)}" aria-label="移除截图">×</button>
          </div>
        `,
          )
          .join("")}
      </div>
    `;
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("读取截图失败"));
      reader.readAsDataURL(file);
    });
  }

  const PREFERRED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);

  /**
   * @param {File[]} images
   * @returns {File[]}
   */
  function dedupeClipboardImages(images) {
    if (images.length <= 1) return images;
    const hasPreferred = images.some((file) => PREFERRED_IMAGE_TYPES.has(file.type));
    const filtered = hasPreferred
      ? images.filter((file) => file.type !== "image/tiff" && file.type !== "image/tif")
      : images;
    /** @type {Map<string, File>} */
    const unique = new Map();
    for (const file of filtered) {
      // Ignore lastModified: DataTransferItem.getAsFile() stamps a new time, so
      // the same screenshot also appearing in data.files would look like a second file.
      const key = `${file.type}:${file.size}:${file.name}`;
      if (!unique.has(key)) unique.set(key, file);
    }
    return [...unique.values()];
  }

  /**
   * @param {DataTransfer | null | undefined} data
   * @returns {File[]}
   */
  function collectImageFilesFromDataTransfer(data) {
    if (!data) return [];
    /** @type {File[]} */
    const images = [];
    const seen = new Set();
    const pushFile = (file) => {
      if (!(file instanceof File)) return;
      if (!file.type || !file.type.startsWith("image/")) return;
      const key = `${file.type}:${file.size}:${file.name}`;
      if (seen.has(key)) return;
      seen.add(key);
      images.push(file);
    };
    let fromItems = 0;
    if (data.items?.length) {
      for (const item of data.items) {
        if (item.kind && item.kind !== "file") continue;
        if (!item.type || !item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (file) {
          pushFile(file);
          fromItems += 1;
        }
      }
    }
    // items and files are the same screenshot on paste; only use files as fallback.
    if (!fromItems && data.files?.length) {
      for (const file of data.files) pushFile(file);
    }
    return dedupeClipboardImages(images);
  }

  /**
   * @param {{ mime?: string, name?: string, dataUrl: string }} item
   */
  function pushPendingCommentImage(item) {
    if ((state.pendingCommentImages || []).length >= 8) {
      vscode.postMessage({ type: "toast", text: "单条评论最多附 8 张截图" });
      return false;
    }
    const dataUrl = String(item.dataUrl || "");
    if (!dataUrl.startsWith("data:image/")) return false;
    state.pendingCommentImages = [
      ...(state.pendingCommentImages || []),
      {
        id: `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        mime: item.mime || "image/png",
        name: item.name || `screenshot-${(state.pendingCommentImages || []).length + 1}.png`,
        dataUrl,
      },
    ];
    return true;
  }

  /**
   * @param {File[]} files
   * @param {{ focus?: boolean, toastIfEmpty?: boolean }} [options]
   */
  async function addPendingCommentImages(files, options = {}) {
    const list = Array.isArray(files) ? files : [];
    if (!list.length) {
      if (options.toastIfEmpty) {
        vscode.postMessage({ type: "toast", text: "未检测到图片，可点「图片」或拖拽图片到评论框" });
      }
      return 0;
    }
    let added = 0;
    for (const file of list) {
      if (!file?.type?.startsWith("image/")) continue;
      const dataUrl = await readFileAsDataUrl(file);
      if (!dataUrl) continue;
      if (
        pushPendingCommentImage({
          mime: file.type || "image/png",
          name: file.name || `screenshot-${(state.pendingCommentImages || []).length + 1}.png`,
          dataUrl,
        })
      ) {
        added += 1;
      } else {
        break;
      }
    }
    if (added) {
      if (options.focus !== false) state.focusCommentInput = true;
      render();
    } else if (options.toastIfEmpty) {
      vscode.postMessage({ type: "toast", text: "未检测到可用图片" });
    }
    return added;
  }

  async function readNavigatorClipboardImage() {
    if (!navigator.clipboard || typeof navigator.clipboard.read !== "function") return null;
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = (item.types || []).find((value) => String(value).startsWith("image/"));
        if (!type) continue;
        const blob = await item.getType(type);
        const dataUrl = await readFileAsDataUrl(new File([blob], "screenshot.png", { type }));
        if (dataUrl) {
          return { mime: type, name: "screenshot.png", dataUrl };
        }
      }
    } catch {
      // Webview may deny clipboard-read; fall through to extension host.
    }
    return null;
  }

  async function readHostClipboardImage() {
    try {
      const result = await storeRequest("clipboard.readImage", {}, { timeoutMs: 6000 });
      const image = result?.image;
      if (!image?.dataBase64) return null;
      return {
        mime: image.mime || "image/png",
        name: image.name || "screenshot.png",
        dataUrl: String(image.dataBase64),
      };
    } catch {
      return null;
    }
  }

  /**
   * @param {HTMLTextAreaElement} textarea
   * @param {string} text
   */
  function insertTextIntoTextarea(textarea, text) {
    if (!text) return;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const next = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(end)}`;
    textarea.value = next;
    state.commentDraft = next;
    const caret = start + text.length;
    textarea.setSelectionRange(caret, caret);
  }

  let commentPasteInFlight = false;

  /**
   * Paste images into the comment composer.
   * Webview clipboardData often lacks image/* — fall back to Async Clipboard API,
   * then extension-host OS clipboard read (most reliable for Cmd+V screenshots).
   * @param {ClipboardEvent} event
   */
  async function handleCommentImagePaste(event) {
    const input = document.getElementById("comment-input");
    if (input instanceof HTMLTextAreaElement) state.commentDraft = input.value;

    const fromEvent = collectImageFilesFromDataTransfer(event.clipboardData);
    const pastedText = event.clipboardData?.getData("text/plain") || "";
    event.preventDefault();
    if (commentPasteInFlight) return;
    commentPasteInFlight = true;
    try {
      if (fromEvent.length) {
        await addPendingCommentImages(fromEvent);
        return;
      }

      const navImage = await readNavigatorClipboardImage();
      if (navImage && pushPendingCommentImage(navImage)) {
        state.focusCommentInput = true;
        render();
        return;
      }

      const hostImage = await readHostClipboardImage();
      if (hostImage && pushPendingCommentImage(hostImage)) {
        state.focusCommentInput = true;
        render();
        return;
      }

      if (input instanceof HTMLTextAreaElement) {
        insertTextIntoTextarea(input, pastedText);
      } else if (pastedText) {
        state.commentDraft = `${state.commentDraft || ""}${pastedText}`;
      }
    } finally {
      commentPasteInFlight = false;
    }
  }

  function commentSnippet(body, max = 72, attachments = []) {
    const text = String(body || "").replace(/\s+/g, " ").trim();
    if (text) {
      if (text.length <= max) return text;
      return `${text.slice(0, max)}…`;
    }
    const count = Array.isArray(attachments) ? attachments.length : 0;
    if (count > 0) return count === 1 ? "截图" : `${count} 张截图`;
    return "";
  }

  async function persistAddRelation(taskId, type, targetIssueId) {
    try {
      const result = await storeRequest("store.addRelation", {
        taskId,
        payload: { type, targetIssueId },
      });
      if (result.issue) {
        upsertTask(result.issue);
        state.relationPicker = null;
        render();
      }
    } catch (error) {
      vscode.postMessage({ type: "toast", text: error.message || "添加关联失败" });
    }
  }

  async function persistRemoveRelation(taskId, relationId) {
    try {
      const result = await storeRequest("store.removeRelation", { taskId, relationId });
      if (result.issue) {
        upsertTask(result.issue);
        render();
      }
    } catch (error) {
      vscode.postMessage({ type: "toast", text: error.message || "移除关联失败" });
    }
  }

  function relationCandidates(task, type) {
    const relations = task.relations || { blockedBy: [], blocks: [], related: [] };
    const linked = new Set([
      ...(relations.blockedBy || []).map((item) => item.issueId),
      ...(relations.blocks || []).map((item) => item.issueId),
      ...(relations.related || []).map((item) => item.issueId),
      task.id,
    ]);
    // For block edges, also exclude already-linked in the opposite group.
    if (type === "blocked_by" || type === "blocks") {
      for (const item of relations.blockedBy || []) linked.add(item.issueId);
      for (const item of relations.blocks || []) linked.add(item.issueId);
    }
    const query = String(state.relationPicker?.query || "")
      .trim()
      .toLowerCase();
    return state.tasks
      .filter((item) => !linked.has(item.id))
      .filter((item) => {
        if (!query) return true;
        return (
          String(item.identifier || "").toLowerCase().includes(query) ||
          String(item.title || "").toLowerCase().includes(query)
        );
      })
      .slice(0, 8);
  }

  function renderRelationGroup(task, type, titleHtml) {
    const relations = task.relations || { blockedBy: [], blocks: [], related: [] };
    const key = type === "blocked_by" ? "blockedBy" : type === "blocks" ? "blocks" : "related";
    const items = relations[key] || [];
    const picking = state.relationPicker?.type === type;
    const candidates = picking ? relationCandidates(task, type) : [];
    return `
      <div class="issue-relation-group is-${type === "blocked_by" ? "blocked-by" : type}">
        <header>
          <span>${titleHtml}</span>
          <button
            class="relation-add"
            type="button"
            title="添加"
            data-action="relation-add"
            data-relation-type="${type}"
            data-task-id="${escapeHtml(task.id)}"
          >${picking ? "×" : "+"}</button>
        </header>
        ${
          items.length
            ? `<ul class="relation-list">
                ${items
                  .map(
                    (item) => `
                  <li class="relation-item">
                    <button
                      type="button"
                      class="relation-link"
                      data-action="open-related-issue"
                      data-task-id="${escapeHtml(item.issueId)}"
                      title="${escapeHtml(item.title || "")}"
                    >
                      <span class="relation-id">${escapeHtml(item.identifier)}</span>
                      <span class="relation-title">${escapeHtml(item.title || "")}</span>
                    </button>
                    <button
                      type="button"
                      class="relation-remove"
                      title="移除关联"
                      data-action="relation-remove"
                      data-task-id="${escapeHtml(task.id)}"
                      data-relation-id="${escapeHtml(item.relationId)}"
                    >×</button>
                  </li>`,
                  )
                  .join("")}
              </ul>`
            : ""
        }
        ${
          picking
            ? `<div class="relation-picker">
                <input
                  type="search"
                  class="relation-picker-input"
                  placeholder="搜索议题编号或标题…"
                  value="${escapeHtml(state.relationPicker.query || "")}"
                  data-relation-type="${type}"
                  aria-label="搜索要关联的议题"
                />
                <div class="relation-picker-list">
                  ${
                    candidates.length
                      ? candidates
                          .map(
                            (item) => `
                      <button
                        type="button"
                        class="relation-picker-option"
                        data-action="relation-pick"
                        data-relation-type="${type}"
                        data-task-id="${escapeHtml(task.id)}"
                        data-target-id="${escapeHtml(item.id)}"
                      >
                        <span class="relation-id">${escapeHtml(item.identifier)}</span>
                        <span class="relation-title">${escapeHtml(item.title || "")}</span>
                      </button>`,
                          )
                          .join("")
                      : `<div class="relation-picker-empty">没有可关联的议题</div>`
                  }
                </div>
              </div>`
            : ""
        }
      </div>
    `;
  }

  const ICONS = {
    chat: '<svg class="icon icon-16" viewBox="0 0 16 16"><path d="M3 4.5h10a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H8l-3 2v-2H3a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z"/></svg>',
    copy: '<svg class="icon" viewBox="0 0 16 16"><rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M3 10V3.5A1.5 1.5 0 0 1 4.5 2H10"/></svg>',
    link: '<svg class="icon" viewBox="0 0 16 16"><path d="M6.5 9.5 5 11a2.1 2.1 0 1 1-3-3l2-2a2.1 2.1 0 0 1 3 0"/><path d="M9.5 6.5 11 5a2.1 2.1 0 1 1 3 3l-2 2a2.1 2.1 0 0 1-3 0"/></svg>',
    paperclip: '<svg class="icon" viewBox="0 0 16 16"><path d="M10.5 4.5 5.2 9.8a2.2 2.2 0 1 0 3.1 3.1l5.1-5.1a3.3 3.3 0 0 0-4.7-4.7L3.5 8.3"/></svg>',
    status: '<svg class="icon" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.2"/><path d="m5.8 8.1 1.5 1.5 2.9-3"/></svg>',
    priority: '<svg class="icon" viewBox="0 0 16 16"><circle cx="4" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12" cy="8" r="1.1"/></svg>',
    label: '<svg class="icon" viewBox="0 0 16 16"><path d="M6.2 2.5 5.4 13.5M10.6 2.5 9.8 13.5M2.8 6h10.4M2.4 10h10.4"/></svg>',
    branch: '<svg class="icon" viewBox="0 0 16 16"><circle cx="4.5" cy="4" r="1.5"/><circle cx="4.5" cy="12" r="1.5"/><circle cx="11.5" cy="8" r="1.5"/><path d="M4.5 5.5v5M4.5 8h5.5"/></svg>',
    folder: '<svg class="icon" viewBox="0 0 16 16"><path d="M2.5 4.5h4l1.2 1.5H13.5v7.5H2.5z"/><path d="M2.5 6h11"/></svg>',
    calendar: '<svg class="icon" viewBox="0 0 16 16"><rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2.5v2M10.5 2.5v2"/></svg>',
    recurrence: '<svg class="icon" viewBox="0 0 16 16"><path d="M12.5 6.5A4.5 4.5 0 1 0 13 9"/><path d="M12.5 3.5v3h-3"/></svg>',
    warning: '<svg class="icon" viewBox="0 0 16 16"><path d="M8 2.8 13.5 13H2.5L8 2.8z"/><path d="M8 6.2v3.2M8 11.3h.01"/></svg>',
    pencil: '<svg class="icon" viewBox="0 0 16 16"><path d="m10.2 3.4 2.4 2.4M3 13l.7-2.8L10.8 3.1a1.2 1.2 0 0 1 1.7 0l.4.4a1.2 1.2 0 0 1 0 1.7L5.8 12.3 3 13z"/></svg>',
    check: '<svg class="icon" viewBox="0 0 16 16"><path d="m3.5 8.2 2.8 2.8 6.2-6.2"/></svg>',
    trash: '<svg class="icon" viewBox="0 0 16 16"><path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5.5 4.5l.5 8h4l.5-8"/></svg>',
    chevronRight: '<svg class="icon" viewBox="0 0 16 16"><path d="m6 3.5 5 4.5-5 4.5"/></svg>',
    chevronLeft: '<svg class="icon" viewBox="0 0 16 16"><path d="m10 3.5-5 4.5 5 4.5"/></svg>',
    chevronDown: '<svg class="icon" viewBox="0 0 16 16"><path d="m3.5 6 4.5 5 4.5-5"/></svg>',
    book: '<svg class="icon" viewBox="0 0 16 16"><path d="M3 2.5h4.2A2.3 2.3 0 0 1 9.5 4.8V13a1.8 1.8 0 0 0-1.8-1.1H3zM13 2.5H8.8A2.3 2.3 0 0 0 6.5 4.8V13c.5-.4 1.2-.6 1.8-.6H13z"/></svg>',
    gear: '<svg class="icon" viewBox="0 0 16 16"><path d="M6.7 1.8h2.6l.3 1.3a4.8 4.8 0 0 1 1.1.6l1.2-.5 1.3 1.3-.5 1.2c.3.3.5.7.6 1.1l1.3.3v2.6l-1.3.3a4.8 4.8 0 0 1-.6 1.1l.5 1.2-1.3 1.3-1.2-.5a4.8 4.8 0 0 1-1.1.6l-.3 1.3H6.7l-.3-1.3a4.8 4.8 0 0 1-1.1-.6l-1.2.5-1.3-1.3.5-1.2a4.8 4.8 0 0 1-.6-1.1L1.4 8.7V6.1l1.3-.3c.1-.4.3-.8.6-1.1l-.5-1.2L4.1 2.2l1.2.5c.3-.3.7-.5 1.1-.6zM8 5.5A2.5 2.5 0 1 0 8 10.5 2.5 2.5 0 0 0 8 5.5z"/></svg>',
  };

  const PRIORITY_ORDER = ["none", "urgent", "high", "medium", "low"];

  function priorityIcon(priority) {
    // 对齐 LinearPriorityIcon
    if (priority === "urgent") {
      return `<svg class="priority-svg" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1C1.91067 1 1 1.91067 1 3V13C1 14.0893 1.91067 15 3 15H13C14.0893 15 15 14.0893 15 13V3C15 1.91067 14.0893 1 13 1H3ZM7 4L9 4L8.75391 8.99836H7.25L7 4ZM9 11C9 11.5523 8.55228 12 8 12C7.44772 12 7 11.5523 7 11C7 10.4477 7.44772 10 8 10C8.55228 10 9 10.4477 9 11Z"/></svg>`;
    }
    if (priority === "none") {
      return `<svg class="priority-svg" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="7.25" width="3" height="1.5" rx=".5" opacity=".9"/><rect x="6.5" y="7.25" width="3" height="1.5" rx=".5" opacity=".9"/><rect x="11.5" y="7.25" width="3" height="1.5" rx=".5" opacity=".9"/></svg>`;
    }
    const midOpacity = priority === "low" ? ".4" : "1";
    const highOpacity = priority === "high" ? "1" : ".4";
    return `<svg class="priority-svg" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="8" width="3" height="6" rx="1"/><rect x="6.5" y="5" width="3" height="9" rx="1" fill-opacity="${midOpacity}"/><rect x="11.5" y="2" width="3" height="12" rx="1" fill-opacity="${highOpacity}"/></svg>`;
  }

  function shortDate(value) {
    if (!value) return "";
    return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(
      new Date(value.includes("T") ? value : `${value}T12:00:00`),
    );
  }

  function parseDateOnly(value) {
    if (!value) return null;
    const raw = String(value);
    const date = new Date(raw.includes("T") ? raw : `${raw}T12:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function startOfDay(value) {
    const date = value instanceof Date ? value : parseDateOnly(value);
    if (!date) return null;
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function addDays(value, days) {
    const date = startOfDay(value);
    if (!date) return null;
    date.setDate(date.getDate() + Number(days || 0));
    return date;
  }

  function dayDiff(from, to) {
    const a = startOfDay(from);
    const b = startOfDay(to);
    if (!a || !b) return 0;
    return Math.round((b.getTime() - a.getTime()) / 86400000);
  }

  function formatDayKey(value) {
    const date = startOfDay(value);
    if (!date) return "";
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  /** 甘特条时间：优先 startDate→dueDate；缺省用 createdAt，跨度至少 1 天 */
  function ganttBarRange(task) {
    const created = startOfDay(task.createdAt) || startOfDay(new Date());
    const start = startOfDay(task.startDate) || created;
    let end = startOfDay(task.dueDate);
    if (!end) end = addDays(start, task.startDate || task.dueDate ? 0 : 3);
    if (end < start) end = start;
    return { start, end };
  }

  function collectGanttRows(pool) {
    const roots = rootTasks(pool);
    /** @type {Array<{ task: any, depth: number }>} */
    const rows = [];
    const walk = (task, depth) => {
      rows.push({ task, depth });
      for (const child of childTasksOf(task.id, pool, { sameStatusOnly: true })) {
        walk(child, depth + 1);
      }
    };
    for (const root of roots) walk(root, 0);
    return rows;
  }

  function buildGanttTimeline(rows) {
    const today = startOfDay(new Date());
    let min = today;
    let max = addDays(today, 20);
    for (const { task } of rows) {
      const range = ganttBarRange(task);
      if (range.start < min) min = range.start;
      if (range.end > max) max = range.end;
    }
    min = addDays(min, -2);
    max = addDays(max, 5);
    // 至少展示约 3 周，避免议题少时时间轴过窄
    if (dayDiff(min, max) < 20) max = addDays(min, 20);
    const days = [];
    for (let cursor = new Date(min); cursor <= max; cursor = addDays(cursor, 1)) {
      days.push(new Date(cursor));
    }
    return { start: min, end: max, days, today };
  }

  function renderGantt() {
    const pool = filteredTasks();
    const rows = collectGanttRows(pool);
    if (!rows.length) {
      return `
        <div class="gantt-view">
          <div class="gantt-empty">
            <strong>暂无议题</strong>
            <span>当前筛选下没有可展示的甘特条。</span>
          </div>
        </div>
      `;
    }

    const timeline = buildGanttTimeline(rows);
    const dayCount = Math.max(1, timeline.days.length);
    const labelWidth = 200;
    const todayOffset = dayDiff(timeline.start, timeline.today);
    const showToday = todayOffset >= 0 && todayOffset < dayCount;

    const monthSpans = [];
    for (const day of timeline.days) {
      const key = `${day.getFullYear()}-${day.getMonth()}`;
      const last = monthSpans[monthSpans.length - 1];
      if (last && last.key === key) {
        last.span += 1;
      } else {
        monthSpans.push({
          key,
          span: 1,
          label: new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short" }).format(day),
        });
      }
    }

    const weekday = (day) => ["日", "一", "二", "三", "四", "五", "六"][day.getDay()];
    const pct = (value) => `${((Number(value) / dayCount) * 100).toFixed(4)}%`;

    return `
      <div class="gantt-view" style="--gantt-label-width:${labelWidth}px;--gantt-day-count:${dayCount}">
        <div class="gantt-toolbar">
          <div class="gantt-toolbar-meta">
            <strong>甘特图</strong>
            <span>${rows.length} 条议题 · ${formatDayKey(timeline.start)} → ${formatDayKey(timeline.end)}</span>
          </div>
          <span class="gantt-toolbar-hint">条形按开始/截止日期绘制；未设置日期时用创建日估算</span>
        </div>
        <div class="gantt-scroll">
          <div class="gantt-grid">
            <div class="gantt-corner" aria-hidden="true">议题</div>
            <div class="gantt-timeline-header">
              <div class="gantt-month-row">
                ${monthSpans
                  .map(
                    (month) => `
                      <div class="gantt-month-cell" style="flex:${month.span} 1 0">${escapeHtml(month.label)}</div>
                    `,
                  )
                  .join("")}
              </div>
              <div class="gantt-day-row">
                ${timeline.days
                  .map((day) => {
                    const isToday = formatDayKey(day) === formatDayKey(timeline.today);
                    const isWeekend = day.getDay() === 0 || day.getDay() === 6;
                    return `
                      <div class="gantt-day-cell${isToday ? " is-today" : ""}${isWeekend ? " is-weekend" : ""}" title="${escapeHtml(formatDayKey(day))}">
                        <span class="gantt-day-num">${day.getDate()}</span>
                        <span class="gantt-day-week">${weekday(day)}</span>
                      </div>
                    `;
                  })
                  .join("")}
              </div>
            </div>

            ${rows
              .map(({ task, depth }) => {
                const range = ganttBarRange(task);
                const offset = Math.max(0, dayDiff(timeline.start, range.start));
                const spanDays = Math.max(1, dayDiff(range.start, range.end) + 1);
                const tone = STATUS[task.status]?.tone || "todo";
                const fullTitle = `${task.identifier || ""} ${task.title || ""}`.trim();
                const barLabel = task.identifier || task.title || "";
                const dateHint = [
                  task.startDate ? `开始 ${task.startDate}` : null,
                  task.dueDate ? `截止 ${task.dueDate}` : null,
                  !task.startDate && !task.dueDate ? "日期未设置（估算）" : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
                return `
                  <button
                    type="button"
                    class="gantt-label-cell${depth ? " is-child" : ""}"
                    style="--gantt-depth:${depth}"
                    data-action="open-related-issue"
                    data-task-id="${escapeHtml(task.id)}"
                    title="${escapeHtml(fullTitle)}"
                  >
                    <span class="status-dot ${tone}" aria-hidden="true"></span>
                    <span class="gantt-label-id">${escapeHtml(task.identifier || "")}</span>
                    <span class="gantt-label-title">${escapeHtml(task.title || "")}</span>
                  </button>
                  <div class="gantt-track" data-task-id="${escapeHtml(task.id)}">
                    ${
                      showToday
                        ? `<div class="gantt-today-line" style="left:${pct(todayOffset + 0.5)}" aria-hidden="true"></div>`
                        : ""
                    }
                    <button
                      type="button"
                      class="gantt-bar tone-${tone}${task.startDate || task.dueDate ? "" : " is-estimated"}"
                      style="left:${pct(offset)};width:${pct(spanDays)}"
                      data-action="open-related-issue"
                      data-task-id="${escapeHtml(task.id)}"
                      title="${escapeHtml(`${fullTitle}${dateHint ? ` · ${dateHint}` : ""}`)}"
                    >
                      <span>${escapeHtml(barLabel)}</span>
                    </button>
                  </div>
                `;
              })
              .join("")}
          </div>
        </div>
      </div>
    `;
  }

  function availableLabels() {
    const set = new Set();
    for (const task of state.tasks) {
      for (const label of task.labels || []) set.add(label);
    }
    return [...set];
  }

  function closeMenus() {
    clearSubmenuIntent();
    if (contextMenuOutsideHandler) {
      document.removeEventListener("pointerdown", contextMenuOutsideHandler, true);
      contextMenuOutsideHandler = null;
    }
    state.contextMenu = null;
    state.priorityMenuTaskId = null;
    state.projectMenuOpen = false;
  }

  function copyText(text, toast) {
    void navigator.clipboard?.writeText(text);
    vscode.postMessage({ type: "toast", text: toast });
  }

  function openTask(taskId) {
    state.priorityMenuTaskId = null;
    state.contextMenu = null;
    state.editingDescription = false;
    if (state.selectedTaskId !== taskId) {
      state.replyTo = null;
      state.pendingCommentImages = [];
      state.commentDraft = "";
      state.relationPicker = null;
      state.labelPicker = null;
      state.parentPicker = null;
      state.activityShowCount = ACTIVITY_PREVIEW_COUNT;
      state.outputBookDialog = null;
    }
    if (isSidebar) {
      openIssueInEditor(taskId);
      return;
    }
    state.selectedTaskId = taskId;
    vscode.postMessage({ type: "watchChatSync", taskId });
    render();
  }

  function isChatTurnComment(comment) {
    if (comment?.kind === "chat_turn") return true;
    if (comment?.kind) return false;
    return String(comment?.id || "").startsWith("c-chat-");
  }

  function isAgentReportComment(comment) {
    if (comment?.kind === "agent_report" || comment?.kind === "chat_report") return true;
    if (comment?.kind) return false;
    if (String(comment?.id || "").startsWith("c-report-")) return true;
    return comment?.authorType === "agent" && !isChatTurnComment(comment);
  }

  function chatTurnsUnderReport(report, comments) {
    return comments
      .filter((comment) => comment.parentCommentId === report.id && isChatTurnComment(comment))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  /**
   * Prefer direct children; otherwise attach chat_turns by time window between
   * the previous agent_report and this report.
   */
  function chatTurnsForAgentReport(report, comments) {
    const direct = chatTurnsUnderReport(report, comments);
    if (direct.length) return direct;

    const allTurns = comments.filter((comment) => isChatTurnComment(comment));
    if (!allTurns.length) return [];

    const reports = comments
      .filter((comment) => isAgentReportComment(comment))
      .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
    const idx = reports.findIndex((item) => item.id === report.id);
    const prev = idx > 0 ? reports[idx - 1] : null;
    const start = prev ? String(prev.createdAt || "") : "";
    const end = String(report.createdAt || "");

    return allTurns
      .filter((turn) => {
        const at = String(turn.createdAt || "");
        if (start && at <= start) return false;
        if (end && at > end) return false;
        return true;
      })
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  function renderChatTurn(turn) {
    const isUser = turn.authorType === "user";
    return `
      <div class="chat-turn${isUser ? " is-user" : " is-agent"}">
        <div class="chat-turn-meta">
          <strong>${escapeHtml(isUser ? turn.authorName || "用户" : "Agent")}</strong>
          <time>${escapeHtml(relativeTime(turn.createdAt))}</time>
        </div>
        <div class="chat-turn-body is-markdown">${renderMarkdown(turn.body)}</div>
      </div>
    `;
  }

  /**
   * 同一作者连续的状态变更合并为一行：处理中 → 等你确认 → 处理中
   * @param {Array<Record<string, any>>} items 已按时间排序的活动/评论混合列表
   */
  function collapseConsecutiveStatusChanges(items) {
    const out = [];
    for (const item of items) {
      const isStatusChange =
        item.kind === "change" && (!item.field || item.field === "status");
      const prev = out[out.length - 1];
      const prevIsStatusChange =
        prev &&
        (prev.kind === "change" || prev.kind === "change_chain") &&
        (!prev.field || prev.field === "status");
      const sameActor =
        prev && String(prev.actorName || "") === String(item.actorName || "");

      if (isStatusChange && prevIsStatusChange && sameActor) {
        const chain =
          prev.kind === "change_chain"
            ? [...prev.chain]
            : [prev.before, prev.after];
        if (chain[chain.length - 1] === item.before) {
          chain.push(item.after);
        } else {
          chain.push(item.before, item.after);
        }
        out[out.length - 1] = {
          ...prev,
          kind: "change_chain",
          field: "status",
          chain,
          before: chain[0],
          after: chain[chain.length - 1],
          createdAt: item.createdAt,
          sortAt: item.sortAt || item.createdAt,
        };
        continue;
      }
      out.push(item);
    }
    return out;
  }

  function statusLabel(value) {
    const key = String(value || "");
    if (key in STATUS_TONES) return t(`status.${key}`);
    return key;
  }

  function renderActivityItem(item, comments, taskIdentifier) {
    if (item.kind === "devctx") {
      const lines = String(item.before || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      return `
        <div class="activity-entry activity-devctx">
          <span class="activity-rail-icon">${ICONS.folder}</span>
          <div class="activity-devctx-body">
            <p>
              <strong>${escapeHtml(item.actorName || "用户")}</strong>
              创建了 worktree
              <time>· ${escapeHtml(relativeTime(item.createdAt))}</time>
            </p>
            <div class="activity-devctx-qa">
              ${lines
                .map((line) => {
                  if (line.startsWith("提问：")) {
                    return `<div class="activity-qa-q">${escapeHtml(line.slice(3))}</div>`;
                  }
                  if (line.startsWith("已选")) {
                    return `<div class="activity-qa-a">${escapeHtml(line)}</div>`;
                  }
                  return `<div class="activity-qa-hint">${escapeHtml(line)}</div>`;
                })
                .join("")}
              ${
                item.after
                  ? `<div class="activity-qa-path" title="${escapeHtml(item.after)}">目录 · ${escapeHtml(folderDisplayName(item.after))}</div>`
                  : ""
              }
            </div>
          </div>
        </div>
      `;
    }
    if (item.kind === "change" || item.kind === "change_chain") {
      const chain =
        item.kind === "change_chain" && Array.isArray(item.chain) && item.chain.length >= 2
          ? item.chain
          : [item.before, item.after];
      const chainHtml = chain
        .map(
          (step, index) =>
            `${index ? `<span class="activity-change-arrow" aria-hidden="true">→</span>` : ""}<span class="activity-change-value">${escapeHtml(statusLabel(step))}</span>`,
        )
        .join("");
      return `
        <div class="activity-entry activity-change">
          <span class="activity-rail-icon">${ICONS.pencil}</span>
          <p>
            <strong>${escapeHtml(item.actorName)}</strong>
            ${chain.length > 2 ? "状态" : "将状态从"}
            ${
              chain.length > 2
                ? chainHtml
                : `<span class="activity-change-value">${escapeHtml(statusLabel(chain[0]))}</span>
            改为
            <span class="activity-change-value">${escapeHtml(statusLabel(chain[1]))}</span>`
            }
            <time>· ${escapeHtml(relativeTime(item.createdAt))}</time>
          </p>
        </div>
      `;
    }
    const authorInitials = (item.authorName || "?")
      .split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
    const parent = item.parentCommentId
      ? comments.find((comment) => comment.id === item.parentCommentId)
      : null;
    const replyLabel = item.authorType === "agent" ? "评论工作内容" : "回复";
    const report = isAgentReportComment(item);
    const chatTurns = report ? chatTurnsForAgentReport(item, comments) : [];
    const forks = Array.isArray(item.forkThreadIds) ? item.forkThreadIds : [];
    const forkBubbleId = (() => {
      for (let i = chatTurns.length - 1; i >= 0; i -= 1) {
        const turnId = String(chatTurns[i]?.id || "");
        if (turnId.startsWith("c-chat-")) return turnId.slice("c-chat-".length);
      }
      return "";
    })();
    const expanded = Boolean(state.expandedReports[item.id]);
    return `
      <article class="comment-entry${item.authorType === "agent" ? " is-agent" : ""}${item.parentCommentId ? " is-reply" : ""}${report ? " is-chat-report" : ""}" data-comment-id="${escapeHtml(item.id)}">
        <div class="comment-card">
          <header class="comment-header">
            <span class="avatar${item.authorType === "agent" ? " agent" : ""}">${escapeHtml(authorInitials)}</span>
            <strong>${escapeHtml(item.authorName)}</strong>
            ${item.authorId ? `<span class="actor-id">@${escapeHtml(item.authorId)}</span>` : ""}
            ${report ? `<span class="comment-badge">Agent 工作汇报</span>` : ""}
            <time>${escapeHtml(relativeTime(item.createdAt))}</time>
          </header>
          ${
            parent
              ? `<div class="comment-reply-ref">回复 ${escapeHtml(parent.authorName || "评论")} · ${escapeHtml(commentSnippet(parent.body, 72, parent.attachments))}</div>`
              : ""
          }
          ${item.body ? `<div class="comment-body is-markdown">${renderMarkdown(item.body)}</div>` : ""}
          ${renderCommentAttachments(item.attachments)}
          ${
            report && expanded
              ? `<div class="chat-turn-list" role="region" aria-label="对话内容">
                  ${
                    chatTurns.length
                      ? chatTurns.map((turn) => renderChatTurn(turn)).join("")
                      : `<div class="chat-turn-empty">该时间窗口暂无已同步的 chat_turn，可点右上角「同步对话」</div>`
                  }
                </div>`
              : ""
          }
          <footer class="comment-actions${report ? " has-report-actions" : ""}">
            <button
              type="button"
              class="comment-reply-btn"
              data-action="reply-comment"
              data-comment-id="${escapeHtml(item.id)}"
            >${replyLabel}</button>
            ${
              report
                ? `<div class="comment-actions-end">
                    <button
                      type="button"
                      class="comment-reply-btn"
                      data-action="toggle-report"
                      data-comment-id="${escapeHtml(item.id)}"
                      aria-expanded="${expanded}"
                    >${expanded ? "收起 chat_turn" : `展开 chat_turn${chatTurns.length ? `（${chatTurns.length}）` : ""}`}</button>
                    <button
                      type="button"
                      class="comment-reply-btn"
                      data-action="fork-chat"
                      data-task-id="${escapeHtml(taskIdentifier)}"
                      data-comment-id="${escapeHtml(item.id)}"
                      data-bubble-id="${escapeHtml(forkBubbleId)}"
                    >fork chat</button>
                  </div>`
                : ""
            }
          </footer>
          ${
            report && forks.length
              ? `<div class="comment-forks" aria-label="Fork 对话列表">
                  <span class="comment-forks-label">Forks · ${forks.length}</span>
                  ${forks
                    .map(
                      (fork, index) => `
                    <button
                      type="button"
                      class="comment-fork-chip"
                      data-action="open-thread"
                      data-task-id="${escapeHtml(taskIdentifier)}"
                      data-thread-id="${escapeHtml(fork.threadId)}"
                      title="${escapeHtml(fork.threadId)}"
                    >Fork ${index + 1}${fork.createdAt ? ` · ${escapeHtml(relativeTime(fork.createdAt))}` : ""}</button>`,
                    )
                    .join("")}
                </div>`
              : ""
          }
          ${item.threadId ? `<div class="comment-conversation-link">${conversationLink(item.threadId, taskIdentifier)}</div>` : ""}
        </div>
      </article>
    `;
  }

  function menuItem({
    label,
    icon = "",
    shortcut = "",
    checked = false,
    danger = false,
    submenu = "",
    action = "",
    value = "",
  }) {
    const open = state.contextMenu?.submenu === submenu;
    return `
      <div class="context-menu-item-anchor">
        <button
          type="button"
          class="context-menu-item${danger ? " is-danger" : ""}"
          data-menu-action="${escapeHtml(action)}"
          data-menu-value="${escapeHtml(value)}"
          data-submenu="${escapeHtml(submenu)}"
          data-open="${open ? "true" : "false"}"
          ${submenu ? `aria-haspopup="menu" aria-expanded="${open}"` : ""}
        >
          <span class="context-menu-icon">${icon}</span>
          <span class="context-menu-label">${escapeHtml(label)}</span>
          ${shortcut ? `<span class="context-menu-shortcut">${escapeHtml(shortcut)}</span>` : ""}
          ${checked ? `<span class="context-menu-check">${ICONS.check}</span>` : ""}
          ${submenu ? `<span class="context-menu-chevron">${ICONS.chevronRight}</span>` : ""}
        </button>
      </div>
    `;
  }

  function renderSubmenuPanel(name, task) {
    if (state.contextMenu?.submenu !== name) return "";
    if (name === "status") {
      return `<div class="context-submenu" role="menu">${STATUS_ORDER.map((status, index) => menuItem({
        label: STATUS[status].label,
        icon: `<span class="status-dot ${STATUS[status].tone}"></span>`,
        shortcut: String(index + 1),
        checked: task.status === status,
        action: "set-status",
        value: status,
      })).join("")}</div>`;
    }
    if (name === "priority") {
      return `<div class="context-submenu" role="menu">${PRIORITY_ORDER.map((priority, index) => menuItem({
        label: PRIORITY_LABELS[priority],
        icon: priorityIcon(priority),
        shortcut: String(index),
        checked: task.priority === priority,
        action: "set-priority",
        value: priority,
      })).join("")}</div>`;
    }
    if (name === "labels") {
      const labels = availableLabels();
      return `<div class="context-submenu labels-submenu" role="menu">
        ${labels.length
          ? labels.map((label) => menuItem({
            label,
            icon: ICONS.label,
            checked: (task.labels || []).includes(label),
            action: "toggle-label",
            value: label,
          })).join("")
          : `<button type="button" class="context-menu-item" disabled><span class="context-menu-label">暂无可用标签</span></button>`}
        <div class="context-menu-divider"></div>
        ${menuItem({ label: "在编辑器中管理…", icon: ICONS.pencil, action: "edit" })}
      </div>`;
    }
    if (name === "copy") {
      return `<div class="context-submenu" role="menu">
        ${menuItem({ label: "复制议题 ID", action: "copy-id" })}
        ${menuItem({ label: "复制标题", action: "copy-title" })}
        ${menuItem({ label: "复制 Markdown", action: "copy-md" })}
      </div>`;
    }
    return "";
  }

  function pickSubmenuSide(menuLeft, menuWidth, submenuWidth = 200) {
    const spaceRight = window.innerWidth - (menuLeft + menuWidth);
    const spaceLeft = menuLeft;
    if (spaceRight >= submenuWidth + 8) return "right";
    if (spaceLeft >= submenuWidth + 8) return "left";
    return spaceRight >= spaceLeft ? "right" : "left";
  }

  function renderContextMenu() {
    const menu = state.contextMenu;
    if (!menu) return "";
    const task = state.tasks.find((item) => item.id === menu.taskId);
    if (!task) return "";
    // 窄侧栏里不能默认向左展开，否则会被裁切；先按点击位置粗判，渲染后再精算
    const side = menu.submenuSide
      || pickSubmenuSide(menu.x, 180);

    function itemWithSubmenu({ label, icon, shortcut, submenu }) {
      return `
        <div class="context-menu-item-anchor">
          <button
            type="button"
            class="context-menu-item"
            data-submenu="${submenu}"
            data-open="${menu.submenu === submenu ? "true" : "false"}"
            aria-haspopup="menu"
            aria-expanded="${menu.submenu === submenu}"
          >
            <span class="context-menu-icon">${icon}</span>
            <span class="context-menu-label">${escapeHtml(label)}</span>
            <span class="context-menu-shortcut">${escapeHtml(shortcut)}</span>
            <span class="context-menu-chevron">${ICONS.chevronRight}</span>
          </button>
          ${renderSubmenuPanel(submenu, task)}
        </div>
      `;
    }

    return `
      <div class="task-context-menu" role="menu" data-submenu-side="${side}" style="left:${menu.x}px;top:${menu.y}px" aria-label="${escapeHtml(task.identifier)} 操作">
        <div class="context-menu-group">
          ${itemWithSubmenu({ label: "状态", icon: ICONS.status, shortcut: "S", submenu: "status" })}
          ${itemWithSubmenu({ label: "优先级", icon: priorityIcon(task.priority), shortcut: "P", submenu: "priority" })}
          ${itemWithSubmenu({ label: "标签", icon: ICONS.label, shortcut: "L", submenu: "labels" })}
        </div>
        <div class="context-menu-divider"></div>
        <div class="context-menu-group">
          ${menuItem({ label: "编辑议题", icon: ICONS.pencil, shortcut: "↵", action: "edit" })}
          ${menuItem({ label: "创建副本", icon: ICONS.copy, action: "duplicate" })}
          <div class="context-menu-item-anchor">
            <button type="button" class="context-menu-item" data-submenu="copy" data-open="${menu.submenu === "copy" ? "true" : "false"}" aria-haspopup="menu" aria-expanded="${menu.submenu === "copy"}">
              <span class="context-menu-icon">${ICONS.copy}</span>
              <span class="context-menu-label">复制</span>
              <span class="context-menu-chevron">${ICONS.chevronRight}</span>
            </button>
            ${renderSubmenuPanel("copy", task)}
          </div>
          ${menuItem({ label: "在对话中打开", icon: ICONS.link, action: "open-chat" })}
        </div>
        <div class="context-menu-divider"></div>
        <div class="context-menu-group">
          ${menuItem({ label: "归档议题", icon: ICONS.trash, shortcut: "⌘⌫", danger: true, action: "archive" })}
        </div>
      </div>
    `;
  }

  function renderPriorityMenu(task) {
    if (state.priorityMenuTaskId !== task.id) return "";
    return `
      <div class="priority-menu" role="menu" aria-label="选择优先级" data-priority-menu-for="${escapeHtml(task.id)}">
        ${PRIORITY_ORDER.map((priority) => `
          <button
            type="button"
            class="priority-menu-item priority-${priority}"
            data-action="set-priority"
            data-task-id="${escapeHtml(task.id)}"
            data-priority="${priority}"
          >
            ${priorityIcon(priority)}
            <span>${escapeHtml(PRIORITY_LABELS[priority])}</span>
            ${task.priority === priority ? `<span class="priority-check">${ICONS.check}</span>` : ""}
          </button>
        `).join("")}
      </div>
    `;
  }

  const app = document.getElementById("app");

  function projectName() {
    if (state.projectId === ALL_PROJECT_ID) return t("project.all");
    return state.projects.find((p) => p.id === state.projectId)?.name || t("project.manage");
  }

  async function applyLocale(nextLocale) {
    const locale = I18n.normalize(nextLocale);
    if (locale === state.locale) return;
    state.locale = locale;
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    document.body.setAttribute("data-locale", locale);
    render();
    try {
      await storeRequest("ui.setLocale", { locale }, { timeoutMs: 10000 });
    } catch {
      // ignore persistence errors; UI already switched
    }
  }

  function projectChoices() {
    const q = state.projectQuery.trim().toLowerCase();
    const all = [{ id: ALL_PROJECT_ID, name: t("project.all") }, ...state.projects];
    if (!q) return all;
    return all.filter((project) => project.name.toLowerCase().includes(q));
  }

  function filteredTasks() {
    const q = state.search.trim().toLowerCase();
    return state.tasks.filter((task) => {
      if (state.projectId !== ALL_PROJECT_ID && task.projectId !== state.projectId) {
        return false;
      }
      if (!q) return true;
      return [task.identifier, task.title, task.description, ...(task.labels || [])]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }

  /**
   * @param {string} parentId
   * @param {any[]} [pool]
   * @param {{ sameStatusOnly?: boolean }} [options]
   *   sameStatusOnly: 列表/看板嵌套时只显示与父议题同状态的子议题；
   *   归档（canceled）等不同状态的子议题会在自己的分组里独立展示。
   */
  function childTasksOf(parentId, pool = filteredTasks(), options = {}) {
    const sameStatusOnly = Boolean(options.sameStatusOnly);
    let parentStatus = options.parentStatus;
    if (sameStatusOnly && parentStatus === undefined) {
      const parent =
        pool.find((task) => task.id === parentId) || state.tasks.find((task) => task.id === parentId);
      parentStatus = parent?.status;
    }
    return pool
      .filter((task) => task.parentIssueId === parentId)
      .filter((task) => !sameStatusOnly || task.status === parentStatus)
      .sort((a, b) => String(a.identifier).localeCompare(String(b.identifier), "zh-CN"));
  }

  function rootTasks(pool = filteredTasks()) {
    const byId = new Map(pool.map((task) => [task.id, task]));
    return pool.filter((task) => {
      if (!task.parentIssueId) return true;
      const parent = byId.get(task.parentIssueId);
      if (!parent) return true;
      // 与父议题状态不同时独立成行（归档后进入「取消」分组，而不是卡在父议题下）
      return parent.status !== task.status;
    });
  }

  function parentCandidates(task) {
    const query = String(state.parentPicker?.query || "")
      .trim()
      .toLowerCase();
    const blocked = new Set([task.id]);
    const queue = [task.id];
    while (queue.length) {
      const id = queue.pop();
      for (const child of state.tasks.filter((item) => item.parentIssueId === id)) {
        if (blocked.has(child.id)) continue;
        blocked.add(child.id);
        queue.push(child.id);
      }
    }
    return state.tasks
      .filter((item) => !blocked.has(item.id))
      .filter((item) => {
        if (state.projectId !== ALL_PROJECT_ID && item.projectId !== state.projectId) return false;
        if (!query) return true;
        return (
          String(item.identifier || "").toLowerCase().includes(query) ||
          String(item.title || "").toLowerCase().includes(query)
        );
      })
      .slice(0, 8);
  }

  function resolveParentIssue(task) {
    if (task.parentIssue?.id) return task.parentIssue;
    if (!task.parentIssueId) return null;
    const parent = state.tasks.find((item) => item.id === task.parentIssueId);
    if (!parent) return null;
    return { id: parent.id, identifier: parent.identifier, title: parent.title };
  }

  function renderParentLink(task) {
    const parent = resolveParentIssue(task);
    const picking = Boolean(state.parentPicker);
    const candidates = picking ? parentCandidates(task) : [];
    return `
      <div class="issue-parent-block">
        <div class="issue-parent-link">
          ${
            parent
              ? `<button
                  type="button"
                  class="issue-parent-current"
                  data-action="open-related-issue"
                  data-task-id="${escapeHtml(parent.id)}"
                  title="${escapeHtml(parent.title || "")}"
                >
                  <span class="issue-parent-label">父议题</span>
                  <span class="relation-id">${escapeHtml(parent.identifier)}</span>
                  <span class="issue-parent-title">${escapeHtml(parent.title || "")}</span>
                </button>
                <button type="button" class="ghost-link" data-action="toggle-parent-picker">${picking ? "取消" : "更改"}</button>
                <button
                  type="button"
                  class="issue-parent-clear"
                  data-action="clear-parent"
                  data-task-id="${escapeHtml(task.id)}"
                  title="清除父议题"
                  aria-label="清除父议题"
                >×</button>`
              : `<button type="button" data-action="toggle-parent-picker">${picking ? "取消" : "+ 设置父议题"}</button>`
          }
        </div>
        ${
          picking
            ? `<div class="parent-picker relation-picker">
                <input
                  type="search"
                  class="parent-picker-input relation-picker-input"
                  placeholder="搜索父议题编号或标题…"
                  value="${escapeHtml(state.parentPicker?.query || "")}"
                  aria-label="搜索父议题"
                />
                <div class="relation-picker-list">
                  ${
                    candidates.length
                      ? candidates
                          .map(
                            (item) => `
                      <button
                        type="button"
                        class="relation-picker-option"
                        data-action="parent-pick"
                        data-task-id="${escapeHtml(task.id)}"
                        data-target-id="${escapeHtml(item.id)}"
                      >
                        <span class="relation-id">${escapeHtml(item.identifier)}</span>
                        <span class="relation-title">${escapeHtml(item.title || "")}</span>
                      </button>`,
                          )
                          .join("")
                      : `<div class="relation-picker-empty">没有可选的父议题</div>`
                  }
                </div>
              </div>`
            : ""
        }
      </div>
    `;
  }

  function renderSubIssuesSection(task) {
    const children = childTasksOf(task.id, state.tasks);
    return `
      <section class="issue-sub-issues" aria-label="子议题">
        <header>
          <div>
            <h2>子议题</h2>
            <span>${children.length}</span>
          </div>
          <button class="ghost-link" type="button" data-action="add-subissue" data-task-id="${escapeHtml(task.id)}">+ 添加子议题</button>
        </header>
        ${
          children.length
            ? `<ul class="subissue-list">
                ${children
                  .map((child) => {
                    const tone = STATUS[child.status]?.tone || "neutral";
                    return `
                      <li class="subissue-item">
                        <button
                          type="button"
                          class="subissue-link"
                          data-action="open-related-issue"
                          data-task-id="${escapeHtml(child.id)}"
                          title="${escapeHtml(child.title || "")}"
                        >
                          <span class="status-dot ${tone}" aria-hidden="true"></span>
                          <span class="relation-id">${escapeHtml(child.identifier)}</span>
                          <span class="subissue-title">${escapeHtml(child.title || "")}</span>
                        </button>
                      </li>`;
                  })
                  .join("")}
              </ul>`
            : `<p class="subissue-empty">暂无子议题</p>`
        }
      </section>
    `;
  }

  function selectedTask() {
    // 侧栏只展示看板；议题详情一律在右侧编辑器面板打开
    if (isSidebar) return null;
    return state.tasks.find((task) => task.id === state.selectedTaskId) || null;
  }

  function upsertTask(task) {
    if (!task || !task.id) return;
    const index = state.tasks.findIndex((item) => item.id === task.id);
    if (index >= 0) {
      state.tasks[index] = { ...state.tasks[index], ...task };
    } else {
      state.tasks.unshift(task);
    }
  }

  function openIssueInEditor(taskId) {
    vscode.postMessage({
      type: "openIssueInEditor",
      taskId,
    });
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  /** 行内 Markdown：code / bold / italic / link（文本已先 escape） */
  function renderInlineMarkdown(raw) {
    let text = escapeHtml(raw);
    /** @type {string[]} */
    const slots = [];
    const park = (html) => {
      const key = `\u0000MD${slots.length}\u0000`;
      slots.push(html);
      return key;
    };
    text = text.replace(/`([^`\n]+)`/g, (_, code) => park(`<code>${code}</code>`));
    text = text.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      (_, label, href) =>
        park(`<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>`),
    );
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
    text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    text = text.replace(/(?<!_)_([^_\n]+)_(?!_)/g, "<em>$1</em>");
    text = text.replace(/\u0000MD(\d+)\u0000/g, (_, index) => slots[Number(index)] || "");
    return text;
  }

  function isTableSeparator(line) {
    const cells = String(line || "")
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  function splitTableRow(line) {
    return String(line || "")
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
  }

  /**
   * 轻量 Markdown → 安全 HTML（标题/列表/表格/代码块/引用等）。
   * 不解析原始 HTML，避免 XSS。
   */
  function renderMarkdown(source) {
    const text = String(source ?? "").replace(/\r\n/g, "\n");
    if (!text.trim()) return "";
    const lines = text.split("\n");
    /** @type {string[]} */
    const out = [];
    let i = 0;

    const flushParagraph = (buf) => {
      const body = buf.join("\n").trim();
      if (!body) return;
      out.push(`<p>${renderInlineMarkdown(body).replace(/\n/g, "<br>")}</p>`);
    };

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        i += 1;
        continue;
      }

      const fence = trimmed.match(/^```([\w+-]*)\s*$/);
      if (fence) {
        i += 1;
        const codeLines = [];
        while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
          codeLines.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) i += 1;
        const lang = fence[1] ? ` data-lang="${escapeHtml(fence[1])}"` : "";
        out.push(`<pre class="md-code"${lang}><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        continue;
      }

      if (
        trimmed.includes("|") &&
        i + 1 < lines.length &&
        isTableSeparator(lines[i + 1])
      ) {
        const header = splitTableRow(trimmed);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim().includes("|") && !isTableSeparator(lines[i])) {
          rows.push(splitTableRow(lines[i]));
          i += 1;
        }
        out.push(
          `<div class="md-table-wrap"><table class="md-table"><thead><tr>${header
            .map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`)
            .join("")}</tr></thead><tbody>${rows
            .map(
              (row) =>
                `<tr>${header
                  .map((_, idx) => `<td>${renderInlineMarkdown(row[idx] || "")}</td>`)
                  .join("")}</tr>`,
            )
            .join("")}</tbody></table></div>`,
        );
        continue;
      }

      const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        const level = heading[1].length;
        out.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
        i += 1;
        continue;
      }

      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        out.push("<hr>");
        i += 1;
        continue;
      }

      if (/^>\s?/.test(trimmed)) {
        const quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
          quote.push(lines[i].trim().replace(/^>\s?/, ""));
          i += 1;
        }
        out.push(`<blockquote>${renderInlineMarkdown(quote.join("\n")).replace(/\n/g, "<br>")}</blockquote>`);
        continue;
      }

      if (/^([-*+]|\d+\.)\s+/.test(trimmed)) {
        const ordered = /^\d+\.\s+/.test(trimmed);
        const tag = ordered ? "ol" : "ul";
        const items = [];
        while (i < lines.length) {
          const item = lines[i].trim().match(ordered ? /^(\d+)\.\s+(.+)$/ : /^[-*+]\s+(.+)$/);
          if (!item) break;
          items.push(`<li>${renderInlineMarkdown(ordered ? item[2] : item[1])}</li>`);
          i += 1;
        }
        out.push(`<${tag}>${items.join("")}</${tag}>`);
        continue;
      }

      const para = [];
      while (i < lines.length) {
        const next = lines[i];
        const nextTrim = next.trim();
        if (!nextTrim) break;
        if (/^```/.test(nextTrim)) break;
        if (/^#{1,6}\s+/.test(nextTrim)) break;
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(nextTrim)) break;
        if (/^>\s?/.test(nextTrim)) break;
        if (/^([-*+]|\d+\.)\s+/.test(nextTrim)) break;
        if (
          nextTrim.includes("|") &&
          i + 1 < lines.length &&
          isTableSeparator(lines[i + 1])
        ) {
          break;
        }
        para.push(next);
        i += 1;
      }
      flushParagraph(para);
    }

    return out.join("");
  }

  /** @param {string | null | undefined} value */
  function parseWorktreePaths(value) {
    const text = String(value || "").trim();
    if (!text) return [];
    if (text.startsWith("[")) {
      try {
        const arr = JSON.parse(text);
        if (Array.isArray(arr)) {
          return [...new Set(arr.map((item) => String(item || "").trim()).filter(Boolean))];
        }
      } catch {
        // fall through
      }
    }
    return [...new Set(text.split(/\r?\n+/).map((line) => line.trim()).filter(Boolean))];
  }

  /** @param {string} folderPath */
  function folderDisplayName(folderPath) {
    const normalized = String(folderPath || "").replace(/[/\\]+$/, "");
    const parts = normalized.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] || normalized || folderPath;
  }

  /**
   * 开发上下文芯片文案：worktree 显示「仓库 / 目录」，避免多个同名 worktree 无法区分。
   * @param {string} folderPath
   * @param {string[]} [allPaths]
   * @returns {{ leaf: string, repo: string, label: string, title: string, isWorktree: boolean }}
   */
  function contextFolderDisplay(folderPath, allPaths = []) {
    const full = String(folderPath || "");
    const normalized = full.replace(/[/\\]+$/, "");
    const parts = normalized.split(/[/\\]/).filter(Boolean);
    const leaf = parts[parts.length - 1] || normalized || full;
    let repo = "";
    let isWorktree = false;

    for (let i = 0; i < parts.length - 1; i += 1) {
      if (parts[i] === ".cursor" && parts[i + 1] === "worktrees" && parts[i + 2] && i > 0) {
        repo = parts[i - 1];
        isWorktree = true;
        break;
      }
    }
    if (!repo) {
      const wtIdx = parts.lastIndexOf("worktrees");
      if (wtIdx > 0 && wtIdx < parts.length - 1) {
        const parent = parts[wtIdx - 1];
        repo = parent === ".cursor" && wtIdx > 1 ? parts[wtIdx - 2] : parent;
        isWorktree = true;
      }
    }

    const leafDup =
      Array.isArray(allPaths) &&
      allPaths.filter((item) => folderDisplayName(item) === leaf).length > 1;
    if (!repo && leafDup && parts.length >= 2) {
      repo = parts[parts.length - 2];
    }

    const label = repo ? `${repo} / ${leaf}` : leaf;
    return { leaf, repo, label, title: full, isWorktree };
  }

  /** @param {{ leaf: string, repo: string, label: string }} display */
  function renderContextFolderName(display) {
    if (display.repo) {
      return `<span class="devctx-folder-name" title="${escapeHtml(display.label)}">
        <span class="devctx-folder-repo">${escapeHtml(display.repo)}</span>
        <span class="devctx-folder-sep">/</span>
        <span class="devctx-folder-leaf">${escapeHtml(display.leaf)}</span>
      </span>`;
    }
    return `<span class="devctx-folder-name">${escapeHtml(display.leaf)}</span>`;
  }

  function closeWorktreeWizard() {
    state.worktreeWizard = null;
    render();
  }

  function closeGitDialog() {
    state.gitDialog = null;
    render();
  }

  function closeGitSelectDialog() {
    state.gitSelectDialog = null;
    render();
  }

  /** @param {string} url */
  function guessRepoFolderName(url) {
    const match = String(url || "")
      .trim()
      .replace(/\/+$/, "")
      .match(/([^/:]+?)(?:\.git)?$/);
    return match?.[1] || "repo";
  }

  /** @param {string[]} branches @param {string} preferred */
  function pickDefaultRemoteBranch(branches, preferred) {
    const list = Array.isArray(branches) ? branches : [];
    if (!list.length) return "";
    const want = String(preferred || "").trim();
    if (want && list.includes(want)) return want;
    if (list.includes("main")) return "main";
    if (list.includes("master")) return "master";
    return list[0];
  }

  function gitSelectCanClone(dialog = state.gitSelectDialog) {
    if (!dialog || dialog.busy || dialog.fetching) return false;
    return Boolean(
      String(dialog.gitUrl || "").trim() &&
        String(dialog.selectedBranch || "").trim() &&
        dialog.cloneParent &&
        String(dialog.cloneFolderName || "").trim(),
    );
  }

  function syncGitSelectDialogFromDom() {
    const dialog = state.gitSelectDialog;
    if (!dialog) return null;
    const urlInput = app.querySelector("[data-git-select-field='gitUrl']");
    const folderInput = app.querySelector("[data-git-select-field='cloneFolderName']");
    const branchSelect = app.querySelector("[data-action='git-select-branch']");
    if (urlInput instanceof HTMLInputElement) dialog.gitUrl = urlInput.value;
    if (folderInput instanceof HTMLInputElement) dialog.cloneFolderName = folderInput.value;
    if (branchSelect instanceof HTMLSelectElement) dialog.selectedBranch = branchSelect.value;
    return dialog;
  }

  function gitSelectDialogStillOpen(dialog) {
    if (!state.gitSelectDialog || !dialog) return false;
    if (state.gitSelectDialog.mode !== dialog.mode) return false;
    if (dialog.mode === "issue") return state.gitSelectDialog.taskId === dialog.taskId;
    return true;
  }

  function openGitSelectDialog(taskId) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return;
    const project = (state.projects || []).find((item) => item.id === task.projectId);
    const projectUrls = Array.isArray(project?.gitUrls)
      ? project.gitUrls
      : project?.gitUrl
        ? [project.gitUrl]
        : [];
    const seedUrl = String(projectUrls[0] || "").trim();
    state.gitSelectDialog = {
      mode: "issue",
      taskId,
      gitUrl: seedUrl,
      cloneParent: "",
      cloneFolderName: seedUrl ? guessRepoFolderName(seedUrl) : "",
      branches: [],
      selectedBranch: String(task.gitBranch || "").trim(),
      fetching: false,
      busy: false,
      error: "",
    };
    render();
  }

  function openProjectGitSelectDialog() {
    if (!state.projectWizard || state.projectWizard.busy) return;
    state.gitSelectDialog = {
      mode: "project",
      taskId: "",
      gitUrl: "",
      cloneParent: "",
      cloneFolderName: "",
      branches: [],
      selectedBranch: "",
      fetching: false,
      busy: false,
      error: "",
    };
    render();
  }

  async function fetchGitSelectBranches() {
    const dialog = syncGitSelectDialogFromDom();
    if (!dialog || dialog.busy || dialog.fetching) return;
    const url = String(dialog.gitUrl || "").trim();
    if (!url) {
      dialog.error = "请先填写 git 地址";
      render();
      return;
    }
    if (!dialog.cloneFolderName) {
      dialog.cloneFolderName = guessRepoFolderName(url);
    }
    dialog.fetching = true;
    dialog.error = "";
    render();
    try {
      const result = await storeRequest(
        "git.listRemoteBranches",
        { url },
        { timeoutMs: 60000 },
      );
      if (!gitSelectDialogStillOpen(dialog)) return;
      const branches = Array.isArray(result.branches) ? result.branches.map(String) : [];
      const task =
        dialog.mode === "issue" ? state.tasks.find((item) => item.id === dialog.taskId) : null;
      state.gitSelectDialog = {
        ...state.gitSelectDialog,
        branches,
        selectedBranch: pickDefaultRemoteBranch(branches, dialog.selectedBranch || task?.gitBranch),
        fetching: false,
        error: branches.length ? "" : "未找到远端分支",
      };
      render();
    } catch (error) {
      if (!gitSelectDialogStillOpen(dialog)) return;
      state.gitSelectDialog = {
        ...state.gitSelectDialog,
        fetching: false,
        branches: [],
        selectedBranch: "",
        error: error instanceof Error ? error.message : "读取远端分支失败",
      };
      render();
    }
  }

  async function submitGitSelectClone() {
    const dialog = syncGitSelectDialogFromDom();
    if (!dialog || !gitSelectCanClone(dialog)) {
      if (dialog) {
        dialog.error = "请填写 git 地址、选择分支，并指定克隆目录";
        render();
      }
      return;
    }
    const gitUrl = String(dialog.gitUrl || "").trim();
    const branch = String(dialog.selectedBranch || "").trim();
    const cloneDest = `${dialog.cloneParent.replace(/[\\/]+$/, "")}/${String(dialog.cloneFolderName || "").trim()}`;
    dialog.busy = true;
    dialog.error = "";
    render();
    try {
      if (dialog.mode === "project") {
        if (!state.projectWizard) throw new Error("项目表单已关闭");
        await storeRequest(
          "git.cloneOnly",
          { gitUrl, branch, cloneDest },
          { timeoutMs: 300000 },
        );
        const folders = [...new Set([...(state.projectWizard.folders || []), cloneDest])];
        const gitUrls = [...new Set([...(state.projectWizard.gitUrls || []), gitUrl])];
        state.projectWizard = {
          ...state.projectWizard,
          folders,
          gitUrls,
          gitUrl: gitUrls[0] || "",
          error: "",
        };
        state.gitSelectDialog = null;
        render();
        vscode.postMessage({
          type: "toast",
          text: `已克隆并加入项目：${cloneDest}（${branch}）`,
        });
        return;
      }

      const result = await storeRequest(
        "git.cloneAsContext",
        {
          taskId: dialog.taskId,
          gitUrl,
          branch,
          cloneDest,
        },
        { timeoutMs: 300000 },
      );
      state.gitSelectDialog = null;
      render();
      vscode.postMessage({
        type: "toast",
        text: `已克隆并绑定：${result.path || cloneDest}（${result.branch || branch}）`,
      });
      vscode.postMessage({ type: "store.getSnapshot" });
    } catch (error) {
      if (!state.gitSelectDialog) return;
      state.gitSelectDialog = {
        ...state.gitSelectDialog,
        busy: false,
        error: error instanceof Error ? error.message : "克隆失败",
      };
      render();
    }
  }

  function renderGitSelectDialog() {
    const dialog = state.gitSelectDialog;
    if (!dialog) return "";
    const cloneDest =
      dialog.cloneParent && dialog.cloneFolderName
        ? `${dialog.cloneParent.replace(/[\\/]+$/, "")}/${dialog.cloneFolderName}`
        : "";
    const canClone = gitSelectCanClone(dialog);
    const disabled = dialog.busy || dialog.fetching;
    const isProject = dialog.mode === "project";

    return `
      <div class="sync-props-backdrop" data-git-select-backdrop="1" role="presentation">
        <div class="sync-props-dialog git-select-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(isProject ? t("gitSelect.addTitle") : t("gitSelect.title"))}">
          <header class="sync-props-header">
            <div>
              <h3>${escapeHtml(isProject ? t("gitSelect.addTitle") : t("gitSelect.title"))}</h3>
              <p>${escapeHtml(isProject ? t("gitSelect.descProject") : t("gitSelect.descIssue"))}</p>
            </div>
            <button type="button" class="sync-props-close" data-action="git-select-close" aria-label="${escapeHtml(t("common.close"))}" ${dialog.busy ? "disabled" : ""}>×</button>
          </header>
          <div class="sync-props-body git-select-body">
            ${dialog.error ? `<div class="wt-wizard-error">${escapeHtml(dialog.error)}</div>` : ""}
            <label class="project-field">
              <span>${escapeHtml(t("gitSelect.url"))}</span>
              <input
                type="text"
                data-git-select-field="gitUrl"
                value="${escapeHtml(dialog.gitUrl)}"
                placeholder="https://github.com/org/repo.git"
                ${disabled ? "disabled" : ""}
                autocomplete="off"
                spellcheck="false"
              />
            </label>
            <div class="git-select-branch-row">
              <label class="git-branch-field git-select-branch-field">
                <span>${escapeHtml(t("gitSelect.branch"))}</span>
                <select data-action="git-select-branch" ${disabled || !dialog.branches.length ? "disabled" : ""}>
                  ${
                    dialog.branches.length
                      ? dialog.branches
                          .map(
                            (branch) =>
                              `<option value="${escapeHtml(branch)}"${branch === dialog.selectedBranch ? " selected" : ""}>${escapeHtml(branch)}</option>`,
                          )
                          .join("")
                      : `<option value="">${escapeHtml(dialog.fetching ? t("gitSelect.reading") : t("gitSelect.fetchFirst"))}</option>`
                  }
                </select>
              </label>
              <button type="button" class="devctx-btn" data-action="git-select-fetch" ${disabled || !String(dialog.gitUrl || "").trim() ? "disabled" : ""}>
                ${escapeHtml(dialog.fetching ? t("gitSelect.fetching") : t("gitSelect.fetch"))}
              </button>
            </div>
            <label class="project-field">
              <span>${escapeHtml(t("gitSelect.folderName"))}</span>
              <input
                type="text"
                data-git-select-field="cloneFolderName"
                value="${escapeHtml(dialog.cloneFolderName)}"
                placeholder="repo"
                ${disabled ? "disabled" : ""}
                autocomplete="off"
                spellcheck="false"
              />
            </label>
            <div class="project-folder-row">
              <button type="button" class="devctx-btn" data-action="git-select-pick-parent" ${disabled ? "disabled" : ""}>${escapeHtml(t("gitSelect.pickParent"))}</button>
              <span class="project-folder-hint">${escapeHtml(cloneDest || dialog.cloneParent || t("gitSelect.noParent"))}</span>
            </div>
            <p class="wt-wizard-hint">${escapeHtml(isProject ? t("gitSelect.hintProject") : t("gitSelect.hintIssue"))}</p>
          </div>
          <footer class="sync-props-footer">
            <button type="button" class="devctx-btn" data-action="git-select-close" ${dialog.busy ? "disabled" : ""}>${escapeHtml(t("gitSelect.cancel"))}</button>
            <button type="button" class="devctx-btn primary" data-action="git-select-clone" ${canClone ? "" : "disabled"}>
              ${escapeHtml(
                dialog.busy
                  ? t("gitSelect.cloning")
                  : isProject
                    ? t("gitSelect.cloneProject")
                    : t("gitSelect.cloneIssue"),
              )}
            </button>
          </footer>
        </div>
      </div>
    `;
  }

  function activeGitRepo() {
    const dialog = state.gitDialog;
    if (!dialog?.repos?.length) return null;
    const index = Math.min(Math.max(0, dialog.activeIndex || 0), dialog.repos.length - 1);
    return dialog.repos[index] || null;
  }

  async function openGitDialog(taskId) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return;
    const paths = parseWorktreePaths(task.worktreePath);
    if (!paths.length) {
      vscode.postMessage({ type: "toast", text: "请先绑定开发上下文字目录" });
      return;
    }
    const defaultMessage = `${task.identifier || ""}: ${task.title || ""}`.replace(/^:\s*/, "").trim();
    const suggestedBranch =
      String(task.gitBranch || "").trim() ||
      (task.identifier ? `issue/${task.identifier}` : "");
    state.gitDialog = {
      taskId,
      loading: true,
      busy: false,
      error: "",
      message: defaultMessage,
      activeIndex: 0,
      creatingBranch: false,
      newBranchName: suggestedBranch,
      busyMode: "",
      repos: [],
    };
    render();
    try {
      const result = await storeRequest("git.inspect", { paths }, { timeoutMs: 30000 });
      if (!state.gitDialog || state.gitDialog.taskId !== taskId) return;
      const repos = Array.isArray(result.repos) ? result.repos : [];
      const firstGit = Math.max(
        0,
        repos.findIndex((item) => item && item.isGit),
      );
      state.gitDialog = {
        ...state.gitDialog,
        loading: false,
        repos,
        activeIndex: firstGit >= 0 ? firstGit : 0,
        error: repos.some((item) => item?.isGit)
          ? ""
          : "开发上下文中的文件夹都不是 Git 仓库",
      };
      render();
    } catch (error) {
      if (!state.gitDialog || state.gitDialog.taskId !== taskId) return;
      state.gitDialog = {
        ...state.gitDialog,
        loading: false,
        error: error instanceof Error ? error.message : "读取 Git 状态失败",
      };
      render();
    }
  }

  async function refreshActiveGitRepo(mutator) {
    const dialog = state.gitDialog;
    if (!dialog) return;
    const index = dialog.activeIndex || 0;
    const current = dialog.repos[index];
    if (!current) return;
    state.gitDialog = { ...dialog, busy: true, error: "" };
    render();
    try {
      const next = await mutator(current);
      if (!state.gitDialog) return;
      const repos = [...state.gitDialog.repos];
      repos[index] = {
        ...next,
        files: (next.files || []).map((file) => ({
          ...file,
          selected: file.selected !== false,
        })),
      };
      state.gitDialog = {
        ...state.gitDialog,
        busy: false,
        repos,
        error: "",
      };
      render();
      return next;
    } catch (error) {
      if (!state.gitDialog) return;
      state.gitDialog = {
        ...state.gitDialog,
        busy: false,
        error: error instanceof Error ? error.message : "操作失败",
      };
      render();
      return null;
    }
  }

  function renderGitCommitDialog() {
    const dialog = state.gitDialog;
    if (!dialog) return "";
    const repo = activeGitRepo();
    const selectedCount = repo?.files?.filter((file) => file.selected).length || 0;
    const canCommit =
      Boolean(repo?.isGit) && selectedCount > 0 && Boolean(dialog.message.trim()) && !dialog.busy && !dialog.loading;
    const branchOptions = repo?.isGit
      ? [...new Set([repo.branch, ...(repo.branches || [])].filter(Boolean))]
      : [];

    return `
      <div class="sync-props-backdrop" data-git-dialog-backdrop="1" role="presentation">
        <div class="sync-props-dialog git-commit-dialog" role="dialog" aria-modal="true" aria-label="Git 提交">
          <header class="sync-props-header">
            <div>
              <h3>Git 提交</h3>
              <p>勾选变更文件后提交，或提交并推送到远端；可切换或新建分支。</p>
            </div>
            <button type="button" class="sync-props-close" data-action="git-commit-close" aria-label="关闭" ${dialog.busy ? "disabled" : ""}>×</button>
          </header>
          <div class="sync-props-body git-commit-body">
            ${
              dialog.loading
                ? `<p class="wt-wizard-hint">正在读取各文件夹的 Git 状态…</p>`
                : `
                  ${
                    dialog.repos.length > 1
                      ? `<div class="git-repo-tabs" role="tablist" aria-label="文件夹">
                          ${dialog.repos
                            .map((item, index) => {
                              const name = folderDisplayName(item.folderPath);
                              const active = index === dialog.activeIndex;
                              return `<button
                                type="button"
                                role="tab"
                                class="git-repo-tab${active ? " is-active" : ""}${item.isGit ? "" : " is-nogit"}"
                                data-action="git-commit-tab"
                                data-index="${index}"
                                aria-selected="${active}"
                                title="${escapeHtml(item.folderPath)}"
                                ${dialog.busy ? "disabled" : ""}
                              >${escapeHtml(name)}${item.isGit ? "" : " · 非 Git"}</button>`;
                            })
                            .join("")}
                        </div>`
                      : ""
                  }
                  ${
                    !repo
                      ? `<p class="wt-wizard-hint">没有可操作的文件夹</p>`
                      : !repo.isGit
                        ? `<div class="wt-wizard-error">${escapeHtml(repo.error || "不是 Git 仓库")}</div>`
                        : `
                          <div class="git-commit-toolbar">
                            <label class="git-branch-field">
                              <span>分支</span>
                              <select data-action="git-commit-branch" ${dialog.busy || dialog.creatingBranch ? "disabled" : ""}>
                                ${branchOptions
                                  .map(
                                    (branch) =>
                                      `<option value="${escapeHtml(branch)}"${branch === repo.branch ? " selected" : ""}>${escapeHtml(branch)}</option>`,
                                  )
                                  .join("")}
                              </select>
                            </label>
                            <button type="button" class="devctx-btn" data-action="git-commit-new-branch" ${dialog.busy || dialog.creatingBranch ? "disabled" : ""}>新建分支</button>
                            <button type="button" class="devctx-btn" data-action="git-commit-refresh" ${dialog.busy ? "disabled" : ""}>刷新</button>
                            <span class="git-commit-meta" title="${escapeHtml(repo.gitRoot)}">${escapeHtml(folderDisplayName(repo.gitRoot || repo.folderPath))} · ${escapeHtml(repo.branch || "-")}</span>
                          </div>
                          ${
                            dialog.creatingBranch
                              ? `<div class="git-new-branch-row">
                                  <label class="git-new-branch-field">
                                    <span>新分支名</span>
                                    <input
                                      id="git-new-branch-input"
                                      type="text"
                                      value="${escapeHtml(dialog.newBranchName || "")}"
                                      placeholder="例如 issue/OPEN-20"
                                      ${dialog.busy ? "disabled" : ""}
                                      autocomplete="off"
                                      spellcheck="false"
                                    />
                                  </label>
                                  <button type="button" class="devctx-btn primary" data-action="git-commit-create-branch" ${dialog.busy || !String(dialog.newBranchName || "").trim() ? "disabled" : ""}>创建并切换</button>
                                  <button type="button" class="devctx-btn" data-action="git-commit-cancel-new-branch" ${dialog.busy ? "disabled" : ""}>取消</button>
                                </div>`
                              : ""
                          }
                          ${
                            repo.files.length
                              ? `<div class="git-file-list" role="group" aria-label="变更文件">
                                  <div class="git-file-list-head">
                                    <label class="git-file-check-all">
                                      <input type="checkbox" data-action="git-commit-toggle-all" ${selectedCount === repo.files.length ? "checked" : ""} ${dialog.busy ? "disabled" : ""} />
                                      <span>全选（${selectedCount}/${repo.files.length}）</span>
                                    </label>
                                  </div>
                                  ${repo.files
                                    .map(
                                      (file, fileIndex) => `
                                        <label class="git-file-row" title="${escapeHtml(file.path)}">
                                          <input
                                            type="checkbox"
                                            data-action="git-commit-toggle-file"
                                            data-index="${fileIndex}"
                                            ${file.selected ? "checked" : ""}
                                            ${dialog.busy ? "disabled" : ""}
                                          />
                                          <span class="git-file-code">${escapeHtml(file.label)}</span>
                                          <span class="git-file-path">${escapeHtml(file.path)}</span>
                                        </label>`,
                                    )
                                    .join("")}
                                </div>`
                              : `<p class="wt-wizard-hint">工作区干净，没有可提交的变更。</p>`
                          }
                          <label class="git-message-field">
                            <span>提交说明</span>
                            <textarea
                              id="git-commit-message"
                              rows="3"
                              placeholder="写下这次提交的说明…"
                              ${dialog.busy ? "disabled" : ""}
                            >${escapeHtml(dialog.message)}</textarea>
                          </label>
                        `
                  }
                `
            }
            ${dialog.error ? `<div class="wt-wizard-error">${escapeHtml(dialog.error)}</div>` : ""}
          </div>
          <footer class="sync-props-footer git-commit-footer">
            <button type="button" class="devctx-btn" data-action="git-commit-close" ${dialog.busy ? "disabled" : ""}>取消</button>
            <button type="button" class="devctx-btn" data-action="git-commit-submit" ${canCommit ? "" : "disabled"}>
              ${dialog.busy && dialog.busyMode === "commit" ? "提交中…" : `提交${selectedCount ? `（${selectedCount}）` : ""}`}
            </button>
            <button type="button" class="devctx-btn primary" data-action="git-commit-push" ${canCommit ? "" : "disabled"}>
              ${dialog.busy && dialog.busyMode === "push" ? "推送中…" : `提交并推送${selectedCount ? `（${selectedCount}）` : ""}`}
            </button>
          </footer>
        </div>
      </div>
    `;
  }

  /** @param {string} taskId @param {{ mode?: "switch" | "create" }} [options] */
  async function openWorktreeWizard(taskId, options = {}) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return;
    if (!parseWorktreePaths(task.worktreePath).length) {
      vscode.postMessage({ type: "toast", text: "请先选择文件夹作为开发上下文" });
      return;
    }
    const preferredMode = options.mode === "create" || options.mode === "switch" ? options.mode : "";
    state.worktreeWizard = {
      taskId,
      mode: preferredMode || "switch",
      suggestedBranch: "",
      nonGitFolders: [],
      repos: [],
      loading: true,
      busy: false,
      error: "",
    };
    render();
    try {
      const result = await storeRequest("devContext.prepareCreate", { taskId }, { timeoutMs: 30000 });
      const suggested = String(result.suggestedBranch || "").trim();
      const repos = Array.isArray(result.repos)
        ? result.repos.map((repo) => {
            const branches = Array.isArray(repo.branches) ? repo.branches.map(String) : [];
            const selectedBranch =
              suggested || String(repo.currentBranch || "").trim() || branches[0] || "";
            const worktrees = Array.isArray(repo.worktrees)
              ? repo.worktrees.map((item) => ({
                  path: String(item.path || ""),
                  branch: String(item.branch || ""),
                  detached: Boolean(item.detached),
                  isMain: Boolean(item.isMain),
                  isActive: Boolean(item.isActive),
                }))
              : [];
            const hasActive = worktrees.some((item) => item.isActive);
            return {
              gitRoot: String(repo.gitRoot || ""),
              sourcePaths: Array.isArray(repo.sourcePaths) ? repo.sourcePaths.map(String) : [],
              activePath: String(repo.activePath || ""),
              currentBranch: String(repo.currentBranch || ""),
              branches,
              worktrees,
              parentFolder: String(repo.defaultFolder || ""),
              selectedBranch,
              branchQuery: "",
              enabled: true,
              preferCreate: !hasActive && worktrees.length <= 1,
            };
          })
        : [];
      if (!state.worktreeWizard || state.worktreeWizard.taskId !== taskId) return;
      const preferCreate = repos.length > 0 && repos.every((repo) => repo.preferCreate);
      state.worktreeWizard = {
        ...state.worktreeWizard,
        mode: preferredMode || (preferCreate ? "create" : "switch"),
        suggestedBranch: suggested,
        nonGitFolders: Array.isArray(result.nonGitFolders) ? result.nonGitFolders.map(String) : [],
        repos,
        loading: false,
        busy: false,
        error: repos.length ? "" : "没有可管理的 git 仓库",
      };
      render();
    } catch (error) {
      if (!state.worktreeWizard || state.worktreeWizard.taskId !== taskId) return;
      state.worktreeWizard = {
        ...state.worktreeWizard,
        loading: false,
        busy: false,
        error: error instanceof Error ? error.message : "无法打开 worktree 管理",
      };
      render();
    }
  }

  /** 创建 worktree 居中弹窗（两步：路径 → 分支） */
  function isPanelUserComment(comment) {
    if (!comment) return false;
    if (comment.kind === "user_comment") return true;
    return comment.authorType === "user" && comment.kind !== "chat_turn";
  }

  /** 扫描：仅「最新用户评论尚未被 Agent 处理」的议题 */
  function scanIssuesNeedingCommentProcess(pool = filteredTasks()) {
    const rows = [];
    for (const task of pool) {
      if (!AUTOMATION_SCAN_STATUSES.includes(task.status)) continue;
      const comments = Array.isArray(task.comments) ? task.comments : [];
      const userComments = comments.filter(isPanelUserComment);
      if (!userComments.length) continue;
      const lastUser = userComments[userComments.length - 1];
      const agentComments = comments.filter(
        (item) =>
          item.kind === "agent_report" ||
          (item.authorType === "agent" && item.kind !== "chat_turn"),
      );
      const lastAgent = agentComments[agentComments.length - 1];
      const userAt = new Date(lastUser.createdAt || 0).getTime();
      const agentAt = lastAgent ? new Date(lastAgent.createdAt || 0).getTime() : 0;
      // 必须有比最近一次 Agent 汇报更新的用户评论，否则无需处理
      if (lastAgent && !(userAt > agentAt)) continue;
      rows.push({
        id: task.id,
        identifier: task.identifier || task.id,
        title: task.title || "",
        status: task.status,
        hasThread: Boolean(task.threadId),
        commentPreview: commentSnippet(lastUser.body, 80, lastUser.attachments),
        selected: true,
      });
    }
    rows.sort((a, b) => String(a.identifier).localeCompare(String(b.identifier), "zh-CN"));
    return rows;
  }

  function openAutomationDialog() {
    const items = scanIssuesNeedingCommentProcess();
    state.automationDialog = {
      items,
      busy: false,
      progress: "",
      error: "",
    };
    render();
  }

  function renderSyncPropsDialog() {
    const dialog = state.syncPropsDialog;
    if (!dialog) return "";
    return `
      <div class="sync-props-backdrop" data-sync-props-backdrop="1" role="presentation">
        <div class="sync-props-dialog" role="dialog" aria-modal="true" aria-label="同步属性">
          <header class="sync-props-header">
            <div>
              <h3>同步属性</h3>
              <p>拉取议题 ${escapeHtml(dialog.identifier)} 的最新属性并刷新面板。</p>
            </div>
            <button type="button" class="sync-props-close" data-action="close-sync-props" aria-label="关闭" ${dialog.busy ? "disabled" : ""}>×</button>
          </header>
          <div class="sync-props-body">
            <ul class="sync-props-steps">
              <li>从本地数据库重新加载状态、优先级、标签、日期、开发上下文等</li>
              <li>${dialog.hasThread ? "在绑定对话中请求 Agent 用 MCP 核对并同步属性" : "未绑定对话时仅刷新本地数据；可先「打开已有对话」再同步"}</li>
            </ul>
            ${dialog.error ? `<div class="sync-props-error">${escapeHtml(dialog.error)}</div>` : ""}
          </div>
          <footer class="sync-props-footer">
            <button type="button" class="devctx-btn" data-action="close-sync-props" ${dialog.busy ? "disabled" : ""}>取消</button>
            <button type="button" class="devctx-btn primary" data-action="confirm-sync-props" ${dialog.busy ? "disabled" : ""}>
              ${dialog.busy ? "同步中…" : "开始同步"}
            </button>
          </footer>
        </div>
      </div>
    `;
  }

  function renderAutomationDialog() {
    const dialog = state.automationDialog;
    if (!dialog) return "";
    const selectedCount = dialog.items.filter((item) => item.selected).length;
    const canRun = selectedCount > 0 && !dialog.busy;
    return `
      <div class="sync-props-backdrop" data-automation-backdrop="1" role="presentation">
        <div class="sync-props-dialog automation-dialog" role="dialog" aria-modal="true" aria-label="自动化">
          <header class="sync-props-header">
            <div>
              <h3>自动化</h3>
              <p>仅扫描「有尚未处理的最新用户评论」的议题，排队打开对话并提交（最多 ${AUTOMATION_BATCH_LIMIT} 个）。</p>
            </div>
            <button type="button" class="sync-props-close" data-action="close-automation" aria-label="关闭">×</button>
          </header>
          <div class="sync-props-body">
            <div class="automation-scan-meta">
              <span>命中 ${dialog.items.length} 个 · 已选 ${selectedCount} 个</span>
              <button type="button" class="ghost-link" data-action="rescan-automation" ${dialog.busy ? "disabled" : ""}>重新扫描</button>
            </div>
            ${
              dialog.items.length
                ? `<ul class="automation-issue-list">
                    ${dialog.items
                      .map((item) => {
                        const statusLabel = STATUS[item.status]?.label || item.status;
                        return `
                          <li class="automation-issue-item">
                            <label>
                              <input
                                type="checkbox"
                                data-action="toggle-automation-item"
                                data-task-id="${escapeHtml(item.id)}"
                                ${item.selected ? "checked" : ""}
                                ${dialog.busy ? "disabled" : ""}
                              />
                              <span class="automation-issue-main">
                                <span class="automation-issue-id">${escapeHtml(item.identifier)}</span>
                                <span class="automation-issue-title">${escapeHtml(item.title)}</span>
                                <span class="automation-issue-status">${escapeHtml(statusLabel)}${item.hasThread ? " · 已绑定对话" : " · 将新建对话"}</span>
                                <span class="automation-issue-comment">${escapeHtml(item.commentPreview || "（评论）")}</span>
                              </span>
                            </label>
                          </li>`;
                      })
                      .join("")}
                  </ul>`
                : `<div class="automation-empty">没有需要处理的议题（需存在比 Agent 最近汇报更新的用户评论）。</div>`
            }
            ${
              dialog.progress
                ? `<div class="automation-progress">${escapeHtml(dialog.progress)}${
                    dialog.busy ? "（可关闭，后台继续）" : ""
                  }</div>`
                : ""
            }
            ${dialog.error ? `<div class="sync-props-error">${escapeHtml(dialog.error)}</div>` : ""}
          </div>
          <footer class="sync-props-footer">
            <button type="button" class="devctx-btn" data-action="close-automation">${dialog.busy ? "关闭" : "取消"}</button>
            <button type="button" class="devctx-btn primary" data-action="run-automation" ${canRun ? "" : "disabled"}>
              ${dialog.busy ? "处理中…" : `打开对话并处理${selectedCount ? `（${Math.min(selectedCount, AUTOMATION_BATCH_LIMIT)}）` : ""}`}
            </button>
          </footer>
        </div>
      </div>
    `;
  }

  function renderWorktreeWizard() {
    const wizard = state.worktreeWizard;
    if (!wizard) return "";
    const mode = wizard.mode === "create" ? "create" : "switch";
    const enabledRepos = (wizard.repos || []).filter((repo) => repo.enabled && repo.selectedBranch);
    const canCreate = enabledRepos.length > 0 && !wizard.busy && !wizard.loading;

    const switchBody = `
      <div class="wt-repo-list">
        ${(wizard.repos || [])
          .map((repo, index) => {
            const label = folderDisplayName(repo.gitRoot) || repo.gitRoot;
            const trees = Array.isArray(repo.worktrees) ? repo.worktrees : [];
            return `
              <article class="wt-repo-card" data-repo-index="${index}">
                <header class="wt-repo-card-head">
                  <span class="wt-repo-title" title="${escapeHtml(repo.gitRoot)}">${escapeHtml(label)}</span>
                  <span class="wt-repo-current">${
                    repo.currentBranch ? `上下文 ${escapeHtml(repo.currentBranch)}` : "未识别分支"
                  }</span>
                </header>
                <div class="wt-worktree-list" role="list">
                  ${
                    trees.length
                      ? trees
                          .map((tree, treeIndex) => {
                            const name = tree.branch || folderDisplayName(tree.path) || tree.path;
                            const meta = [
                              tree.isMain ? "主工作区" : "worktree",
                              tree.isActive ? "当前上下文" : "",
                            ]
                              .filter(Boolean)
                              .join(" · ");
                            return `
                              <div class="wt-worktree-row${tree.isActive ? " is-active" : ""}" role="listitem">
                                <div class="wt-worktree-main" title="${escapeHtml(tree.path)}">
                                  <span class="wt-branch-icon">${ICONS.branch}</span>
                                  <div class="wt-worktree-text">
                                    <span class="wt-worktree-name">${escapeHtml(name)}</span>
                                    <span class="wt-worktree-meta">${escapeHtml(meta)}</span>
                                    <span class="wt-worktree-path">${escapeHtml(tree.path)}</span>
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  class="devctx-btn${tree.isActive ? "" : " primary"}"
                                  data-action="wt-wizard-switch"
                                  data-index="${index}"
                                  data-tree-index="${treeIndex}"
                                  ${tree.isActive || wizard.busy ? "disabled" : ""}
                                >${tree.isActive ? "使用中" : "切换"}</button>
                              </div>`;
                          })
                          .join("")
                      : `<p class="wt-wizard-hint">暂无 worktree</p>`
                  }
                </div>
              </article>`;
          })
          .join("")}
      </div>`;

    const createBody = `
      <div class="wt-repo-list">
        ${(wizard.repos || [])
          .map((repo, index) => {
            const q = String(repo.branchQuery || "").trim().toLowerCase();
            const filtered = repo.branches.filter((branch) => !q || branch.toLowerCase().includes(q));
            const typed = String(repo.branchQuery || "").trim();
            const canCreateTyped = Boolean(typed) && !repo.branches.includes(typed);
            const label = folderDisplayName(repo.gitRoot) || repo.gitRoot;
            return `
              <article class="wt-repo-card${repo.enabled ? "" : " is-disabled"}" data-repo-index="${index}">
                <header class="wt-repo-card-head">
                  <label class="wt-repo-enable">
                    <input
                      type="checkbox"
                      data-action="wt-wizard-toggle-repo"
                      data-index="${index}"
                      ${repo.enabled ? "checked" : ""}
                      ${wizard.busy ? "disabled" : ""}
                    />
                    <span class="wt-repo-title" title="${escapeHtml(repo.gitRoot)}">${escapeHtml(label)}</span>
                  </label>
                  <span class="wt-repo-current">${
                    repo.currentBranch ? `上下文 ${escapeHtml(repo.currentBranch)}` : "当前分支未知"
                  }</span>
                </header>
                ${
                  repo.enabled
                    ? `
                      <input
                        type="search"
                        class="wt-branch-search"
                        placeholder="搜索已有分支，或输入新分支名…"
                        value="${escapeHtml(repo.branchQuery)}"
                        data-wt-branch-search="1"
                        data-index="${index}"
                        aria-label="${escapeHtml(label)} 分支"
                        ${wizard.busy ? "disabled" : ""}
                      />
                      <div class="wt-branch-list" role="listbox">
                        ${
                          filtered.length
                            ? filtered
                                .map((branch) => {
                                  const selected = repo.selectedBranch === branch;
                                  return `<button
                                    type="button"
                                    class="wt-branch-option${selected ? " is-selected" : ""}"
                                    role="option"
                                    aria-selected="${selected}"
                                    data-action="wt-wizard-select-branch"
                                    data-index="${index}"
                                    data-branch="${escapeHtml(branch)}"
                                    ${wizard.busy ? "disabled" : ""}
                                  >
                                    <span class="wt-branch-icon">${ICONS.branch}</span>
                                    <span class="wt-branch-name">${escapeHtml(branch)}</span>
                                    ${selected ? `<span class="wt-branch-check">${ICONS.check}</span>` : ""}
                                  </button>`;
                                })
                                .join("")
                            : `<div class="wt-branch-empty">${q ? "无匹配分支" : "暂无本地分支，可在上方输入新分支名"}</div>`
                        }
                        ${
                          canCreateTyped
                            ? `<button
                                type="button"
                                class="wt-branch-option is-create${repo.selectedBranch === typed ? " is-selected" : ""}"
                                data-action="wt-wizard-select-branch"
                                data-index="${index}"
                                data-branch="${escapeHtml(typed)}"
                                ${wizard.busy ? "disabled" : ""}
                              >
                                <span class="wt-branch-icon">+</span>
                                <span class="wt-branch-name">新建分支「${escapeHtml(typed)}」</span>
                              </button>`
                            : ""
                        }
                      </div>
                      <div class="wt-folder-row">
                        <button type="button" class="devctx-btn" data-action="wt-wizard-pick-folder" data-index="${index}" ${wizard.busy ? "disabled" : ""}>存放目录…</button>
                        <span class="project-folder-hint" title="${escapeHtml(repo.parentFolder)}">${escapeHtml(repo.parentFolder || "尚未选择")}</span>
                      </div>
                      <div class="wt-wizard-summary">
                        <span>创建后自动切换为开发上下文</span>
                        <span>分支 · ${escapeHtml(repo.selectedBranch || "未选")}</span>
                      </div>`
                    : `<p class="wt-wizard-hint">已跳过，保留原绑定路径</p>`
                }
              </article>`;
          })
          .join("")}
      </div>`;

    return `
      <div class="wt-wizard-backdrop" data-wt-backdrop="1" role="presentation">
        <div class="wt-wizard wt-wizard-multi" role="dialog" aria-modal="true" aria-label="${escapeHtml(t("wt.title"))}">
          <header class="wt-wizard-header">
            <div>
              <h3>${escapeHtml(t("wt.title"))}</h3>
              <p>${escapeHtml(t("wt.desc"))}</p>
            </div>
            <button type="button" class="wt-wizard-close" data-action="wt-wizard-close" aria-label="${escapeHtml(t("common.close"))}" ${wizard.busy ? "disabled" : ""}>×</button>
          </header>
          ${
            wizard.loading
              ? ""
              : `<div class="wt-mode-tabs" role="tablist" aria-label="${escapeHtml(t("wt.title"))}">
                  <button type="button" class="wt-mode-tab${mode === "switch" ? " is-active" : ""}" data-action="wt-wizard-mode" data-mode="switch" ${wizard.busy ? "disabled" : ""}>${escapeHtml(t("wt.modeSwitch"))}</button>
                  <button type="button" class="wt-mode-tab${mode === "create" ? " is-active" : ""}" data-action="wt-wizard-mode" data-mode="create" ${wizard.busy ? "disabled" : ""}>${escapeHtml(t("wt.modeCreate"))}</button>
                </div>`
          }
          ${wizard.error ? `<div class="wt-wizard-error">${escapeHtml(wizard.error)}</div>` : ""}
          ${
            wizard.loading
              ? `<div class="wt-wizard-body"><p class="wt-wizard-hint">正在读取各绑定文件夹的 git 仓库与 worktree…</p></div>
                <footer class="wt-wizard-footer">
                  <button type="button" class="devctx-btn" data-action="wt-wizard-close">取消</button>
                </footer>`
              : `<div class="wt-wizard-body">
                  ${
                    wizard.nonGitFolders?.length
                      ? `<p class="wt-wizard-hint">非 git 文件夹将保留原路径：${escapeHtml(
                          wizard.nonGitFolders.map((item) => folderDisplayName(item) || item).join("、"),
                        )}</p>`
                      : ""
                  }
                  ${mode === "switch" ? switchBody : createBody}
                </div>
                <footer class="wt-wizard-footer">
                  <button type="button" class="devctx-btn" data-action="wt-wizard-close" ${wizard.busy ? "disabled" : ""}>关闭</button>
                  ${
                    mode === "create"
                      ? `<button type="button" class="devctx-btn primary" data-action="wt-wizard-submit" ${canCreate ? "" : "disabled"}>
                          ${
                            wizard.busy
                              ? "创建中…"
                              : enabledRepos.length > 1
                                ? `创建 ${enabledRepos.length} 个 worktree`
                                : "创建 worktree"
                          }
                        </button>`
                      : ""
                  }
                </footer>`
          }
        </div>
      </div>
    `;
  }

  function relativeTime(value) {
    if (!value) return "";
    const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
    const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
    if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
    const minutes = Math.round(seconds / 60);
    if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
    const days = Math.round(hours / 24);
    if (Math.abs(days) < 30) return formatter.format(days, "day");
    return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
  }

  function exactTime(value) {
    if (!value) return "";
    return new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  }

  function conversationLink(threadId, taskIdentifier) {
    if (!threadId) return "";
    return `
      <button
        class="issue-conversation-link"
        type="button"
        data-action="open-thread"
        data-thread-id="${escapeHtml(threadId)}"
        data-task-id="${escapeHtml(taskIdentifier || "")}"
      >
        ${ICONS.chat}
        <strong>查看对话</strong>
        <span class="conversation-divider"></span>
        <span class="conversation-thread-id">${escapeHtml(threadId)}</span>
      </button>
    `;
  }

  function resizeTextarea(element) {
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${element.scrollHeight}px`;
  }

  function renderCard(task) {
    const chips = [];
    if (task.priority && task.priority !== "none") {
      chips.push(
        `<span class="chip priority-${escapeHtml(task.priority)}">${escapeHtml(PRIORITY_LABELS[task.priority])}</span>`,
      );
    }
    for (const label of task.labels || []) {
      chips.push(`<span class="chip">${escapeHtml(label)}</span>`);
    }
    if (task.dueDate) {
      chips.push(`<span class="chip">${escapeHtml(task.dueDate.slice(5))}</span>`);
    }
    if (task.assignee) {
      chips.push(`<span class="avatar" title="${escapeHtml(task.assignee)}">${escapeHtml(task.assignee)}</span>`);
    }
    const children = childTasksOf(task.id, filteredTasks(), { sameStatusOnly: true });
    const subissueList = children.length
      ? `<ul class="card-subissue-list" aria-label="子议题">
          ${children
            .map((child) => {
              const tone = STATUS[child.status]?.tone || "neutral";
              const childTitle = `${child.identifier || ""} ${child.title || ""}`.trim();
              return `
                <li class="card-subissue-item">
                  <button
                    type="button"
                    class="card-subissue-link"
                    data-action="open-related-issue"
                    data-task-id="${escapeHtml(child.id)}"
                    title="${escapeHtml(childTitle)}"
                  >
                    <span class="status-dot ${tone}" aria-hidden="true"></span>
                    <span class="card-subissue-id">${escapeHtml(child.identifier || "")}</span>
                    <span class="card-subissue-title">${escapeHtml(child.title || "")}</span>
                  </button>
                </li>`;
            })
            .join("")}
        </ul>`
      : "";

    return `
      <article
        class="task-card${state.dragTaskId === task.id ? " is-dragging" : ""}${children.length ? " has-subissues" : ""}"
        draggable="true"
        data-task-id="${escapeHtml(task.id)}"
        title="${escapeHtml(`${task.identifier || ""} ${task.title || ""}`.trim())}"
      >
        <div class="card-topline">
          <span class="task-identifier">ID: ${escapeHtml(task.identifier)}</span>
          <span class="card-topline-right">
            ${children.length ? `<span class="card-subissue-badge" title="${children.length} 个子议题">${children.length}</span>` : ""}
            ${task.status === "in_review" ? `<span class="chip">待确认</span>` : ""}
          </span>
        </div>
        <h3 title="${escapeHtml(task.title || "")}">${escapeHtml(task.title)}</h3>
        ${chips.length ? `<div class="card-properties">${chips.join("")}</div>` : ""}
        ${subissueList}
        ${
          task.status === "in_progress"
            ? `<div class="processing-row"><span class="running">处理中</span><span>${escapeHtml(task.assignee || "Agent")}</span></div>`
            : ""
        }
      </article>
    `;
  }

  function renderBoard() {
    const tasks = rootTasks(filteredTasks());
    return `
      <div class="board-scroll${state.view === "issues" ? "" : " is-hidden"}">
        <div class="board" style="--main-column-count: 4">
          ${BOARD_COLUMNS.map((status) => {
            const columnTasks = tasks.filter((task) => task.status === status);
            const meta = STATUS[status];
            return `
              <section class="board-column" data-status="${status}">
                <header class="column-header">
                  <div class="column-heading">
                    <span class="status-dot ${meta.tone}"></span>
                    <h2>${meta.label}</h2>
                    <span class="task-count">${columnTasks.length}</span>
                  </div>
                  <button class="icon-button" type="button" data-action="create" data-status="${status}" title="新建议题">+</button>
                </header>
                <div class="column-list" data-drop-status="${status}">
                  ${
                    columnTasks.length
                      ? columnTasks.map(renderCard).join("")
                      : `<div class="column-empty">暂无议题</div>`
                  }
                </div>
              </section>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }

  function renderQueryPage() {
    const tasks = filteredTasks().filter((task) => task.status === state.queryStatus);
    const counts = Object.fromEntries(
      QUERY_STATUSES.map((status) => [
        status,
        filteredTasks().filter((task) => task.status === status).length,
      ]),
    );
    const statusLabel = STATUS[state.queryStatus]?.label || state.queryStatus;

    return `
      <section class="query-page" aria-label="查询页面">
        <label class="search-field search-field-top query-search">
          <span class="sr-only">搜索议题</span>
          <input id="task-search" type="search" placeholder="搜索议题…" value="${escapeHtml(state.search)}" />
        </label>
        <div class="query-tabs" role="tablist" aria-label="查询状态">
          ${QUERY_STATUSES.map((status) => `
            <button
              class="query-tab${state.queryStatus === status ? " is-active" : ""}"
              type="button"
              role="tab"
              aria-selected="${state.queryStatus === status}"
              data-action="set-query-status"
              data-status="${status}"
            >
              <span>${STATUS[status].label}</span>
              <span class="query-tab-count">${counts[status]}</span>
            </button>
          `).join("")}
        </div>
        <button class="query-add" type="button" data-action="create" data-status="${state.queryStatus}" title="在${escapeHtml(statusLabel)}中新建议题">
          <span aria-hidden="true">+</span>
        </button>
        <div class="query-list" role="tabpanel">
          ${
            tasks.length
              ? tasks.map((task) => `
                  <article class="task-card query-card" draggable="false" data-task-id="${escapeHtml(task.id)}" role="button" tabindex="0" title="${escapeHtml(`${task.identifier || ""} ${task.title || ""}`.trim())}">
                    <div class="card-topline">
                      <span class="task-identifier">ID: ${escapeHtml(task.identifier)}</span>
                    </div>
                    <h3 title="${escapeHtml(task.title || "")}">${escapeHtml(task.title)}</h3>
                    <div class="card-properties">
                      ${(task.labels || []).map((label) => `<span class="chip">${escapeHtml(label)}</span>`).join("")}
                      ${task.priority && task.priority !== "none" ? `<span class="chip priority-${escapeHtml(task.priority)}">${escapeHtml(PRIORITY_LABELS[task.priority])}</span>` : ""}
                    </div>
                    <div class="card-footer">
                      <span class="list-row-date">${escapeHtml(shortDate(task.dueDate || task.createdAt))}</span>
                      <span class="avatar">${escapeHtml((task.assignee || "?").slice(0, 2).toUpperCase())}</span>
                    </div>
                  </article>
                `).join("")
              : `<div class="query-empty">
                  <strong>暂无议题</strong>
                  <span>没有${escapeHtml(statusLabel)}。</span>
                </div>`
          }
        </div>
      </section>
    `;
  }

  function renderListRow(task, options = {}) {
    const depth = Number(options.depth) || 0;
    const pool = options.pool || filteredTasks();
    const children = childTasksOf(task.id, pool, { sameStatusOnly: true });
    // 列表视图：有子议题的父行默认折叠，仅用户手动展开时显示
    const expanded = state.expandedSubIssues[task.id] === true;
    const initials = (task.assignee || "?")
      .split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
    const fullTitle = `${task.identifier || ""} ${task.title || ""}`.trim();
    return `
      <div class="list-row-block${depth ? " is-child" : ""}" style="--list-depth:${depth}">
        <div class="list-row" role="button" tabindex="0" data-task-id="${escapeHtml(task.id)}" title="${escapeHtml(fullTitle)}">
          <span class="list-row-title">
            ${
              children.length
                ? `<button
                    type="button"
                    class="list-subissue-toggle${expanded ? " is-expanded" : ""}"
                    data-action="toggle-subissues"
                    data-task-id="${escapeHtml(task.id)}"
                    aria-expanded="${expanded}"
                    aria-label="${expanded ? "收起子议题" : "展开子议题"}"
                    title="${children.length} 个子议题"
                  >${ICONS.chevronRight}</button>`
                : `<span class="list-subissue-spacer" aria-hidden="true"></span>`
            }
            <span class="list-row-heading" title="${escapeHtml(fullTitle)}">
              <strong>${escapeHtml(task.title)}</strong>
              <small>${escapeHtml(task.identifier)}</small>
            </span>
            ${children.length ? `<span class="list-subissue-count">${children.length}</span>` : ""}
          </span>
          <span class="list-row-meta">
            <span class="list-meta-slot list-meta-priority">
              <span class="issue-list-priority-control">
                <button
                  type="button"
                  class="issue-list-priority priority-${escapeHtml(task.priority || "none")}"
                  data-action="toggle-priority-menu"
                  data-task-id="${escapeHtml(task.id)}"
                  aria-expanded="${state.priorityMenuTaskId === task.id}"
                  aria-label="${escapeHtml(task.identifier)} 优先级"
                >
                  ${priorityIcon(task.priority || "none")}
                  <span>${escapeHtml(PRIORITY_LABELS[task.priority] || t("priority.none"))}</span>
                </button>
                ${renderPriorityMenu(task)}
              </span>
            </span>
            <span class="list-meta-slot list-meta-chat">
              ${
                task.threadId
                  ? `<button
                      type="button"
                      class="task-conversation-trigger"
                      data-action="open-thread"
                      data-thread-id="${escapeHtml(task.threadId)}"
                      data-task-id="${escapeHtml(task.identifier)}"
                      title="查看对话"
                      aria-label="打开对话"
                    >${ICONS.chat}</button>`
                  : `<span class="list-meta-placeholder" aria-hidden="true"></span>`
              }
            </span>
            <span class="list-meta-slot list-meta-avatar">
              <span class="avatar" title="${escapeHtml(task.assignee || "")}">${escapeHtml(initials)}</span>
            </span>
            <span class="list-meta-slot list-meta-date">
              <span class="list-row-date">${escapeHtml(shortDate(task.dueDate || task.createdAt))}</span>
            </span>
          </span>
        </div>
        ${
          expanded && children.length
            ? `<div class="list-subissue-children">
                ${children.map((child) => renderListRow(child, { depth: depth + 1, pool })).join("")}
              </div>`
            : ""
        }
      </div>
    `;
  }

  function renderList() {
    const pool = filteredTasks();
    const roots = rootTasks(pool);
    // 状态顺序：待立项 → 等待认领 → …
    const groups = STATUS_ORDER;
    return `
      <div class="list-view${state.view === "list" ? " is-active" : ""}">
        ${groups
          .map((status) => {
            const items = roots.filter((task) => task.status === status);
            // 数量为 0 的分组也展示
            const collapsed = state.collapsedGroups[status] !== false;
            return `
              <section class="list-group${collapsed ? " is-collapsed" : ""}${items.length ? "" : " is-empty"}">
                <button
                  type="button"
                  class="list-group-header"
                  data-action="toggle-list-group"
                  data-status="${escapeHtml(status)}"
                  aria-expanded="${collapsed ? "false" : "true"}"
                >
                  <span class="list-group-chevron" aria-hidden="true">${ICONS.chevronDown}</span>
                  <span class="status-dot ${STATUS[status].tone}"></span>
                  <span>${STATUS[status].label}</span>
                  <span class="task-count">${items.length}</span>
                </button>
                <div class="list-group-body">
                ${
                  items.length
                    ? items.map((task) => renderListRow(task, { depth: 0, pool })).join("")
                    : `<div class="list-group-empty">${escapeHtml(t("list.empty"))}</div>`
                }
                </div>
              </section>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function renderIssueDetail(task) {
    const comments = task.comments || [];
    const activities = task.activities || [];
    // 主列表隐藏 chat_turn；它们挂在 agent_report 下展开查看
    const visibleComments = comments.filter((comment) => !isChatTurnComment(comment));
    const activityCount = 1 + activities.length + visibleComments.length;
    const statusTone = STATUS[task.status]?.tone || "todo";
    const initials = (task.creatorName || "WY")
      .split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();

    // 对话以评论为主；默认只展示最近 N 条，更早的每次最多再展开 4 条
    const conversationItems = visibleComments
      .map((comment) => ({ kind: "comment", ...comment, sortAt: comment.createdAt }))
      .sort((a, b) => a.sortAt.localeCompare(b.sortAt));
    const changeItems = activities
      .map((item) => ({ ...item, sortAt: item.createdAt }))
      .sort((a, b) => a.sortAt.localeCompare(b.sortAt));
    const showCount = Math.min(
      conversationItems.length,
      Math.max(ACTIVITY_PREVIEW_COUNT, Number(state.activityShowCount) || ACTIVITY_PREVIEW_COUNT),
    );
    const remainingEarlier = Math.max(0, conversationItems.length - showCount);
    const nextExpandCount = Math.min(ACTIVITY_EXPAND_STEP, remainingEarlier);
    const canCollapseActivity = showCount > ACTIVITY_PREVIEW_COUNT && conversationItems.length > ACTIVITY_PREVIEW_COUNT;
    const fullyExpanded = remainingEarlier === 0 && conversationItems.length > ACTIVITY_PREVIEW_COUNT;
    const visibleConversations = conversationItems.slice(-showCount);
    // 状态变更始终按时间穿插在可见对话附近展示：未全展开时只保留落在可见对话时间窗内的变更
    const visibleWindowStart = visibleConversations[0]?.sortAt || null;
    const visibleChanges =
      fullyExpanded || !visibleWindowStart
        ? changeItems
        : changeItems.filter((item) => item.sortAt >= visibleWindowStart);
    const visibleActivityItems = collapseConsecutiveStatusChanges(
      [...visibleChanges, ...visibleConversations].sort((a, b) => a.sortAt.localeCompare(b.sortAt)),
    );

    return `
      <section class="issue-detail" aria-label="${escapeHtml(task.identifier)} 议题详情">
        <div class="issue-detail-scroll">
          <div class="issue-detail-layout${state.propertiesCollapsed ? " is-properties-collapsed" : ""}">
            <div class="issue-detail-main">
              <article class="issue-editor" aria-label="议题内容">
                <div class="issue-editor-content">
                  <textarea id="issue-title-input" class="issue-title-input" rows="1" aria-label="议题标题">${escapeHtml(task.title)}</textarea>
                  ${renderParentLink(task)}
                  ${
                    state.editingDescription
                      ? `<textarea id="issue-description-input" class="issue-description-input" rows="4" aria-label="议题描述" placeholder="添加描述…">${escapeHtml(task.description || "")}</textarea>`
                      : `<div class="issue-description-read${task.description ? "" : " empty"}" role="button" tabindex="0" data-action="edit-description" aria-label="编辑议题描述">${task.description ? escapeHtml(task.description).replaceAll("\n", "<br>") : "添加描述…"}</div>`
                  }
                  ${task.threadId ? `<div class="issue-conversation-list">${conversationLink(task.threadId, task.identifier)}</div>` : ""}
                </div>
              </article>

              ${renderSubIssuesSection(task)}

              ${renderIssueAttachments(task)}

              ${renderIssueContextSection(task)}

              ${renderIssueOutputs(task)}

              <section class="activity-section" aria-label="活动">
                <header class="activity-heading">
                  <div class="activity-heading-left">
                    <h2>活动</h2>
                    <span>${activityCount}</span>
                  </div>
                  ${
                    task.threadId
                      ? `<button type="button" class="ghost-link activity-sync-btn" data-action="sync-chat" data-task-id="${escapeHtml(task.id)}" title="把右侧绑定对话同步到活动列表">同步对话</button>`
                      : ""
                  }
                </header>
                <div class="activity-stream">
                  <div class="activity-entry activity-created">
                    <span class="activity-rail-icon"><span class="avatar">${escapeHtml(initials)}</span></span>
                    <p>
                      <strong>${escapeHtml(task.creatorName || "用户")}</strong>
                      创建了此议题
                      <time>· ${escapeHtml(relativeTime(task.createdAt))}</time>
                    </p>
                  </div>
                  ${
                    remainingEarlier > 0 || canCollapseActivity
                      ? `<div class="activity-expand-row">
                          ${
                            remainingEarlier > 0
                              ? `<button type="button" class="activity-expand-btn" data-action="expand-activity-more">
                                  <span class="activity-expand-icon">${ICONS.chevronDown}</span>
                                  <span>向上展开更早的 ${nextExpandCount} 条对话${remainingEarlier > nextExpandCount ? `（剩余 ${remainingEarlier}）` : ""}</span>
                                </button>
                                <button type="button" class="activity-expand-btn is-all" data-action="expand-activity-all">
                                  <span>展开全部</span>
                                </button>`
                              : ""
                          }
                          ${
                            canCollapseActivity
                              ? `<button type="button" class="activity-expand-btn is-collapse" data-action="collapse-activity">
                                  <span class="activity-expand-icon">${ICONS.chevronDown}</span>
                                  <span>收起更早的对话</span>
                                </button>`
                              : ""
                          }
                        </div>`
                      : ""
                  }
                  ${visibleActivityItems
                    .map((item) => renderActivityItem(item, comments, task.identifier))
                    .join("")}
                </div>

                <form class="comment-composer" data-action-form="comment">
                  <div class="composer-author">
                    <span class="avatar">WY</span>
                    <strong>webhua yang</strong>
                    <span class="actor-id">@me</span>
                  </div>
                  ${
                    state.replyTo
                      ? `<div class="composer-reply-chip">
                          <span>评论 ${escapeHtml(state.replyTo.authorName)}${state.replyTo.authorType === "agent" ? " 的工作内容" : ""} · ${escapeHtml(commentSnippet(state.replyTo.body, 72, state.replyTo.attachments))}</span>
                          <button type="button" class="composer-reply-clear" data-action="clear-reply" aria-label="取消回复">×</button>
                        </div>`
                      : ""
                  }
                  <textarea id="comment-input" rows="2" placeholder="${state.replyTo ? "写下对 Agent 工作内容的反馈…" : "留下评论…可粘贴/拖入截图"}" aria-label="留下评论">${escapeHtml(state.commentDraft || "")}</textarea>
                  ${renderPendingCommentImages()}
                  <footer class="composer-footer">
                    <div class="composer-footer-left">
                      <button type="button" class="composer-attach-btn" data-action="pick-comment-image" title="添加图片或截图">
                        ${ICONS.paperclip}
                        <span>图片</span>
                      </button>
                      <span>${
                        state.replyTo
                          ? "「同步处理」续写已有会话并发送；由 skill 拉取最新属性与评论"
                          : "「评论」仅保存；「同步处理」续写已有会话并发送，skill 拉取最新属性与评论"
                      }</span>
                    </div>
                    <div class="composer-footer-actions">
                      <button
                        class="button"
                        type="button"
                        data-action="sync-process-comment"
                        title="有内容则先保存评论，再打开绑定对话并拉取最新评论处理"
                      >同步处理</button>
                      <button class="button primary" type="submit">${state.replyTo ? "发送反馈" : "评论"}</button>
                    </div>
                  </footer>
                  <input id="comment-image-input" class="composer-file-input" type="file" accept="image/*" multiple tabindex="-1" aria-hidden="true" />
                </form>
              </section>
            </div>

            ${
              state.propertiesCollapsed
                ? `<button
                    type="button"
                    class="properties-expand-rail"
                    data-action="toggle-properties"
                    title="展开属性栏"
                    aria-expanded="false"
                    aria-label="展开属性栏"
                  >
                    <span class="properties-expand-icon" aria-hidden="true">${ICONS.chevronLeft}</span>
                    <span class="properties-expand-label">属性</span>
                  </button>`
                : `<aside class="issue-properties" aria-label="议题属性">
              <div class="detail-primary-actions has-collapse">
                <button
                  class="detail-open-thread-action"
                  type="button"
                  data-action="${task.threadId ? "open-thread" : "open-chat"}"
                  data-task-id="${escapeHtml(task.identifier)}"
                  ${task.threadId ? `data-thread-id="${escapeHtml(task.threadId)}"` : ""}
                >
                  <span class="avatar agent">AI</span>
                  <span>${task.threadId ? "打开已有对话" : "在对话中打开"}</span>
                </button>
                <button
                  type="button"
                  class="properties-collapse-btn"
                  data-action="toggle-properties"
                  title="折叠属性栏"
                  aria-expanded="true"
                  aria-label="折叠属性栏"
                >
                  <span class="properties-collapse-icon" aria-hidden="true">${ICONS.chevronRight}</span>
                </button>
              </div>

              <div class="properties-heading">
                <h2>属性</h2>
                <button
                  type="button"
                  class="ghost-link properties-sync-btn"
                  data-action="open-sync-props"
                  data-task-id="${escapeHtml(task.id)}"
                  title="打开对话框，拉取并同步最新属性"
                >同步属性</button>
              </div>
              <label class="detail-property-row">
                <span class="detail-property-label">状态</span>
                <span class="detail-property-icon status-${escapeHtml(statusTone)}">${ICONS.status}</span>
                <select data-field="status">
                  ${Object.entries(STATUS)
                    .map(([value, meta]) => `<option value="${value}"${task.status === value ? " selected" : ""}>${escapeHtml(meta.label)}</option>`)
                    .join("")}
                </select>
              </label>
              <label class="detail-property-row">
                <span class="detail-property-label">优先级</span>
                <span class="detail-property-icon">${ICONS.priority}</span>
                <select data-field="priority">
                  ${Object.entries(PRIORITY_LABELS)
                    .map(([value, label]) => `<option value="${value}"${task.priority === value ? " selected" : ""}>${escapeHtml(label)}</option>`)
                    .join("")}
                </select>
              </label>
              <div class="detail-property-row">
                <span class="detail-property-label">负责人</span>
                <span class="detail-property-value">
                  <span class="avatar">${escapeHtml((task.assignee || "?").slice(0, 2).toUpperCase())}</span>
                  ${escapeHtml(task.assignee || "未分配")}${task.assigneeMe ? "（我）" : ""}
                </span>
              </div>
              <div class="detail-property-row detail-property-row-labels${(task.labels || []).length ? " has-labels" : ""}">
                <span class="detail-property-label">标签</span>
                <span class="detail-property-icon">${ICONS.label}</span>
                <div class="detail-labels-editor">
                  ${(task.labels || []).length
                    ? `<div class="detail-label-chips">
                        ${(task.labels || [])
                          .map((label, index) => {
                            const tone = (index % 5) + 1;
                            return `
                        <span class="detail-label-chip tone-${tone}">
                          <span class="detail-label-text">${escapeHtml(label)}</span>
                          <button
                            type="button"
                            class="detail-label-remove"
                            data-action="remove-label"
                            data-label="${escapeHtml(label)}"
                            aria-label="移除标签 ${escapeHtml(label)}"
                          >×</button>
                        </span>`;
                          })
                          .join("")}
                      </div>`
                    : ""}
                  <div class="detail-label-field">
                    <input
                      class="detail-label-input"
                      type="text"
                      placeholder="${(task.labels || []).length ? "继续添加…" : "添加标签…"}"
                      data-action-input="add-label"
                      aria-label="添加标签"
                      aria-expanded="${state.labelPicker ? "true" : "false"}"
                      autocomplete="off"
                      value="${escapeHtml(state.labelPicker?.query || "")}"
                    />
                    ${
                      state.labelPicker
                        ? (() => {
                            const query = String(state.labelPicker.query || "").trim();
                            const q = query.toLowerCase();
                            const selected = new Set(task.labels || []);
                            const options = availableLabels()
                              .filter((label) => !q || label.toLowerCase().includes(q))
                              .sort((a, b) => a.localeCompare(b, "zh-CN"));
                            const canCreate = Boolean(query) && !availableLabels().some((label) => label === query);
                            return `<div class="label-picker" role="listbox" aria-label="选择标签">
                              <div class="label-picker-list">
                                ${
                                  options.length
                                    ? options
                                        .map((label) => {
                                          const checked = selected.has(label);
                                          return `<button
                                            type="button"
                                            class="label-picker-option${checked ? " is-checked" : ""}"
                                            role="option"
                                            aria-selected="${checked}"
                                            data-action="toggle-detail-label"
                                            data-label="${escapeHtml(label)}"
                                          >
                                            <span class="label-picker-check">${checked ? ICONS.check : ""}</span>
                                            <span class="label-picker-name">${escapeHtml(label)}</span>
                                          </button>`;
                                        })
                                        .join("")
                                    : `<div class="label-picker-empty">${query ? "无匹配标签" : "暂无可用标签，输入后回车创建"}</div>`
                                }
                                ${
                                  canCreate
                                    ? `<button
                                        type="button"
                                        class="label-picker-option is-create"
                                        data-action="create-detail-label"
                                        data-label="${escapeHtml(query)}"
                                      >
                                        <span class="label-picker-check">+</span>
                                        <span class="label-picker-name">创建「${escapeHtml(query)}」</span>
                                      </button>`
                                    : ""
                                }
                              </div>
                            </div>`;
                          })()
                        : ""
                    }
                  </div>
                </div>
              </div>
              <label class="detail-property-row">
                <span class="detail-property-label">开始日期</span>
                <span class="detail-property-icon">${ICONS.calendar}</span>
                <input
                  type="date"
                  data-field="startDate"
                  value="${escapeHtml(task.startDate || "")}"
                  aria-label="开始日期"
                />
              </label>
              <label class="detail-property-row">
                <span class="detail-property-label">截止日期</span>
                <span class="detail-property-icon">${ICONS.calendar}</span>
                <input
                  type="date"
                  data-field="dueDate"
                  value="${escapeHtml(task.dueDate || "")}"
                  aria-label="截止日期"
                />
              </label>
              <div class="detail-property-row">
                <span class="detail-property-label">重复</span>
                <span class="detail-property-icon">${ICONS.recurrence}</span>
                <span class="detail-property-value placeholder">不重复</span>
              </div>

              <div class="issue-relation-sidebar">
                <h2>关系</h2>
                ${renderRelationGroup(task, "blocked_by", `${ICONS.warning} 阻塞于`)}
                ${renderRelationGroup(task, "blocks", `${ICONS.warning} 阻塞`)}
                ${renderRelationGroup(task, "related", "相关议题")}
              </div>

              <div class="detail-timestamps">
                <span>创建于 ${escapeHtml(exactTime(task.createdAt))}</span>
                <span>更新于 ${escapeHtml(exactTime(task.updatedAt || task.createdAt))}</span>
              </div>
            </aside>`
            }
          </div>
        </div>
      </section>
    `;
  }

  function render() {
    const task = selectedTask();
    const showingDetail = Boolean(task);
    // 编辑器面板不再显示项目头栏（与侧栏重复）；侧栏保留。详情/查询/项目管理/同步 db 页也不显示。
    const hideWorkspaceHeader =
      !isSidebar ||
      showingDetail ||
      state.view === "query" ||
      state.view === "projects" ||
      state.view === "settings" ||
      state.view === "sync" ||
      state.view === "outputBook";

    // Full innerHTML replace resets scroll; keep detail pane position across toggles.
    const detailScroller = app.querySelector(".issue-detail-scroll");
    const savedDetailScrollTop = detailScroller ? detailScroller.scrollTop : null;
    const savedTaskId = state.selectedTaskId;
    // Snapshot pushes re-render while the user is reading a chapter, which would
    // otherwise snap the book back to its first line. Kept on `state` because a
    // reload paints a busy placeholder first, so the scroller is absent for a
    // render or two and a local variable would lose the offset.
    const bookScroller = app.querySelector(".output-book-markdown");
    if (bookScroller) {
      const bookTocScroller = app.querySelector(".output-book-toc");
      state.outputBookScroll = {
        top: bookScroller.scrollTop,
        tocTop: bookTocScroller ? bookTocScroller.scrollTop : null,
        bookId: state.outputBookDialog?.bookId || "",
        chapterId: state.outputBookDialog?.activeChapterId || "",
      };
    }
    const activeEl = document.activeElement;
    const restoreAction = activeEl?.getAttribute?.("data-action") || "";
    const restoreCommentId = activeEl?.getAttribute?.("data-comment-id") || "";

    app.innerHTML = `
      ${
        hideWorkspaceHeader
          ? ""
          : `<header class="workspace-header">
        <div class="workspace-kicker">
          <button class="header-project-button" type="button" data-action="toggle-project-menu" aria-expanded="${state.projectMenuOpen}">
            <span class="project-name">${escapeHtml(projectName())}</span>
            <span class="chevron">▾</span>
          </button>
        </div>
        <div class="header-actions">
          <button class="automation-pill" type="button" data-action="open-projects-manage" title="${escapeHtml(t("project.manage"))}">${escapeHtml(t("project.manage"))}</button>
          <button class="automation-pill" type="button" data-action="open-automation" title="${escapeHtml(t("automation"))}">${escapeHtml(t("automation"))}</button>
          <button class="icon-button" type="button" data-action="create" data-status="todo" title="${escapeHtml(t("newIssue"))}">+</button>
        </div>
        ${
          state.projectMenuOpen
            ? `<div class="header-project-menu" role="menu" aria-label="${escapeHtml(t("project.manage"))}">
                <label class="project-menu-search">
                  <span class="sr-only">${escapeHtml(t("project.switch"))}</span>
                  <input
                    id="project-search"
                    type="search"
                    placeholder="${escapeHtml(t("project.switch"))}"
                    value="${escapeHtml(state.projectQuery)}"
                    autocomplete="off"
                  />
                </label>
                ${projectChoices()
                  .map(
                    (project) => `
                      <button type="button" role="menuitemradio" aria-checked="${project.id === state.projectId}" data-action="select-project" data-project-id="${escapeHtml(project.id)}">
                        <span class="avatar${project.id === ALL_PROJECT_ID ? " all-projects" : ""}">${project.id === ALL_PROJECT_ID ? (state.locale === "zh" ? "全" : "A") : "P"}</span>
                        <span>${escapeHtml(project.name)}</span>
                        ${project.id === state.projectId ? `<span class="project-menu-check" aria-hidden="true">${ICONS.check}</span>` : ""}
                      </button>
                    `,
                  )
                  .join("")}
                <div class="project-menu-footer">
                  <button type="button" role="menuitem" class="project-menu-add" data-action="open-projects-manage">
                    <span class="avatar">⚙</span>
                    <span>${escapeHtml(t("project.manage"))}</span>
                  </button>
                </div>
              </div>`
            : ""
        }
      </header>`
      }

      ${
        // 编辑器面板只展示看板/甘特/详情，搜索与视图切换留在左侧侧栏
        isSidebar && !showingDetail
          ? `<div class="board-toolbar">
        <div class="board-toolbar-top">
          <label class="search-field search-field-top">
            <span class="sr-only">${escapeHtml(t("toolbar.searchLabel"))}</span>
            <input id="task-search" type="search" placeholder="${escapeHtml(t("toolbar.search"))}" value="${escapeHtml(state.search)}" />
          </label>
        </div>
        <div class="view-tabs-row" aria-label="${escapeHtml(t("toolbar.views"))}">
          <div class="view-tabs view-tabs-primary">
            <button class="view-tab${state.view === "list" ? " active" : ""}" type="button" data-action="set-view" data-view="list">${escapeHtml(t("toolbar.list"))}</button>
          </div>
          <div class="view-tabs view-tabs-secondary">
            <button class="view-tab${state.view === "issues" ? " active" : ""}" type="button" data-action="set-view" data-view="issues">${escapeHtml(t("toolbar.board"))}</button>
            <button class="view-tab${state.view === "gantt" ? " active" : ""}" type="button" data-action="set-view" data-view="gantt">${escapeHtml(t("toolbar.gantt"))}</button>
          </div>
        </div>
      </div>`
          : ""
      }

      <div class="board-body${showingDetail ? " is-detail" : ""}${!showingDetail && state.view === "query" ? " is-query" : ""}${!showingDetail && state.view === "projects" ? " is-projects" : ""}${!showingDetail && (state.view === "settings" || state.view === "sync" || state.view === "outputBook") ? " is-sync" : ""}${!showingDetail && state.view === "gantt" ? " is-gantt" : ""}${!showingDetail && state.view === "outputBook" ? " is-output-book" : ""}">
        ${
          showingDetail
            ? renderIssueDetail(task)
            : state.view === "gantt"
              ? renderGantt()
              : state.view === "query"
                ? renderQueryPage()
                : state.view === "projects"
                  ? renderProjectsPage()
                  : state.view === "settings"
                    ? renderSettingsPage()
                    : state.view === "sync"
                      ? renderSyncSettingsPage()
                      : state.view === "outputBook"
                        ? renderOutputBookPage()
                        : `${renderBoard()}${renderList()}`
        }
      </div>
      ${renderContextMenu()}
      ${renderWorktreeWizard()}
      ${renderSyncPropsDialog()}
      ${renderAutomationDialog()}
      ${renderGitCommitDialog()}
      ${renderGitSelectDialog()}
      ${renderOutputConfigDialog()}
    `;

    bindEvents();

    const savedBookScroll = state.outputBookScroll;
    if (
      savedBookScroll &&
      savedBookScroll.bookId === (state.outputBookDialog?.bookId || "") &&
      savedBookScroll.chapterId === (state.outputBookDialog?.activeChapterId || "")
    ) {
      const nextBookScroller = app.querySelector(".output-book-markdown");
      if (nextBookScroller) nextBookScroller.scrollTop = savedBookScroll.top;
      const nextTocScroller = app.querySelector(".output-book-toc");
      if (nextTocScroller && savedBookScroll.tocTop != null) {
        nextTocScroller.scrollTop = savedBookScroll.tocTop;
      }
    } else if (savedBookScroll) {
      state.outputBookScroll = null;
    }

    const nextDetailScroller = app.querySelector(".issue-detail-scroll");
    const shouldFocusComment = Boolean(state.focusCommentInput);
    if (shouldFocusComment) {
      state.focusCommentInput = false;
      const composer = app.querySelector(".comment-composer");
      const input = document.getElementById("comment-input");
      if (composer && typeof composer.scrollIntoView === "function") {
        composer.scrollIntoView({ block: "end", behavior: "auto" });
      } else if (input && typeof input.scrollIntoView === "function") {
        input.scrollIntoView({ block: "center", behavior: "auto" });
      }
      if (input) {
        input.focus({ preventScroll: true });
        const len = input.value.length;
        input.setSelectionRange(len, len);
      }
    } else {
      if (
        nextDetailScroller &&
        savedDetailScrollTop != null &&
        state.selectedTaskId === savedTaskId
      ) {
        nextDetailScroller.scrollTop = savedDetailScrollTop;
      }

      // Keep the clicked report control focused without scrolling the page.
      // Skip reply-comment — that flow should land on the composer instead.
      if (restoreAction && restoreAction !== "reply-comment" && restoreCommentId) {
        const restoreBtn = app.querySelector(
          `[data-action="${restoreAction}"][data-comment-id="${CSS.escape(restoreCommentId)}"]`,
        );
        if (restoreBtn && typeof restoreBtn.focus === "function") {
          restoreBtn.focus({ preventScroll: true });
        }
      }
    }
  }

  function bindIssueEditor(task) {
    const titleInput = document.getElementById("issue-title-input");
    if (titleInput) {
      resizeTextarea(titleInput);
      titleInput.addEventListener("input", () => {
        const title = titleInput.value.replace(/\n/g, "");
        task.title = title;
        resizeTextarea(titleInput);
        clearTimeout(titleSaveTimer);
        titleSaveTimer = setTimeout(() => {
          void persistUpdate(task.id, { title }, { silent: true });
        }, 350);
      });
      titleInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          titleInput.blur();
        }
      });
      titleInput.addEventListener("blur", () => {
        clearTimeout(titleSaveTimer);
        void persistUpdate(task.id, { title: titleInput.value.replace(/\n/g, "") }, { silent: true });
      });
    }

    const descriptionInput = document.getElementById("issue-description-input");
    if (descriptionInput) {
      resizeTextarea(descriptionInput);
      descriptionInput.focus();
      descriptionInput.addEventListener("input", () => {
        task.description = descriptionInput.value;
        resizeTextarea(descriptionInput);
        clearTimeout(descriptionSaveTimer);
        descriptionSaveTimer = setTimeout(() => {
          void persistUpdate(task.id, { description: descriptionInput.value }, { silent: true });
        }, 350);
      });
      descriptionInput.addEventListener("blur", () => {
        clearTimeout(descriptionSaveTimer);
        void persistUpdate(task.id, { description: descriptionInput.value }, { silent: true }).then(() => {
          state.editingDescription = false;
          render();
        });
      });
      descriptionInput.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          state.editingDescription = false;
          render();
        }
      });
    }

    app
      .querySelectorAll(".detail-property-row [data-field], .issue-context-section [data-field]")
      .forEach((input) => {
        input.addEventListener("change", () => {
          const field = input.getAttribute("data-field");
          if (!field) return;
          let value = input.value;
          if (field === "gitBranch" || field === "worktreePath" || field === "projectId") {
            value = String(value || "").trim() || null;
          } else {
            value = value || null;
          }
          const patch = { [field]: value };
          if (field === "status") {
            patch.processing = value === "in_progress";
          }
          // 切换/清除项目关联时由存储层决定是否同步开发上下文
          void persistUpdate(task.id, patch);
        });
        if (input instanceof HTMLInputElement && input.type === "date") {
          input.addEventListener("click", () => {
            try {
              if (typeof input.showPicker === "function") input.showPicker();
            } catch {
              // Webview may reject showPicker outside a trusted gesture path.
            }
          });
        }
      });

    const labelInput = app.querySelector('[data-action-input="add-label"]');
    const labelField = app.querySelector(".detail-label-field");
    if (labelInput instanceof HTMLInputElement) {
      const closeLabelPicker = () => {
        if (!state.labelPicker) return;
        state.labelPicker = null;
        render();
      };
      const focusLabelInput = (selectionStart, selectionEnd) => {
        const next = app.querySelector('[data-action-input="add-label"]');
        if (!(next instanceof HTMLInputElement)) return;
        next.focus();
        const value = next.value;
        const start = selectionStart ?? value.length;
        const end = selectionEnd ?? value.length;
        next.setSelectionRange(start, end);
      };
      const openLabelPicker = () => {
        if (state.labelPicker) return;
        state.labelPicker = { query: String(labelInput.value || "") };
        render();
        focusLabelInput();
      };
      const commitCreate = () => {
        const label = String(labelInput.value || "").trim();
        if (!label) return;
        const labels = new Set(task.labels || []);
        labels.add(label);
        state.labelPicker = { query: "" };
        void persistUpdate(task.id, { labels: [...labels] });
      };
      labelInput.addEventListener("focus", openLabelPicker);
      labelInput.addEventListener("click", openLabelPicker);
      labelInput.addEventListener("input", () => {
        state.labelPicker = { query: String(labelInput.value || "") };
        const start = labelInput.selectionStart ?? labelInput.value.length;
        const end = labelInput.selectionEnd ?? labelInput.value.length;
        render();
        focusLabelInput(start, end);
      });
      labelInput.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closeLabelPicker();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          commitCreate();
        }
      });
      // 失焦且焦点不在选择面板内时关闭（延迟，避免点选项时被抢先关掉）
      labelInput.addEventListener("blur", (event) => {
        const related = event.relatedTarget;
        if (related instanceof Node && labelField?.contains(related)) return;
        window.setTimeout(() => {
          if (!state.labelPicker) return;
          const active = document.activeElement;
          const field = document.querySelector(".detail-label-field");
          if (field && active instanceof Node && field.contains(active)) return;
          // 鼠标仍在面板上（点选项过程中）不关
          if (field?.matches(":hover") || field?.querySelector(".label-picker:hover")) return;
          closeLabelPicker();
        }, 180);
      });
    }

    const commentForm = app.querySelector('[data-action-form="comment"]');
    const commentImageInput = document.getElementById("comment-image-input");
    if (commentForm) {
      const readCommentDraft = () => {
        const input = document.getElementById("comment-input");
        const body = (input?.value || state.commentDraft || "").trim();
        const pendingImages = state.pendingCommentImages || [];
        return { body, pendingImages, replyTo: state.replyTo };
      };
      const triggerSyncProcess = (feedbackBody = "") => {
        const commentInput = document.getElementById("comment-input");
        if (commentInput && typeof commentInput.blur === "function") commentInput.blur();
        vscode.postMessage({
          type: "afterWorkComment",
          taskId: task.identifier || task.id,
          threadId: state.replyTo?.threadId || task.threadId || "",
          body: feedbackBody,
          syncProcess: true,
        });
      };
      commentForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const { body, pendingImages, replyTo } = readCommentDraft();
        if (!body && !pendingImages.length) return;
        // 「评论」仅落库，不自动注入对话
        void persistComment(task.id, body, {
          parentCommentId: replyTo?.id || null,
          threadId: replyTo?.threadId || task.threadId || null,
          attachments: pendingImages,
          notifyAgent: false,
        });
      });
      const syncProcessBtn = commentForm.querySelector('[data-action="sync-process-comment"]');
      syncProcessBtn?.addEventListener("click", () => {
        const commentInput = document.getElementById("comment-input");
        if (commentInput && typeof commentInput.blur === "function") commentInput.blur();
        const { body, pendingImages, replyTo } = readCommentDraft();
        if (body || pendingImages.length) {
          void persistComment(task.id, body, {
            parentCommentId: replyTo?.id || null,
            threadId: replyTo?.threadId || task.threadId || null,
            attachments: pendingImages,
            notifyAgent: true,
            syncProcess: true,
          });
          return;
        }
        // 无新内容：直接打开对话，让 Agent 拉取最新评论处理
        triggerSyncProcess("");
      });

      commentForm.addEventListener("paste", (event) => {
        void handleCommentImagePaste(event).catch((error) => {
          vscode.postMessage({
            type: "toast",
            text: error instanceof Error ? error.message : "粘贴截图失败",
          });
        });
      });
      commentForm.addEventListener("dragover", (event) => {
        if (![...event.dataTransfer?.types || []].includes("Files")) return;
        event.preventDefault();
        commentForm.classList.add("is-drop-target");
      });
      commentForm.addEventListener("dragleave", (event) => {
        if (event.target !== commentForm && commentForm.contains(/** @type {Node} */ (event.target))) return;
        commentForm.classList.remove("is-drop-target");
      });
      commentForm.addEventListener("drop", (event) => {
        commentForm.classList.remove("is-drop-target");
        const images = collectImageFilesFromDataTransfer(event.dataTransfer);
        if (!images.length) return;
        event.preventDefault();
        const input = document.getElementById("comment-input");
        if (input) state.commentDraft = input.value;
        void addPendingCommentImages(images).catch((error) => {
          vscode.postMessage({
            type: "toast",
            text: error instanceof Error ? error.message : "添加图片失败",
          });
        });
      });
    }

    if (commentImageInput instanceof HTMLInputElement) {
      commentImageInput.addEventListener("change", () => {
        const files = [...(commentImageInput.files || [])];
        commentImageInput.value = "";
        const input = document.getElementById("comment-input");
        if (input) state.commentDraft = input.value;
        void addPendingCommentImages(files, { toastIfEmpty: true }).catch((error) => {
          vscode.postMessage({
            type: "toast",
            text: error instanceof Error ? error.message : "添加图片失败",
          });
        });
      });
    }

    const issueAttachmentInput = document.getElementById("issue-attachment-input");
    if (issueAttachmentInput instanceof HTMLInputElement) {
      issueAttachmentInput.addEventListener("change", () => {
        const files = [...(issueAttachmentInput.files || [])];
        issueAttachmentInput.value = "";
        const current = selectedTask();
        if (!current || !files.length) return;
        void persistAddIssueAttachments(current.id, files);
      });
    }

    const commentInput = document.getElementById("comment-input");
    if (commentInput) {
      commentInput.addEventListener("input", () => {
        state.commentDraft = commentInput.value;
      });
    }

    const parentSearch = app.querySelector(".parent-picker-input");
    if (parentSearch && !state.focusCommentInput && !state.replyTo) {
      parentSearch.focus({ preventScroll: true });
      const value = parentSearch.value;
      parentSearch.setSelectionRange(value.length, value.length);
      parentSearch.addEventListener("input", (event) => {
        if (!state.parentPicker) return;
        state.parentPicker = { query: event.target.value };
        render();
      });
    }

    const relationSearch = app.querySelector(".relation-picker-input:not(.parent-picker-input)");
    if (relationSearch && !state.focusCommentInput && !state.replyTo && !state.parentPicker) {
      relationSearch.focus({ preventScroll: true });
      const value = relationSearch.value;
      relationSearch.setSelectionRange(value.length, value.length);
      relationSearch.addEventListener("input", (event) => {
        if (!state.relationPicker) return;
        state.relationPicker = {
          ...state.relationPicker,
          query: event.target.value,
        };
        render();
      });
    }
  }

  function bindEvents() {
    const task = selectedTask();

    const search = document.getElementById("task-search");
    if (search) {
      search.addEventListener("input", (event) => {
        state.search = event.target.value;
        const value = state.search;
        render();
        const next = document.getElementById("task-search");
        if (next) {
          next.focus();
          next.value = value;
          next.setSelectionRange(value.length, value.length);
        }
      });
    }

    app.querySelectorAll("[data-wt-branch-search]").forEach((input, focusIndex) => {
      if (!(input instanceof HTMLInputElement)) return;
      if (focusIndex === 0 && !state.worktreeWizard?.busy) {
        input.focus();
        const value = input.value;
        input.setSelectionRange(value.length, value.length);
      }
      input.addEventListener("input", () => {
        if (!state.worktreeWizard) return;
        const index = Number(input.getAttribute("data-index"));
        if (!Number.isFinite(index) || !state.worktreeWizard.repos?.[index]) return;
        const nextQuery = String(input.value || "");
        const repo = state.worktreeWizard.repos[index];
        const exact = repo.branches.find((item) => item === nextQuery.trim());
        const repos = state.worktreeWizard.repos.map((item, i) =>
          i === index
            ? {
                ...item,
                branchQuery: nextQuery,
                selectedBranch: exact || (nextQuery.trim() ? nextQuery.trim() : item.selectedBranch),
              }
            : item,
        );
        state.worktreeWizard = { ...state.worktreeWizard, repos, error: "" };
        render();
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          const submit = app.querySelector('[data-action="wt-wizard-submit"]');
          if (submit instanceof HTMLButtonElement && !submit.disabled) submit.click();
        }
      });
    });

    const wizardBackdrop = app.querySelector("[data-wt-backdrop]");
    if (wizardBackdrop) {
      wizardBackdrop.addEventListener("click", (event) => {
        if (event.target === wizardBackdrop && !state.worktreeWizard?.busy) {
          closeWorktreeWizard();
        }
      });
    }

    const syncPropsBackdrop = app.querySelector("[data-sync-props-backdrop]");
    if (syncPropsBackdrop) {
      syncPropsBackdrop.addEventListener("click", (event) => {
        if (event.target === syncPropsBackdrop && !state.syncPropsDialog?.busy) {
          state.syncPropsDialog = null;
          render();
        }
      });
    }

    const automationBackdrop = app.querySelector("[data-automation-backdrop]");
    if (automationBackdrop) {
      automationBackdrop.addEventListener("click", (event) => {
        if (event.target === automationBackdrop) {
          const wasBusy = Boolean(state.automationDialog?.busy);
          state.automationDialog = null;
          if (wasBusy) {
            vscode.postMessage({ type: "toast", text: "自动化继续在后台处理" });
          }
          render();
        }
      });
    }

    const gitBackdrop = app.querySelector("[data-git-dialog-backdrop]");
    if (gitBackdrop) {
      gitBackdrop.addEventListener("click", (event) => {
        if (event.target === gitBackdrop && !state.gitDialog?.busy) {
          closeGitDialog();
        }
      });
    }

    const gitSelectBackdrop = app.querySelector("[data-git-select-backdrop]");
    if (gitSelectBackdrop) {
      gitSelectBackdrop.addEventListener("click", (event) => {
        if (event.target === gitSelectBackdrop && !state.gitSelectDialog?.busy) {
          closeGitSelectDialog();
        }
      });
    }

    const outputConfigBackdrop = app.querySelector("[data-output-config-backdrop]");
    if (outputConfigBackdrop) {
      outputConfigBackdrop.addEventListener("click", (event) => {
        if (event.target === outputConfigBackdrop && !state.outputConfigDialog?.busy) {
          state.outputConfigDialog = null;
          render();
        }
      });
    }

    const gitSelectUrl = app.querySelector("[data-git-select-field='gitUrl']");
    if (gitSelectUrl instanceof HTMLInputElement) {
      gitSelectUrl.addEventListener("input", () => {
        if (!state.gitSelectDialog || state.gitSelectDialog.busy) return;
        state.gitSelectDialog.gitUrl = gitSelectUrl.value;
        if (!String(state.gitSelectDialog.cloneFolderName || "").trim()) {
          const guessed = guessRepoFolderName(gitSelectUrl.value);
          if (guessed) {
            state.gitSelectDialog.cloneFolderName = guessed;
            const folderInput = app.querySelector("[data-git-select-field='cloneFolderName']");
            if (folderInput instanceof HTMLInputElement) folderInput.value = guessed;
          }
        }
        const fetchBtn = app.querySelector("[data-action='git-select-fetch']");
        if (fetchBtn instanceof HTMLButtonElement) {
          fetchBtn.disabled =
            state.gitSelectDialog.fetching || !String(gitSelectUrl.value || "").trim();
        }
        const cloneBtn = app.querySelector("[data-action='git-select-clone']");
        if (cloneBtn instanceof HTMLButtonElement) {
          cloneBtn.disabled = !gitSelectCanClone(state.gitSelectDialog);
        }
      });
    }

    const gitSelectFolder = app.querySelector("[data-git-select-field='cloneFolderName']");
    if (gitSelectFolder instanceof HTMLInputElement) {
      gitSelectFolder.addEventListener("input", () => {
        if (!state.gitSelectDialog || state.gitSelectDialog.busy) return;
        state.gitSelectDialog.cloneFolderName = gitSelectFolder.value;
        const cloneBtn = app.querySelector("[data-action='git-select-clone']");
        if (cloneBtn instanceof HTMLButtonElement) {
          cloneBtn.disabled = !gitSelectCanClone(state.gitSelectDialog);
        }
        const hint = app.querySelector(".git-select-dialog .project-folder-hint");
        if (hint && state.gitSelectDialog.cloneParent) {
          const dest = `${state.gitSelectDialog.cloneParent.replace(/[\\/]+$/, "")}/${gitSelectFolder.value.trim()}`;
          hint.textContent = dest || state.gitSelectDialog.cloneParent;
        }
      });
    }

    const gitSelectBranch = app.querySelector("[data-action='git-select-branch']");
    if (gitSelectBranch instanceof HTMLSelectElement) {
      gitSelectBranch.addEventListener("change", () => {
        if (!state.gitSelectDialog || state.gitSelectDialog.busy) return;
        state.gitSelectDialog.selectedBranch = gitSelectBranch.value;
        const cloneBtn = app.querySelector("[data-action='git-select-clone']");
        if (cloneBtn instanceof HTMLButtonElement) {
          cloneBtn.disabled = !gitSelectCanClone(state.gitSelectDialog);
        }
      });
    }

    const gitBranchSelect = app.querySelector("[data-action='git-commit-branch']");
    if (gitBranchSelect instanceof HTMLSelectElement) {
      gitBranchSelect.addEventListener("change", () => {
        if (!state.gitDialog || state.gitDialog.busy) return;
        const repo = activeGitRepo();
        if (!repo?.isGit) return;
        const branch = gitBranchSelect.value;
        if (!branch || branch === repo.branch) return;
        void refreshActiveGitRepo(async (current) => {
          const result = await storeRequest(
            "git.checkout",
            { path: current.folderPath, branch },
            { timeoutMs: 30000 },
          );
          vscode.postMessage({ type: "toast", text: `已切换到 ${branch}` });
          return result.repo || current;
        });
      });
    }

    const gitMessage = document.getElementById("git-commit-message");
    if (gitMessage instanceof HTMLTextAreaElement) {
      gitMessage.addEventListener("input", () => {
        if (!state.gitDialog) return;
        state.gitDialog.message = gitMessage.value;
        const repo = activeGitRepo();
        const selectedCount = repo?.files?.filter((file) => file.selected).length || 0;
        const canCommit =
          Boolean(repo?.isGit) &&
          selectedCount > 0 &&
          Boolean(gitMessage.value.trim()) &&
          !state.gitDialog.busy &&
          !state.gitDialog.loading;
        const submit = app.querySelector("[data-action='git-commit-submit']");
        const pushBtn = app.querySelector("[data-action='git-commit-push']");
        if (submit instanceof HTMLButtonElement) {
          submit.disabled = !canCommit;
          submit.textContent = `提交${selectedCount ? `（${selectedCount}）` : ""}`;
        }
        if (pushBtn instanceof HTMLButtonElement) {
          pushBtn.disabled = !canCommit;
          pushBtn.textContent = `提交并推送${selectedCount ? `（${selectedCount}）` : ""}`;
        }
      });
    }

    const gitNewBranchInput = document.getElementById("git-new-branch-input");
    if (gitNewBranchInput instanceof HTMLInputElement) {
      gitNewBranchInput.focus();
      gitNewBranchInput.select();
      gitNewBranchInput.addEventListener("input", () => {
        if (!state.gitDialog) return;
        state.gitDialog.newBranchName = gitNewBranchInput.value;
        const createBtn = app.querySelector("[data-action='git-commit-create-branch']");
        if (createBtn instanceof HTMLButtonElement) {
          createBtn.disabled = state.gitDialog.busy || !gitNewBranchInput.value.trim();
        }
      });
      gitNewBranchInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          const createBtn = app.querySelector("[data-action='git-commit-create-branch']");
          if (createBtn instanceof HTMLButtonElement && !createBtn.disabled) createBtn.click();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (!state.gitDialog?.busy) {
            state.gitDialog = { ...state.gitDialog, creatingBranch: false, error: "" };
            render();
          }
        }
      });
    }

    const projectSearch = document.getElementById("project-search");
    if (projectSearch && !state.worktreeWizard) {
      projectSearch.focus();
      projectSearch.addEventListener("input", (event) => {
        state.projectQuery = event.target.value;
        const value = state.projectQuery;
        render();
        const next = document.getElementById("project-search");
        if (next) {
          next.focus();
          next.value = value;
          next.setSelectionRange(value.length, value.length);
        }
      });
      projectSearch.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          state.projectMenuOpen = false;
          state.projectQuery = "";
          render();
        }
      });
    }

    app.querySelectorAll("[data-action]").forEach((el) => {
      el.addEventListener("click", (event) => {
        event.stopPropagation();
        const action = el.getAttribute("data-action");
        if (action === "toggle-project-menu") {
          state.projectMenuOpen = !state.projectMenuOpen;
          if (!state.projectMenuOpen) state.projectQuery = "";
          render();
        } else if (action === "open-projects-manage") {
          openProjectsManage();
        } else if (action === "open-sync-settings") {
          openSyncSettings();
        } else if (action === "settings-open-sync") {
          state.settingsSection = "sync";
          void loadSyncConfig();
          render();
        } else if (action === "settings-back") {
          state.settingsSection = null;
          render();
        } else if (action === "sync-save") {
          void (async () => {
            const cfg = syncConfigFromDom();
            if (!cfg) return;
            cfg.busy = true;
            cfg.error = "";
            cfg.message = "";
            render();
            try {
              const result = await storeRequest(
                "sync.saveConfig",
                {
                  payload: {
                    mode: cfg.mode,
                    gitUrl: cfg.gitUrl,
                    branch: cfg.branch,
                    scheduleEnabled: cfg.scheduleEnabled,
                    scheduleHour: cfg.scheduleHour,
                  },
                },
                { timeoutMs: 15000 },
              );
              state.syncConfig = {
                ...cfg,
                ...(result.sync || {}),
                mode: result.sync?.mode === "git" ? "git" : "local",
                busy: false,
                message: "配置已保存",
                error: "",
              };
              render();
            } catch (error) {
              cfg.busy = false;
              cfg.error = error instanceof Error ? error.message : String(error);
              render();
            }
          })();
        } else if (action === "sync-push" || action === "sync-pull" || action === "sync-merge") {
          void (async () => {
            const cfg = syncConfigFromDom();
            if (!cfg) return;
            if (cfg.mode !== "git") {
              cfg.error = "请先切换到 Git 备份并保存";
              render();
              return;
            }
            cfg.busy = true;
            cfg.error = "";
            cfg.message = "";
            render();
            try {
              await storeRequest(
                "sync.saveConfig",
                {
                  payload: {
                    mode: cfg.mode,
                    gitUrl: cfg.gitUrl,
                    branch: cfg.branch,
                    scheduleEnabled: cfg.scheduleEnabled,
                    scheduleHour: cfg.scheduleHour,
                  },
                },
                { timeoutMs: 15000 },
              );
              const type =
                action === "sync-push" ? "sync.push" : action === "sync-merge" ? "sync.merge" : "sync.pull";
              const result = await storeRequest(type, {}, { timeoutMs: 180000 });
              if (result.cancelled) {
                cfg.busy = false;
                cfg.message = "已取消";
                render();
                return;
              }
              state.syncConfig = {
                ...cfg,
                ...(result.sync || {}),
                mode: (result.sync?.mode || cfg.mode) === "git" ? "git" : "local",
                busy: false,
                message: result.message || (action === "sync-push" ? "已同步到 Git" : "已从 Git 同步"),
                error: "",
              };
              render();
              vscode.postMessage({ type: "store.getSnapshot" });
            } catch (error) {
              cfg.busy = false;
              cfg.error = error instanceof Error ? error.message : String(error);
              render();
            }
          })();
        } else if (action === "project-create-open") {
          openProjectCreateForm();
        } else if (action === "project-edit") {
          const projectId = el.getAttribute("data-project-id") || "";
          if (projectId) openProjectEditForm(projectId);
        } else if (action === "project-open-workspace") {
          const projectId = el.getAttribute("data-project-id") || "";
          if (!projectId) return;
          vscode.postMessage({ type: "project.openWorkspace", projectId });
        } else if (action === "select-project") {
          state.projectId = el.getAttribute("data-project-id");
          state.projectMenuOpen = false;
          state.projectQuery = "";
          state.selectedTaskId = null;
          state.editingDescription = false;
          render();
        } else if (action === "set-view") {
          const nextView = el.getAttribute("data-view");
          // 侧栏点议题看板 / 甘特图：直接在右侧编辑器面板打开
          if (
            isSidebar &&
            (nextView === "issues" ||
              nextView === "gantt" ||
              nextView === "query" ||
              nextView === "projects" ||
              nextView === "sync")
          ) {
            vscode.postMessage({ type: "openViewInEditor", view: nextView });
            return;
          }
          state.view = nextView;
          state.selectedTaskId = null;
          state.editingDescription = false;
          if (nextView !== "projects") state.projectWizard = null;
          if (nextView !== "settings") state.settingsSection = null;
          if (nextView === "sync") void loadSyncConfig();
          render();
        } else if (action === "set-query-status") {
          state.queryStatus = el.getAttribute("data-status") || "backlog";
          render();
        } else if (action === "toggle-list-group") {
          const status = el.getAttribute("data-status") || "";
          if (!status) return;
          // 默认折叠：未记录时视为已折叠，点击后展开
          const currentlyCollapsed = state.collapsedGroups[status] !== false;
          state.collapsedGroups = {
            ...state.collapsedGroups,
            [status]: !currentlyCollapsed,
          };
          render();
        } else if (action === "toggle-subissues") {
          const taskId = el.getAttribute("data-task-id") || "";
          if (!taskId) return;
          const currentlyExpanded = state.expandedSubIssues[taskId] === true;
          state.expandedSubIssues = {
            ...state.expandedSubIssues,
            [taskId]: !currentlyExpanded,
          };
          render();
        } else if (action === "add-subissue") {
          const parentId = el.getAttribute("data-task-id") || selectedTask()?.id;
          const parent = state.tasks.find((item) => item.id === parentId);
          if (!parent) return;
          void persistCreate({
            projectId: parent.projectId,
            status: parent.status || "todo",
            title: "子议题",
            parentIssueId: parent.id,
            labels: [],
          }).then((created) => {
            if (!created) return;
            // 列表保持默认折叠；详情页的「子议题」区块本身会列出全部子项
            state.editingDescription = false;
            state.parentPicker = null;
            if (isSidebar) {
              // 侧栏创建后仍打开父议题详情，便于继续添加/查看子议题
              openIssueInEditor(parent.id);
            } else {
              state.selectedTaskId = parent.id;
              render();
            }
          });
        } else if (action === "toggle-parent-picker") {
          state.parentPicker = state.parentPicker ? null : { query: "" };
          render();
        } else if (action === "parent-pick") {
          const taskId = el.getAttribute("data-task-id");
          const targetId = el.getAttribute("data-target-id");
          if (!taskId || !targetId) return;
          state.parentPicker = null;
          void persistUpdate(taskId, { parentIssueId: targetId });
        } else if (action === "clear-parent") {
          const taskId = el.getAttribute("data-task-id") || selectedTask()?.id;
          if (!taskId) return;
          state.parentPicker = null;
          void persistUpdate(taskId, { parentIssueId: null });
        } else if (action === "remove-label") {
          const current = selectedTask();
          const label = el.getAttribute("data-label") || "";
          if (!current || !label) return;
          const labels = (current.labels || []).filter((item) => item !== label);
          void persistUpdate(current.id, { labels });
        } else if (action === "toggle-detail-label") {
          const current = selectedTask();
          const label = el.getAttribute("data-label") || "";
          if (!current || !label) return;
          const labels = new Set(current.labels || []);
          if (labels.has(label)) labels.delete(label);
          else labels.add(label);
          if (state.labelPicker) state.labelPicker = { query: state.labelPicker.query || "" };
          void persistUpdate(current.id, { labels: [...labels] });
        } else if (action === "create-detail-label") {
          const current = selectedTask();
          const label = el.getAttribute("data-label") || "";
          if (!current || !label) return;
          const labels = new Set(current.labels || []);
          labels.add(label);
          state.labelPicker = { query: "" };
          void persistUpdate(current.id, { labels: [...labels] });
        } else if (action === "sync-chat") {
          const taskId = el.getAttribute("data-task-id") || task?.id;
          if (!taskId) return;
          void (async () => {
            try {
              const result = await storeRequest(
                "syncChat",
                { taskId, quiet: false },
                { timeoutMs: 60000 },
              );
              state.activityShowCount = Number.MAX_SAFE_INTEGER;
              if (!result.added) {
                vscode.postMessage({
                  type: "toast",
                  text: result.reason === "no-thread" ? "尚未绑定对话" : "没有新的对话可同步",
                });
              }
              render();
            } catch (error) {
              vscode.postMessage({
                type: "toast",
                text: error instanceof Error ? error.message : "同步对话失败",
              });
            }
          })();
        } else if (action === "close-detail") {
          state.selectedTaskId = null;
          state.editingDescription = false;
          state.labelPicker = null;
          state.parentPicker = null;
          state.replyTo = null;
          state.pendingCommentImages = [];
          state.commentDraft = "";
          vscode.postMessage({ type: "watchChatSync", taskId: null });
          render();
        } else if (action === "edit-description") {
          state.editingDescription = true;
          render();
        } else if (action === "create") {
          const status = el.getAttribute("data-status") || "todo";
          void persistCreate({
            projectId:
              state.projectId === ALL_PROJECT_ID
                ? state.projects?.[0]?.id
                : state.projectId,
            status,
            title: "新建议题",
          }).then((created) => {
            if (!created) return;
            state.editingDescription = false;
            if (isSidebar) {
              openIssueInEditor(created.id);
            } else {
              state.selectedTaskId = created.id;
              render();
            }
          });
        } else if (action === "open-chat") {
          {
            const taskId = el.getAttribute("data-task-id") || "";
            const task = state.tasks.find(
              (item) => item.id === taskId || item.identifier === taskId,
            );
            const threadId = task?.threadId || el.getAttribute("data-thread-id") || "";
            vscode.postMessage({
              type: "openNativeChat",
              taskId,
              threadId: threadId || undefined,
              preferExisting: Boolean(threadId),
            });
          }
        } else if (action === "open-thread") {
          vscode.postMessage({
            type: "openNativeChat",
            taskId: el.getAttribute("data-task-id"),
            threadId: el.getAttribute("data-thread-id"),
            preferExisting: true,
          });
        } else if (action === "toggle-properties") {
          state.propertiesCollapsed = !state.propertiesCollapsed;
          render();
        } else if (action === "open-automation") {
          openAutomationDialog();
        } else if (action === "close-automation") {
          const wasBusy = Boolean(state.automationDialog?.busy);
          state.automationDialog = null;
          render();
          if (wasBusy) {
            vscode.postMessage({ type: "toast", text: "自动化继续在后台处理" });
          }
        } else if (action === "rescan-automation") {
          if (state.automationDialog?.busy) return;
          openAutomationDialog();
        } else if (action === "toggle-automation-item") {
          const dialog = state.automationDialog;
          const taskId = el.getAttribute("data-task-id") || "";
          if (!dialog || !taskId || dialog.busy) return;
          state.automationDialog = {
            ...dialog,
            items: dialog.items.map((item) =>
              item.id === taskId ? { ...item, selected: !item.selected } : item,
            ),
          };
          render();
        } else if (action === "run-automation") {
          const dialog = state.automationDialog;
          if (!dialog || dialog.busy) return;
          const selected = dialog.items.filter((item) => item.selected).slice(0, AUTOMATION_BATCH_LIMIT);
          if (!selected.length) return;
          const runId = `auto-${Date.now()}`;
          state.automationDialog = {
            ...dialog,
            busy: true,
            runId,
            error: "",
            progress: `准备处理 ${selected.length} 个议题…`,
          };
          render();
          void storeRequest(
            "batchProcessIssues",
            {
              issueIds: selected.map((item) => item.id),
              gapMs: 1800,
            },
            { timeoutMs: 120000 },
          )
            .then((result) => {
              const started = Number(result?.started || 0);
              const failed = Number(result?.failed || 0);
              // 用户已关闭对话框时勿覆盖新打开的自动化窗
              if (state.automationDialog?.runId === runId) {
                state.automationDialog = null;
                render();
              }
              vscode.postMessage({
                type: "toast",
                text:
                  failed > 0
                    ? `已启动 ${started} 个对话，${failed} 个失败`
                    : `已排队打开并提交 ${started} 个对话`,
              });
            })
            .catch((error) => {
              const message = error instanceof Error ? error.message : "批量处理失败";
              if (state.automationDialog?.runId === runId) {
                state.automationDialog = {
                  ...state.automationDialog,
                  busy: false,
                  progress: "",
                  error: message,
                };
                render();
              } else {
                vscode.postMessage({ type: "toast", text: message });
              }
            });
        } else if (action === "open-sync-props") {
          const taskId = el.getAttribute("data-task-id") || selectedTask()?.id;
          const current = state.tasks.find((item) => item.id === taskId) || selectedTask();
          if (!current) return;
          state.syncPropsDialog = {
            taskId: current.id,
            identifier: current.identifier || current.id,
            hasThread: Boolean(current.threadId),
            busy: false,
            error: "",
          };
          render();
        } else if (action === "close-sync-props") {
          if (state.syncPropsDialog?.busy) return;
          state.syncPropsDialog = null;
          render();
        } else if (action === "confirm-sync-props") {
          const dialog = state.syncPropsDialog;
          if (!dialog || dialog.busy) return;
          state.syncPropsDialog = { ...dialog, busy: true, error: "" };
          render();
          void storeRequest(
            "syncProperties",
            { taskId: dialog.taskId },
            { timeoutMs: 60000 },
          )
            .then((result) => {
              state.syncPropsDialog = null;
              render();
              const notified = Boolean(result?.notifiedAgent);
              vscode.postMessage({
                type: "toast",
                text: notified
                  ? "已刷新属性，并已请求 Agent 核对同步"
                  : "已刷新本地属性",
              });
            })
            .catch((error) => {
              state.syncPropsDialog = {
                ...dialog,
                busy: false,
                error: error instanceof Error ? error.message : "同步属性失败",
              };
              render();
            });
        } else if (action === "expand-activity-more") {
          const current = Math.max(
            ACTIVITY_PREVIEW_COUNT,
            Number(state.activityShowCount) || ACTIVITY_PREVIEW_COUNT,
          );
          state.activityShowCount = current + ACTIVITY_EXPAND_STEP;
          render();
        } else if (action === "expand-activity-all") {
          state.activityShowCount = Number.MAX_SAFE_INTEGER;
          render();
        } else if (action === "collapse-activity") {
          state.activityShowCount = ACTIVITY_PREVIEW_COUNT;
          render();
        } else if (action === "toggle-report") {
          const commentId = el.getAttribute("data-comment-id") || "";
          if (!commentId) return;
          state.expandedReports = {
            ...state.expandedReports,
            [commentId]: !state.expandedReports[commentId],
          };
          render();
        } else if (action === "fork-chat") {
          const taskId = el.getAttribute("data-task-id");
          const commentId = el.getAttribute("data-comment-id");
          if (!taskId || !commentId) return;
          vscode.postMessage({
            type: "forkChat",
            taskId,
            commentId,
            bubbleId: el.getAttribute("data-bubble-id") || "",
          });
        } else if (action === "reply-comment") {
          const commentId = el.getAttribute("data-comment-id");
          const current = selectedTask();
          const target = (current?.comments || []).find((item) => item.id === commentId);
          if (!target) return;
          state.replyTo = {
            id: target.id,
            authorName: target.authorName || "评论",
            authorType: target.authorType || "user",
            body: target.body || "",
            attachments: target.attachments || [],
            threadId: target.threadId || selectedTask()?.threadId || null,
          };
          state.focusCommentInput = true;
          render();
        } else if (action === "clear-reply") {
          state.replyTo = null;
          render();
        } else if (action === "remove-pending-image") {
          const imageId = el.getAttribute("data-image-id") || "";
          if (!imageId) return;
          const input = document.getElementById("comment-input");
          if (input) state.commentDraft = input.value;
          state.pendingCommentImages = (state.pendingCommentImages || []).filter((item) => item.id !== imageId);
          render();
        } else if (action === "pick-comment-image") {
          const input = document.getElementById("comment-input");
          if (input) state.commentDraft = input.value;
          const fileInput = document.getElementById("comment-image-input");
          if (fileInput instanceof HTMLInputElement) fileInput.click();
        } else if (action === "pick-issue-attachment") {
          const fileInput = document.getElementById("issue-attachment-input");
          if (fileInput instanceof HTMLInputElement) fileInput.click();
        } else if (action === "remove-issue-attachment") {
          const attachmentId = el.getAttribute("data-attachment-id") || "";
          const current = selectedTask();
          if (!current || !attachmentId) return;
          void (async () => {
            try {
              const result = await storeRequest("store.removeIssueAttachment", {
                taskId: current.id,
                attachmentId,
              });
              if (result.issue) {
                upsertTask(result.issue);
                render();
              }
            } catch (error) {
              vscode.postMessage({
                type: "toast",
                text: error instanceof Error ? error.message : "删除附件失败",
              });
            }
          })();
        } else if (action === "open-attachment") {
          const relPath = el.getAttribute("data-rel-path") || "";
          if (!relPath) return;
          vscode.postMessage({ type: "attachment.open", relPath });
        } else if (action === "outputs-config-open") {
          const taskId = el.getAttribute("data-task-id") || selectedTask()?.id || "";
          const task = state.tasks.find((item) => item.id === taskId) || selectedTask();
          if (!task) return;
          openOutputConfigDialog(task);
        } else if (action === "outputs-config-close") {
          if (state.outputConfigDialog?.busy) return;
          state.outputConfigDialog = null;
          render();
        } else if (action === "outputs-config-remove") {
          if (!state.outputConfigDialog || state.outputConfigDialog.busy) return;
          const bookId = el.getAttribute("data-book-id") || "";
          state.outputConfigDialog = {
            ...state.outputConfigDialog,
            books: (state.outputConfigDialog.books || []).filter((book) => book.id !== bookId),
            error: "",
            message: "",
          };
          render();
        } else if (action === "outputs-config-pick") {
          if (!state.outputConfigDialog || state.outputConfigDialog.busy) return;
          const bookId = el.getAttribute("data-book-id") || "";
          if (!bookId) return;
          const draft = readOutputConfigFromDom();
          state.outputConfigDialog = {
            ...state.outputConfigDialog,
            books: draft,
            busy: true,
            error: "",
            message: "",
          };
          render();
          void (async () => {
            try {
              const result = await storeRequest("outputs.pickFolder", {}, { timeoutMs: 120000 });
              if (!state.outputConfigDialog) return;
              const books = readOutputConfigFromDom().map((book) =>
                book.id === bookId && result.folder
                  ? { ...book, rootPath: String(result.folder) }
                  : book,
              );
              state.outputConfigDialog = {
                ...state.outputConfigDialog,
                books: result.cancelled ? readOutputConfigFromDom() : books,
                busy: false,
              };
              render();
            } catch (error) {
              if (!state.outputConfigDialog) return;
              state.outputConfigDialog = {
                ...state.outputConfigDialog,
                books: readOutputConfigFromDom(),
                busy: false,
                error: error instanceof Error ? error.message : t("outputs.configPickFailed"),
              };
              render();
            }
          })();
        } else if (action === "outputs-config-save") {
          if (!state.outputConfigDialog || state.outputConfigDialog.busy) return;
          const taskId = state.outputConfigDialog.taskId;
          const books = readOutputConfigFromDom();
          state.outputConfigDialog = {
            ...state.outputConfigDialog,
            books,
            busy: true,
            error: "",
            message: "",
          };
          render();
          void (async () => {
            try {
              const result = await storeRequest(
                "outputs.saveConfig",
                { taskId, books },
                { timeoutMs: 30000 },
              );
              if (result.issue) upsertTask(result.issue);
              state.outputConfigDialog = null;
              render();
              vscode.postMessage({ type: "toast", text: t("outputs.configSaved") });
            } catch (error) {
              if (!state.outputConfigDialog) return;
              state.outputConfigDialog = {
                ...state.outputConfigDialog,
                books: readOutputConfigFromDom(),
                busy: false,
                error: error instanceof Error ? error.message : t("outputs.configSaveFailed"),
              };
              render();
            }
          })();
        } else if (action === "outputs-add") {
          const taskId = el.getAttribute("data-task-id") || selectedTask()?.id || "";
          const task = state.tasks.find((item) => item.id === taskId) || selectedTask();
          if (!taskId || !task) return;
          void (async () => {
            try {
              const result = await storeRequest(
                "outputs.summarizeBook",
                {
                  taskId,
                  title: `${task.identifier || ""} 产品功能书`.trim(),
                },
                { timeoutMs: 180000 },
              );
              if (result.issue) upsertTask(result.issue);
              render();
              vscode.postMessage({
                type: "toast",
                text: t("outputs.summarizeStarted", {
                  title: result.book?.title || t("outputs.untitled"),
                }),
              });
            } catch (error) {
              vscode.postMessage({
                type: "toast",
                text: error instanceof Error ? error.message : t("outputs.addFailed"),
              });
            }
          })();
        } else if (action === "outputs-bind") {
          const taskId =
            el.getAttribute("data-task-id") ||
            state.outputConfigDialog?.taskId ||
            selectedTask()?.id ||
            "";
          if (!taskId) return;
          if (state.outputConfigDialog) {
            state.outputConfigDialog = {
              ...state.outputConfigDialog,
              books: readOutputConfigFromDom(),
              busy: true,
              error: "",
              message: "",
            };
            render();
          }
          void (async () => {
            try {
              const result = await storeRequest("outputs.pickBook", { taskId }, { timeoutMs: 120000 });
              if (result.cancelled) {
                if (state.outputConfigDialog) {
                  state.outputConfigDialog = { ...state.outputConfigDialog, busy: false };
                  render();
                }
                return;
              }
              if (result.issue) upsertTask(result.issue);
              if (state.outputConfigDialog && result.issue) {
                const books = (Array.isArray(result.issue.outputs) ? result.issue.outputs : []).map((book) => ({
                  id: book.id,
                  title: book.title || t("outputs.untitled"),
                  rootPath: book.rootPath || "",
                }));
                state.outputConfigDialog = {
                  ...state.outputConfigDialog,
                  books,
                  busy: false,
                  message: t("outputs.added", { title: result.book?.title || t("outputs.untitled") }),
                };
              }
              render();
              vscode.postMessage({
                type: "toast",
                text: t("outputs.added", { title: result.book?.title || t("outputs.untitled") }),
              });
            } catch (error) {
              if (state.outputConfigDialog) {
                state.outputConfigDialog = {
                  ...state.outputConfigDialog,
                  busy: false,
                  error: error instanceof Error ? error.message : t("outputs.addFailed"),
                };
                render();
              }
              vscode.postMessage({
                type: "toast",
                text: error instanceof Error ? error.message : t("outputs.addFailed"),
              });
            }
          })();
        } else if (action === "outputs-open") {
          const taskId = el.getAttribute("data-task-id") || "";
          const bookId = el.getAttribute("data-book-id") || "";
          const task = state.tasks.find((item) => item.id === taskId) || selectedTask();
          if (!task || !bookId) return;
          openOutputBook(task, bookId);
        } else if (action === "outputs-refresh") {
          const taskId = el.getAttribute("data-task-id") || "";
          const bookId = el.getAttribute("data-book-id") || "";
          if (!taskId || !bookId) return;
          void (async () => {
            try {
              const result = await storeRequest(
                "outputs.refreshBook",
                { taskId, bookId },
                { timeoutMs: 30000 },
              );
              if (result.issue) upsertTask(result.issue);
              if (state.outputBookDialog?.bookId === bookId && result.book) {
                state.outputBookDialog = {
                  ...state.outputBookDialog,
                  title: result.book.title || state.outputBookDialog.title,
                  rootPath: result.book.rootPath || state.outputBookDialog.rootPath,
                  chapters: Array.isArray(result.book.chapters) ? result.book.chapters : [],
                };
                const firstId = state.outputBookDialog.chapters[0]?.id || null;
                state.outputBookDialog.activeChapterId = firstId;
                render();
                if (firstId) void loadOutputChapter(firstId);
                else render();
              } else {
                render();
              }
              vscode.postMessage({ type: "toast", text: t("outputs.refreshed") });
            } catch (error) {
              vscode.postMessage({
                type: "toast",
                text: error instanceof Error ? error.message : t("outputs.refreshFailed"),
              });
            }
          })();
        } else if (action === "outputs-remove") {
          const taskId = el.getAttribute("data-task-id") || "";
          const bookId = el.getAttribute("data-book-id") || "";
          const task = state.tasks.find((item) => item.id === taskId);
          if (!task || !bookId) return;
          const next = (Array.isArray(task.outputs) ? task.outputs : []).filter((item) => item.id !== bookId);
          if (state.outputBookDialog?.bookId === bookId) state.outputBookDialog = null;
          void persistUpdate(taskId, { outputs: next });
        } else if (action === "outputs-back-issue") {
          const taskId = el.getAttribute("data-task-id") || state.outputBookDialog?.taskId || "";
          if (!taskId) return;
          state.view = "issues";
          state.outputBookDialog = null;
          openTask(taskId);
        } else if (action === "outputs-toggle-toc") {
          state.outputBookTocCollapsed = !state.outputBookTocCollapsed;
          render();
        } else if (action === "outputs-select-chapter") {
          const chapterId = el.getAttribute("data-chapter-id") || "";
          if (!chapterId) return;
          void loadOutputChapter(chapterId);
        } else if (action === "outputs-open-editor") {
          const dialog = state.outputBookDialog;
          const chapterId = el.getAttribute("data-chapter-id") || dialog?.activeChapterId || "";
          const chapter = (dialog?.chapters || []).find((item) => item.id === chapterId);
          if (!dialog || !chapter) return;
          vscode.postMessage({
            type: "outputs.openChapter",
            path: chapter.path,
            rootPath: dialog.rootPath,
          });
        } else if (action === "project-wizard-close") {
          closeProjectCreateForm();
        } else if (action === "project-delete") {
          const projectId = el.getAttribute("data-project-id") || "";
          const projectName = el.getAttribute("data-project-name") || projectId;
          const issueCount = Number(el.getAttribute("data-issue-count") || 0);
          if (!projectId) return;
          void (async () => {
            try {
              const tip =
                issueCount > 0
                  ? `确定删除项目「${projectName}」？将同时删除其下 ${issueCount} 个议题。`
                  : `确定删除项目「${projectName}」？`;
              const confirmResult = await storeRequest(
                "ui.confirm",
                {
                  message: tip,
                  confirmLabel: "删除",
                  detail: "此操作不可撤销。",
                },
                { timeoutMs: 120000 },
              );
              if (!confirmResult?.confirmed) return;
              const result = await storeRequest("store.deleteProject", { projectId });
              if (Array.isArray(result.projects)) state.projects = result.projects;
              if (state.projectId === projectId) state.projectId = ALL_PROJECT_ID;
              render();
              vscode.postMessage({
                type: "toast",
                text:
                  result.deletedIssues > 0
                    ? `已删除项目，并清理 ${result.deletedIssues} 个议题`
                    : "已删除项目",
              });
              vscode.postMessage({ type: "store.getSnapshot" });
            } catch (error) {
              vscode.postMessage({
                type: "toast",
                text: error instanceof Error ? error.message : "删除项目失败",
              });
            }
          })();
        } else if (action === "project-add-git") {
          openProjectGitSelectDialog();
        } else if (action === "project-remove-git") {
          if (!state.projectWizard || state.projectWizard.busy) return;
          const index = Number(el.getAttribute("data-index"));
          if (!Number.isInteger(index)) return;
          const gitUrls = (state.projectWizard.gitUrls || []).filter((_, i) => i !== index);
          state.projectWizard = {
            ...state.projectWizard,
            gitUrls,
            gitUrl: gitUrls[0] || "",
            error: "",
          };
          render();
        } else if (action === "project-remove-folder") {
          if (!state.projectWizard || state.projectWizard.busy) return;
          const index = Number(el.getAttribute("data-index"));
          if (!Number.isInteger(index)) return;
          state.projectWizard = {
            ...state.projectWizard,
            folders: state.projectWizard.folders.filter((_, i) => i !== index),
          };
          render();
        } else if (action === "project-pick-folders") {
          if (!state.projectWizard || state.projectWizard.busy) return;
          void (async () => {
            try {
              const result = await storeRequest("project.pickFolders", {}, { timeoutMs: 120000 });
              if (result.cancelled || !Array.isArray(result.folders)) return;
              const next = [...new Set([...(state.projectWizard?.folders || []), ...result.folders])];
              if (!state.projectWizard) return;
              state.projectWizard = { ...state.projectWizard, folders: next, error: "" };
              render();
            } catch (error) {
              if (!state.projectWizard) return;
              state.projectWizard = {
                ...state.projectWizard,
                error: error instanceof Error ? error.message : "选择文件夹失败",
              };
              render();
            }
          })();
        } else if (action === "project-pick-clone-parent") {
          if (!state.projectWizard || state.projectWizard.busy) return;
          void (async () => {
            try {
              const result = await storeRequest("project.pickCloneDest", {}, { timeoutMs: 120000 });
              if (result.cancelled || !result.folder) return;
              if (!state.projectWizard) return;
              state.projectWizard = {
                ...state.projectWizard,
                cloneParent: String(result.folder),
                error: "",
              };
              render();
            } catch (error) {
              if (!state.projectWizard) return;
              state.projectWizard = {
                ...state.projectWizard,
                error: error instanceof Error ? error.message : "选择目录失败",
              };
              render();
            }
          })();
        } else if (action === "project-wizard-submit") {
          void persistCreateProject();
        } else if (action === "relation-add") {
          const type = el.getAttribute("data-relation-type");
          if (!type) return;
          if (state.relationPicker?.type === type) {
            state.relationPicker = null;
          } else {
            state.relationPicker = { type, query: "" };
          }
          render();
        } else if (action === "relation-pick") {
          const type = el.getAttribute("data-relation-type");
          const taskId = el.getAttribute("data-task-id");
          const targetId = el.getAttribute("data-target-id");
          if (!type || !taskId || !targetId) return;
          void persistAddRelation(taskId, type, targetId);
        } else if (action === "relation-remove") {
          const taskId = el.getAttribute("data-task-id");
          const relationId = el.getAttribute("data-relation-id");
          if (!taskId || !relationId) return;
          void persistRemoveRelation(taskId, relationId);
        } else if (action === "open-related-issue") {
          const taskId = el.getAttribute("data-task-id");
          if (!taskId) return;
          openTask(taskId);
        } else if (action === "devctx-create") {
          const taskId = el.getAttribute("data-task-id");
          if (taskId) void openWorktreeWizard(taskId);
        } else if (action === "git-select-open") {
          const taskId = el.getAttribute("data-task-id");
          if (taskId) openGitSelectDialog(taskId);
        } else if (action === "git-select-close") {
          if (!state.gitSelectDialog?.busy) closeGitSelectDialog();
        } else if (action === "git-select-fetch") {
          void fetchGitSelectBranches();
        } else if (action === "git-select-pick-parent") {
          if (!state.gitSelectDialog || state.gitSelectDialog.busy) return;
          void (async () => {
            try {
              const result = await storeRequest("project.pickCloneDest", {}, { timeoutMs: 120000 });
              if (result.cancelled || !result.folder) return;
              if (!state.gitSelectDialog) return;
              state.gitSelectDialog = {
                ...state.gitSelectDialog,
                cloneParent: String(result.folder),
                error: "",
              };
              render();
            } catch (error) {
              if (!state.gitSelectDialog) return;
              state.gitSelectDialog = {
                ...state.gitSelectDialog,
                error: error instanceof Error ? error.message : "选择目录失败",
              };
              render();
            }
          })();
        } else if (action === "git-select-clone") {
          void submitGitSelectClone();
        } else if (action === "git-commit-open") {
          const taskId = el.getAttribute("data-task-id");
          if (taskId) void openGitDialog(taskId);
        } else if (action === "git-commit-close") {
          if (!state.gitDialog?.busy) closeGitDialog();
        } else if (action === "git-commit-tab") {
          if (!state.gitDialog || state.gitDialog.busy) return;
          const index = Number(el.getAttribute("data-index"));
          if (!Number.isFinite(index)) return;
          state.gitDialog = { ...state.gitDialog, activeIndex: index, error: "" };
          render();
        } else if (action === "git-commit-refresh") {
          void refreshActiveGitRepo(async (current) => {
            const result = await storeRequest(
              "git.inspect",
              { paths: [current.folderPath] },
              { timeoutMs: 30000 },
            );
            return (result.repos && result.repos[0]) || current;
          });
        } else if (action === "git-commit-new-branch") {
          if (!state.gitDialog || state.gitDialog.busy) return;
          const repo = activeGitRepo();
          if (!repo?.isGit) return;
          state.gitDialog = {
            ...state.gitDialog,
            creatingBranch: true,
            error: "",
            newBranchName:
              String(state.gitDialog.newBranchName || "").trim() ||
              (repo.branch && !String(repo.branch).startsWith("detached@")
                ? `${repo.branch}-wip`
                : "feature/new-branch"),
          };
          render();
        } else if (action === "git-commit-cancel-new-branch") {
          if (!state.gitDialog || state.gitDialog.busy) return;
          state.gitDialog = { ...state.gitDialog, creatingBranch: false, error: "" };
          render();
        } else if (action === "git-commit-create-branch") {
          if (!state.gitDialog || state.gitDialog.busy) return;
          const repo = activeGitRepo();
          if (!repo?.isGit) return;
          const branch = String(state.gitDialog.newBranchName || "").trim();
          if (!branch) {
            state.gitDialog = { ...state.gitDialog, error: "请填写新分支名" };
            render();
            return;
          }
          void refreshActiveGitRepo(async (current) => {
            const result = await storeRequest(
              "git.createBranch",
              {
                path: current.folderPath,
                branch,
                from: current.branch && !String(current.branch).startsWith("detached@")
                  ? current.branch
                  : "",
              },
              { timeoutMs: 30000 },
            );
            if (state.gitDialog) {
              state.gitDialog.creatingBranch = false;
              state.gitDialog.newBranchName = branch;
            }
            vscode.postMessage({ type: "toast", text: `已创建并切换到 ${branch}` });
            return result.repo || current;
          });
        } else if (action === "git-commit-toggle-all") {
          if (!state.gitDialog || state.gitDialog.busy) return;
          const repo = activeGitRepo();
          if (!repo?.files?.length) return;
          const checked = Boolean(el.checked);
          const repos = [...state.gitDialog.repos];
          const index = state.gitDialog.activeIndex || 0;
          repos[index] = {
            ...repo,
            files: repo.files.map((file) => ({ ...file, selected: checked })),
          };
          state.gitDialog = { ...state.gitDialog, repos };
          render();
        } else if (action === "git-commit-toggle-file") {
          if (!state.gitDialog || state.gitDialog.busy) return;
          const repo = activeGitRepo();
          if (!repo?.files?.length) return;
          const fileIndex = Number(el.getAttribute("data-index"));
          if (!Number.isFinite(fileIndex) || !repo.files[fileIndex]) return;
          const repos = [...state.gitDialog.repos];
          const index = state.gitDialog.activeIndex || 0;
          const files = [...repo.files];
          files[fileIndex] = { ...files[fileIndex], selected: Boolean(el.checked) };
          repos[index] = { ...repo, files };
          state.gitDialog = { ...state.gitDialog, repos };
          render();
        } else if (action === "git-commit-submit" || action === "git-commit-push") {
          if (!state.gitDialog || state.gitDialog.busy) return;
          const repo = activeGitRepo();
          if (!repo?.isGit) return;
          const withPush = action === "git-commit-push";
          const files = (repo.files || []).filter((file) => file.selected).map((file) => file.path);
          const message = String(state.gitDialog.message || "").trim();
          state.gitDialog = {
            ...state.gitDialog,
            busy: true,
            busyMode: withPush ? "push" : "commit",
            error: "",
          };
          render();
          void (async () => {
            try {
              const result = await storeRequest(
                "git.commit",
                { path: repo.folderPath, files, message, push: withPush },
                { timeoutMs: withPush ? 120000 : 60000 },
              );
              if (!state.gitDialog) return;
              const repos = [...state.gitDialog.repos];
              const index = state.gitDialog.activeIndex || 0;
              if (result.repo) repos[index] = result.repo;
              state.gitDialog = {
                ...state.gitDialog,
                busy: false,
                busyMode: "",
                repos,
                message: "",
                error: "",
              };
              render();
              const hash = result.repo?.commitHash || "";
              const toast = withPush
                ? hash
                  ? `已提交 ${hash} 并推送到 ${result.repo?.pushTarget || "远端"}`
                  : "已提交并推送"
                : hash
                  ? `已提交 ${hash}`
                  : "提交成功";
              vscode.postMessage({ type: "toast", text: toast });
            } catch (error) {
              if (!state.gitDialog) return;
              state.gitDialog = {
                ...state.gitDialog,
                busy: false,
                busyMode: "",
                error: error instanceof Error ? error.message : withPush ? "提交/推送失败" : "提交失败",
              };
              render();
            }
          })();
        } else if (

          action === "devctx-bind" ||
          action === "devctx-pick" ||
          action === "devctx-open" ||
          action === "devctx-open-workspace" ||
          action === "devctx-unbind" ||
          action === "devctx-remove-path"
        ) {
          const map = {
            "devctx-bind": "bind",
            "devctx-pick": "pick",
            "devctx-open": "open",
            "devctx-open-workspace": "open-workspace",
            "devctx-unbind": "unbind",
            "devctx-remove-path": "remove-path",
          };
          vscode.postMessage({
            type: "devContext.action",
            taskId: el.getAttribute("data-task-id"),
            action: map[action],
            path: el.getAttribute("data-path") || "",
          });
        } else if (action === "wt-wizard-close") {
          closeWorktreeWizard();
        } else if (action === "wt-wizard-mode") {
          if (!state.worktreeWizard || state.worktreeWizard.busy) return;
          const nextMode = el.getAttribute("data-mode") === "create" ? "create" : "switch";
          state.worktreeWizard = { ...state.worktreeWizard, mode: nextMode, error: "" };
          render();
        } else if (action === "wt-wizard-switch") {
          if (!state.worktreeWizard || state.worktreeWizard.busy) return;
          const index = Number(el.getAttribute("data-index"));
          const treeIndex = Number(el.getAttribute("data-tree-index"));
          const repo = state.worktreeWizard.repos?.[index];
          const tree = repo?.worktrees?.[treeIndex];
          if (!repo || !tree || tree.isActive) return;
          const taskId = state.worktreeWizard.taskId;
          state.worktreeWizard = { ...state.worktreeWizard, busy: true, error: "" };
          render();
          void (async () => {
            try {
              await storeRequest(
                "devContext.action",
                {
                  taskId,
                  action: "switch",
                  items: [
                    {
                      gitRoot: repo.gitRoot,
                      path: tree.path,
                      branch: tree.branch && !tree.branch.startsWith("(") ? tree.branch : "",
                    },
                  ],
                },
                { timeoutMs: 60000 },
              );
              vscode.postMessage({ type: "store.getSnapshot" });
              await openWorktreeWizard(taskId, { mode: "switch" });
            } catch (error) {
              if (!state.worktreeWizard) return;
              state.worktreeWizard = {
                ...state.worktreeWizard,
                busy: false,
                error: error instanceof Error ? error.message : "切换失败",
              };
              render();
            }
          })();
        } else if (action === "wt-wizard-toggle-repo") {
          if (!state.worktreeWizard || state.worktreeWizard.busy) return;
          const index = Number(el.getAttribute("data-index"));
          if (!Number.isFinite(index) || !state.worktreeWizard.repos?.[index]) return;
          const enabled =
            el instanceof HTMLInputElement
              ? el.checked
              : !state.worktreeWizard.repos[index].enabled;
          const repos = state.worktreeWizard.repos.map((repo, i) =>
            i === index ? { ...repo, enabled } : repo,
          );
          state.worktreeWizard = { ...state.worktreeWizard, repos, error: "" };
          render();
        } else if (action === "wt-wizard-pick-folder") {
          if (!state.worktreeWizard || state.worktreeWizard.busy) return;
          const index = Number(el.getAttribute("data-index"));
          if (!Number.isFinite(index) || !state.worktreeWizard.repos?.[index]) return;
          void (async () => {
            try {
              const result = await storeRequest(
                "devContext.pickFolder",
                { defaultFolder: state.worktreeWizard.repos[index].parentFolder },
                { timeoutMs: 120000 },
              );
              if (result.cancelled || !result.path) return;
              if (!state.worktreeWizard?.repos?.[index]) return;
              const repos = state.worktreeWizard.repos.map((repo, i) =>
                i === index ? { ...repo, parentFolder: String(result.path) } : repo,
              );
              state.worktreeWizard = { ...state.worktreeWizard, repos, error: "" };
              render();
            } catch (error) {
              if (!state.worktreeWizard) return;
              state.worktreeWizard = {
                ...state.worktreeWizard,
                error: error instanceof Error ? error.message : "选择文件夹失败",
              };
              render();
            }
          })();
        } else if (action === "wt-wizard-select-branch") {
          if (!state.worktreeWizard) return;
          const index = Number(el.getAttribute("data-index"));
          const branch = el.getAttribute("data-branch") || "";
          if (!branch || !Number.isFinite(index) || !state.worktreeWizard.repos?.[index]) return;
          const repos = state.worktreeWizard.repos.map((repo, i) =>
            i === index ? { ...repo, selectedBranch: branch, branchQuery: branch } : repo,
          );
          state.worktreeWizard = { ...state.worktreeWizard, repos, error: "" };
          render();
        } else if (action === "wt-wizard-submit") {
          if (!state.worktreeWizard || state.worktreeWizard.busy) return;
          const { taskId, repos } = state.worktreeWizard;
          const items = (repos || [])
            .filter((repo) => repo.enabled && repo.selectedBranch && repo.parentFolder && repo.gitRoot)
            .map((repo) => ({
              gitRoot: repo.gitRoot,
              branch: String(repo.selectedBranch).trim(),
              path: repo.parentFolder,
              sourcePaths: repo.sourcePaths || [],
            }));
          if (!items.length) {
            state.worktreeWizard = {
              ...state.worktreeWizard,
              error: "请至少为一个 git 仓库选择分支",
            };
            render();
            return;
          }
          state.worktreeWizard = { ...state.worktreeWizard, busy: true, error: "" };
          render();
          void (async () => {
            try {
              await storeRequest(
                "devContext.action",
                {
                  taskId,
                  action: "create",
                  items,
                },
                { timeoutMs: 300000 },
              );
              state.worktreeWizard = null;
              render();
              vscode.postMessage({ type: "store.getSnapshot" });
            } catch (error) {
              if (!state.worktreeWizard) return;
              state.worktreeWizard = {
                ...state.worktreeWizard,
                busy: false,
                error: error instanceof Error ? error.message : "创建失败",
              };
              render();
            }
          })();
        } else if (action === "copy-id") {
          const text = el.getAttribute("data-copy") || "";
          void navigator.clipboard?.writeText(text);
          vscode.postMessage({ type: "toast", text: `${text} 已复制` });
        } else if (action === "copy-link") {
          const current = selectedTask();
          if (!current) return;
          const text = `issue://${state.projectId}/${current.identifier}`;
          void navigator.clipboard?.writeText(text);
          vscode.postMessage({ type: "toast", text: "议题链接已复制" });
        }
      });
    });

    function openTaskContextMenu(event, taskId) {
      if (!taskId) return;
      event.preventDefault();
      event.stopPropagation();
      state.priorityMenuTaskId = null;
      state.projectMenuOpen = false;
      state.contextMenu = {
        taskId,
        x: event.clientX,
        y: event.clientY,
        submenu: null,
      };
      render();
    }

    app.querySelectorAll(".task-card, .list-row").forEach((el) => {
      el.addEventListener("click", (event) => {
        if (event.target.closest("[data-action='toggle-priority-menu'], [data-action='toggle-subissues'], [data-action='open-related-issue'], .priority-menu, .issue-list-priority-control, .task-conversation-trigger, .card-subissue-list, [data-action='open-chat'], [data-action='open-thread']")) {
          return;
        }
        const taskId = el.getAttribute("data-task-id");
        openTask(taskId);
      });
      el.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openTask(el.getAttribute("data-task-id"));
        }
      });
      el.addEventListener("contextmenu", (event) => {
        openTaskContextMenu(event, el.getAttribute("data-task-id"));
      });
    });

    // 甘特图左侧议题名 / 时间条：右键打开与列表相同的议题操作菜单
    app.querySelectorAll(".gantt-label-cell, .gantt-bar, .gantt-track").forEach((el) => {
      el.addEventListener("contextmenu", (event) => {
        openTaskContextMenu(event, el.getAttribute("data-task-id"));
      });
    });

    app.querySelectorAll("[data-action='toggle-priority-menu']").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const taskId = btn.getAttribute("data-task-id");
        state.contextMenu = null;
        state.priorityMenuTaskId = state.priorityMenuTaskId === taskId ? null : taskId;
        render();
      });
    });

    const priorityMenu = app.querySelector(".priority-menu");
    if (priorityMenu && state.priorityMenuTaskId) {
      const trigger = app.querySelector(
        `[data-action='toggle-priority-menu'][data-task-id='${state.priorityMenuTaskId}']`,
      );
      if (trigger) {
        const rect = trigger.getBoundingClientRect();
        const menuWidth = priorityMenu.offsetWidth || 160;
        const menuHeight = priorityMenu.offsetHeight || 180;
        let left = rect.right - menuWidth;
        let top = rect.bottom + 4;
        left = Math.max(8, Math.min(left, window.innerWidth - menuWidth - 8));
        if (top + menuHeight > window.innerHeight - 8) {
          top = Math.max(8, rect.top - menuHeight - 4);
        }
        priorityMenu.style.left = `${left}px`;
        priorityMenu.style.top = `${top}px`;
      }
    }

    app.querySelectorAll("[data-action='set-priority']").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const taskId = btn.getAttribute("data-task-id");
        const priority = btn.getAttribute("data-priority");
        state.priorityMenuTaskId = null;
        if (taskId && priority) {
          void persistUpdate(taskId, { priority });
        } else {
          render();
        }
      });
    });

    const contextMenuEl = app.querySelector(".task-context-menu");
    if (contextMenuEl) {
      const menuState = state.contextMenu;
      const task = state.tasks.find((item) => item.id === menuState?.taskId);

      function placeContextMenu() {
        const submenuWidth = 200;
        const rect = contextMenuEl.getBoundingClientRect();
        let x = menuState.x;
        let y = menuState.y;
        // 预留子菜单宽度，优先保证右侧能展开
        const maxX = window.innerWidth - rect.width - submenuWidth - 12;
        const minX = 8;
        if (maxX >= minX) {
          x = Math.max(minX, Math.min(x, maxX));
        } else {
          // 视口太窄：贴右，子菜单改左侧或叠在下方
          x = Math.max(minX, window.innerWidth - rect.width - 8);
        }
        y = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
        contextMenuEl.style.left = `${x}px`;
        contextMenuEl.style.top = `${y}px`;

        const side = pickSubmenuSide(x, rect.width, submenuWidth);
        contextMenuEl.setAttribute("data-submenu-side", side);
        if (state.contextMenu && state.contextMenu.submenuSide !== side) {
          state.contextMenu.submenuSide = side;
        }

        // 子菜单纵向也钳在视口内
        contextMenuEl.querySelectorAll(".context-submenu").forEach((panel) => {
          clampContextSubmenuPanel(panel);
        });
      }

      requestAnimationFrame(placeContextMenu);
      bindContextMenuOutsideClose(contextMenuEl);

      contextMenuEl.addEventListener("contextmenu", (event) => event.preventDefault());

      // 停在已展开子菜单上时，取消切换/收起意图
      contextMenuEl.querySelectorAll(".context-submenu").forEach((panel) => {
        panel.addEventListener("pointerenter", () => {
          clearSubmenuIntent();
        });
      });

      contextMenuEl.querySelectorAll(".context-menu-item-anchor").forEach((anchor) => {
        const btn = anchor.querySelector(":scope > [data-submenu]");
        const name = btn?.getAttribute("data-submenu");
        if (!name || btn.getAttribute("data-menu-action")) return;

        anchor.addEventListener("pointerenter", () => {
          scheduleContextSubmenu(name, 80);
        });
        anchor.addEventListener("pointerleave", (event) => {
          // 进入同一锚点下的子菜单时不算离开
          if (anchor.contains(event.relatedTarget)) {
            clearSubmenuIntent();
            return;
          }
          clearSubmenuIntent();
        });
        btn.addEventListener("click", (event) => {
          event.stopPropagation();
          clearSubmenuIntent();
          setContextSubmenu(state.contextMenu?.submenu === name ? null : name);
        });
      });

      // 移到无二级菜单的项上时，延迟收起当前子菜单，避免斜穿误触立刻关掉
      contextMenuEl.querySelectorAll(":scope > .context-menu-group > .context-menu-item-anchor > .context-menu-item, :scope > .context-menu-group > .context-menu-item").forEach((btn) => {
        if (btn.getAttribute("data-submenu") && !btn.getAttribute("data-menu-action")) return;
        if (btn.closest(".context-submenu")) return;
        btn.addEventListener("pointerenter", () => {
          if (!state.contextMenu?.submenu) return;
          scheduleContextSubmenu(null, 180);
        });
      });

      contextMenuEl.querySelectorAll("[data-menu-action]").forEach((btn) => {
        btn.addEventListener("click", (event) => {
          event.stopPropagation();
          runContextMenuAction(
            task,
            btn.getAttribute("data-menu-action"),
            btn.getAttribute("data-menu-value") || "",
          );
        });
      });
    }

    if (state.priorityMenuTaskId) {
      document.addEventListener(
        "pointerdown",
        (event) => {
          if (!event.target.closest(".issue-list-priority-control")) {
            state.priorityMenuTaskId = null;
            render();
          }
        },
        { once: true },
      );
    }

    if (state.labelPicker) {
      const onLabelPickerOutside = (event) => {
        if (!(event.target instanceof Element)) return;
        if (event.target.closest(".detail-label-field")) return;
        document.removeEventListener("pointerdown", onLabelPickerOutside, true);
        state.labelPicker = null;
        render();
      };
      document.addEventListener("pointerdown", onLabelPickerOutside, true);

      // 用 pointerdown 选择，避免 input blur 抢在 click 前关掉面板
      app.querySelectorAll(".label-picker [data-action]").forEach((el) => {
        el.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          event.stopPropagation();
          el.click();
        });
      });
    }

    app.querySelectorAll(".task-card").forEach((card) => {
      card.addEventListener("dragstart", (event) => {
        if (event.target.closest(".card-subissue-list, [data-action='open-related-issue']")) {
          event.preventDefault();
          return;
        }
        state.dragTaskId = card.getAttribute("data-task-id");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", state.dragTaskId);
        card.classList.add("is-dragging");
      });
      card.addEventListener("dragend", () => {
        state.dragTaskId = null;
        render();
      });
    });

    app.querySelectorAll("[data-drop-status]").forEach((list) => {
      list.addEventListener("dragover", (event) => {
        event.preventDefault();
        list.parentElement.classList.add("is-drop-target");
      });
      list.addEventListener("dragleave", () => {
        list.parentElement.classList.remove("is-drop-target");
      });
      list.addEventListener("drop", (event) => {
        event.preventDefault();
        const taskId = event.dataTransfer.getData("text/plain") || state.dragTaskId;
        const status = list.getAttribute("data-drop-status");
        state.dragTaskId = null;
        if (taskId && status) {
          void persistUpdate(taskId, { status, processing: status === "in_progress" });
        } else {
          render();
        }
      });
    });

    if (task) bindIssueEditor(task);
    if (state.projectWizard) bindProjectWizardFields();
    if (state.view === "sync" || (state.view === "settings" && state.settingsSection === "sync")) {
      bindSyncSettingsFields();
    }

    document.addEventListener(
      "click",
      (event) => {
        if (!state.projectMenuOpen) return;
        const menu = app.querySelector(".header-project-menu");
        const button = app.querySelector("[data-action='toggle-project-menu']");
        if (
          menu
          && !menu.contains(event.target)
          && button
          && !button.contains(event.target)
        ) {
          state.projectMenuOpen = false;
          render();
        }
      },
      { once: true },
    );
  }

  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (state.gitSelectDialog) {
      if (state.gitSelectDialog.busy) return;
      closeGitSelectDialog();
      return;
    }
    if (state.gitDialog) {
      if (state.gitDialog.busy) return;
      closeGitDialog();
      return;
    }
    if (state.worktreeWizard) {
      if (state.worktreeWizard.busy) return;
      closeWorktreeWizard();
      return;
    }
    if (state.labelPicker) {
      state.labelPicker = null;
      render();
      return;
    }
    if (state.contextMenu || state.priorityMenuTaskId) {
      closeMenus();
      render();
      return;
    }
    if (!isSidebar && state.selectedTaskId && !state.editingDescription) {
      state.selectedTaskId = null;
      render();
    }
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message) return;

    if (message.type === "setLocale") {
      const locale = I18n.normalize(message.locale);
      if (locale !== state.locale) {
        state.locale = locale;
        document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
        document.body.setAttribute("data-locale", locale);
        render();
      }
      return;
    }

    if (message.type === "dataSnapshot") {
      if (message.locale === "zh" || message.locale === "en") {
        state.locale = message.locale;
        document.documentElement.lang = message.locale === "zh" ? "zh-CN" : "en";
        document.body.setAttribute("data-locale", message.locale);
      }
      const selected = state.selectedTaskId;
      const editing = state.editingDescription;
      applySnapshot(message);
      if (selected) state.selectedTaskId = selected;
      state.editingDescription = editing;
      tryApplyPendingOutputBook();
      render();
      return;
    }

    if (message.type === "storeResult") {
      const pending = pendingRequests.get(message.requestId);
      if (!pending) return;
      pendingRequests.delete(message.requestId);
      if (message.ok) pending.resolve(message);
      else pending.reject(new Error(message.error || "存储失败"));
      return;
    }

    if (message.type === "showIssue") {
      const nextId = message.taskId || message.task?.id || null;
      if (state.selectedTaskId !== nextId) state.activityShowCount = ACTIVITY_PREVIEW_COUNT;
      state.selectedTaskId = nextId;
      state.editingDescription = false;
      state.projectMenuOpen = false;
      vscode.postMessage({ type: "watchChatSync", taskId: nextId });
      render();
      return;
    }

    if (message.type === "showView") {
      state.view = message.view || "issues";
      if (state.view === "query" && !QUERY_STATUSES.includes(state.queryStatus)) {
        state.queryStatus = "backlog";
      }
      if (state.view !== "projects") state.projectWizard = null;
      if (state.view === "settings") {
        state.settingsSection = message.section || null;
      } else {
        state.settingsSection = null;
      }
      state.selectedTaskId = null;
      state.editingDescription = false;
      state.projectMenuOpen = false;
      if (state.view === "sync" || (state.view === "settings" && state.settingsSection === "sync")) {
        void loadSyncConfig();
      }
      if (state.view === "outputBook") {
        const taskId = String(message.taskId || "").trim();
        const bookId = String(message.bookId || "").trim();
        state.pendingOutputBookOpen = taskId && bookId ? { taskId, bookId, title: message.title } : null;
        if (!tryApplyPendingOutputBook()) {
          state.outputBookDialog = null;
        }
      } else {
        state.pendingOutputBookOpen = null;
        state.outputBookDialog = null;
      }
      render();
      // 编辑器面板标题随视图变化
      if (!isSidebar) {
        document.title =
          state.view === "query"
            ? "查询"
            : state.view === "projects"
              ? "项目管理"
              : state.view === "settings"
                ? t("settings.title")
                : state.view === "sync"
                  ? t("sync.title")
                  : state.view === "outputBook"
                    ? message.title || state.outputBookDialog?.title || t("outputs.title")
                    : "Taskboard";
      }
    }
  });

  function renderLoading() {
    app.innerHTML = `<div class="placeholder-view is-active">${escapeHtml(t("loading"))}</div>`;
  }

  renderLoading();
  vscode.postMessage({ type: "ready", surface });
})();
