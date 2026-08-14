"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const HOME_DIR = path.join(os.homedir(), ".cursor-taskboard");
const CONFIG_PATH = path.join(HOME_DIR, "config.json");
const DEFAULT_REPO_DIR = path.join(HOME_DIR, "sync-repo");
const DB_FILE_NAME = "taskboard.db";

/**
 * @returns {Record<string, any>}
 */
function readRawConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) || {};
  } catch {
    return {};
  }
}

/**
 * @param {Record<string, any>} patch
 */
function writeRawConfig(patch) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const next = { ...readRawConfig(), ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * @param {unknown} input
 */
function normalizeSyncConfig(input) {
  const raw = input && typeof input === "object" ? input : {};
  const mode = String(raw.mode || "local") === "git" ? "git" : "local";
  const scheduleHour = Math.min(23, Math.max(0, Number(raw.scheduleHour ?? 3) || 0));
  return {
    mode,
    gitUrl: String(raw.gitUrl || "").trim(),
    branch: String(raw.branch || "main").trim() || "main",
    localRepoPath: String(raw.localRepoPath || DEFAULT_REPO_DIR).trim() || DEFAULT_REPO_DIR,
    scheduleEnabled: Boolean(raw.scheduleEnabled) && mode === "git",
    scheduleHour,
    lastSyncAt: raw.lastSyncAt ? String(raw.lastSyncAt) : null,
    lastSyncDirection: raw.lastSyncDirection ? String(raw.lastSyncDirection) : null,
    lastSyncError: raw.lastSyncError ? String(raw.lastSyncError) : null,
    lastPushAt: raw.lastPushAt ? String(raw.lastPushAt) : null,
  };
}

function getSyncConfig() {
  return normalizeSyncConfig(readRawConfig().sync);
}

/**
 * @param {Partial<ReturnType<typeof normalizeSyncConfig>>} patch
 */
function saveSyncConfig(patch = {}) {
  const prev = getSyncConfig();
  const next = normalizeSyncConfig({ ...prev, ...patch });
  writeRawConfig({ sync: next });
  return next;
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
async function git(cwd, args) {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    stdout: String(stdout || "").trim(),
    stderr: String(stderr || "").trim(),
  };
}

/**
 * @param {string} repoPath
 */
function isGitRepo(repoPath) {
  return fs.existsSync(path.join(repoPath, ".git"));
}

/**
 * @param {ReturnType<typeof getSyncConfig>} sync
 */
async function ensureSyncRepo(sync) {
  if (sync.mode !== "git") {
    throw new Error("当前为本地模式，请先切换到 Git 备份并填写仓库地址");
  }
  const gitUrl = String(sync.gitUrl || "").trim();
  if (!gitUrl) throw new Error("请先填写 Git 仓库地址");

  const repoPath = path.resolve(sync.localRepoPath || DEFAULT_REPO_DIR);
  fs.mkdirSync(path.dirname(repoPath), { recursive: true });

  if (!isGitRepo(repoPath)) {
    if (fs.existsSync(repoPath) && fs.readdirSync(repoPath).length) {
      throw new Error(`同步目录非空且不是 git 仓库: ${repoPath}`);
    }
    fs.mkdirSync(repoPath, { recursive: true });
    try {
      await git(path.dirname(repoPath), ["clone", gitUrl, repoPath]);
    } catch {
      // 远程可能尚为空仓库：本地 init 后设置 remote
      await git(repoPath, ["init"]);
      await git(repoPath, ["checkout", "-B", sync.branch]);
      try {
        await git(repoPath, ["remote", "remove", "origin"]);
      } catch {
        // ignore
      }
      await git(repoPath, ["remote", "add", "origin", gitUrl]);
    }
  } else {
    try {
      await git(repoPath, ["remote", "set-url", "origin", gitUrl]);
    } catch {
      await git(repoPath, ["remote", "add", "origin", gitUrl]);
    }
  }

  try {
    await git(repoPath, ["checkout", "-B", sync.branch]);
  } catch {
    // keep current branch
  }

  return repoPath;
}

/**
 * @param {string} dbPath
 */
function assertSqliteFile(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) {
    throw new Error(`本地数据库不存在: ${dbPath || "(empty)"}`);
  }
  const fd = fs.openSync(dbPath, "r");
  const buf = Buffer.alloc(16);
  fs.readSync(fd, buf, 0, 16, 0);
  fs.closeSync(fd);
  if (!buf.toString("utf8").startsWith("SQLite format 3")) {
    throw new Error("目标文件不是有效的 SQLite 数据库");
  }
}

/**
 * @param {string} src
 * @param {string} dest
 */
function copyFileAtomic(src, dest) {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(dest)}.${process.pid}.tmp`);
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dest);
}

/**
 * @param {string} dbPath
 * @param {string} reason
 */
function backupLocalDb(dbPath, reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${dbPath}.bak-${reason}-${stamp}`;
  copyFileAtomic(dbPath, backup);
  return backup;
}

/**
 * @param {{ persist: () => void, dbPath: string }} store
 * @param {{ message?: string }} [options]
 */
async function pushDbToGit(store, options = {}) {
  const sync = getSyncConfig();
  const repoPath = await ensureSyncRepo(sync);
  store.persist();
  assertSqliteFile(store.dbPath);

  const destDb = path.join(repoPath, DB_FILE_NAME);
  copyFileAtomic(store.dbPath, destDb);

  await git(repoPath, ["add", DB_FILE_NAME]);
  const status = await git(repoPath, ["status", "--porcelain"]);
  if (!status.stdout) {
    const now = new Date().toISOString();
    const next = saveSyncConfig({
      lastSyncAt: now,
      lastPushAt: now,
      lastSyncDirection: "push",
      lastSyncError: null,
    });
    return { ok: true, skipped: true, message: "没有变更，无需提交", sync: next };
  }

  const message =
    String(options.message || "").trim() ||
    `taskboard backup ${new Date().toISOString().slice(0, 10)}`;
  await git(repoPath, ["commit", "-m", message]);
  try {
    await git(repoPath, ["push", "-u", "origin", sync.branch]);
  } catch (error) {
    // 首次空仓库可能需要 set upstream；再试一次 force-with-lease 太危险，直接抛出
    const text = error instanceof Error ? error.message : String(error);
    const next = saveSyncConfig({
      lastSyncError: text,
      lastSyncDirection: "push",
    });
    throw Object.assign(new Error(`推送到 Git 失败: ${text}`), { sync: next });
  }

  const now = new Date().toISOString();
  const next = saveSyncConfig({
    lastSyncAt: now,
    lastPushAt: now,
    lastSyncDirection: "push",
    lastSyncError: null,
  });
  return { ok: true, skipped: false, message: "已提交并推送到 Git", sync: next, repoPath };
}

/**
 * Pull remote DB and replace local (with backup). Binary SQLite cannot text-merge;
 * "merge" uses last-write-wins by remote mtime after fetch, keeping a local backup.
 * @param {{ persist: () => void, reloadFromDisk: () => boolean, dbPath: string }} store
 * @param {{ direction?: "pull" | "merge" }} [options]
 */
async function pullDbFromGit(store, options = {}) {
  const direction = options.direction === "merge" ? "merge" : "pull";
  const sync = getSyncConfig();
  const repoPath = await ensureSyncRepo(sync);

  try {
    await git(repoPath, ["fetch", "origin", sync.branch]);
    await git(repoPath, ["checkout", sync.branch]);
    try {
      await git(repoPath, ["pull", "--ff-only", "origin", sync.branch]);
    } catch {
      // 允许非快进：保留本地备份后 reset 到远端（合并语义 = 远端优先 + 本地备份）
      await git(repoPath, ["reset", "--hard", `origin/${sync.branch}`]);
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    // 远端尚无提交时允许继续（可能只有本地）
    if (!/couldn't find remote ref|does not exist|unknown revision/i.test(text)) {
      const next = saveSyncConfig({ lastSyncError: text, lastSyncDirection: direction });
      throw Object.assign(new Error(`从 Git 拉取失败: ${text}`), { sync: next });
    }
  }

  const remoteDb = path.join(repoPath, DB_FILE_NAME);
  if (!fs.existsSync(remoteDb)) {
    throw new Error("远程仓库中还没有 taskboard.db，请先执行「同步到 Git」");
  }
  assertSqliteFile(remoteDb);

  store.persist();
  const backup = backupLocalDb(store.dbPath, direction);
  copyFileAtomic(remoteDb, store.dbPath);
  if (!store.reloadFromDisk()) {
    // 回滚
    copyFileAtomic(backup, store.dbPath);
    store.reloadFromDisk();
    throw new Error("加载远程数据库失败，已回滚本地备份");
  }

  const now = new Date().toISOString();
  const next = saveSyncConfig({
    lastSyncAt: now,
    lastSyncDirection: direction,
    lastSyncError: null,
  });
  return {
    ok: true,
    message:
      direction === "merge"
        ? `已从 Git 合并到本地（远端优先），原库备份：${path.basename(backup)}`
        : `已从 Git 同步到本地，原库备份：${path.basename(backup)}`,
    sync: next,
    backup,
  };
}

/**
 * @param {ReturnType<typeof getSyncConfig>} sync
 */
function shouldRunDailyPush(sync) {
  if (!sync.scheduleEnabled || sync.mode !== "git" || !sync.gitUrl) return false;
  const now = new Date();
  if (now.getHours() < Number(sync.scheduleHour || 0)) return false;
  if (!sync.lastPushAt) return true;
  const last = new Date(sync.lastPushAt);
  if (Number.isNaN(last.getTime())) return true;
  const sameDay =
    last.getFullYear() === now.getFullYear() &&
    last.getMonth() === now.getMonth() &&
    last.getDate() === now.getDate();
  return !sameDay;
}

/**
 * @param {{ persist: () => void, dbPath: string }} store
 */
async function maybeDailyPush(store) {
  const sync = getSyncConfig();
  if (!shouldRunDailyPush(sync)) {
    return { ran: false, sync };
  }
  try {
    const result = await pushDbToGit(store, {
      message: `taskboard daily backup ${new Date().toISOString().slice(0, 10)}`,
    });
    return { ran: true, ...result };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const next = saveSyncConfig({ lastSyncError: text, lastSyncDirection: "push" });
    return { ran: true, ok: false, error: text, sync: next };
  }
}

module.exports = {
  CONFIG_PATH,
  DEFAULT_REPO_DIR,
  DB_FILE_NAME,
  getSyncConfig,
  saveSyncConfig,
  normalizeSyncConfig,
  pushDbToGit,
  pullDbFromGit,
  maybeDailyPush,
  shouldRunDailyPush,
};
