const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
  });
  return String(stdout || "").trim();
}

/**
 * @param {string | undefined} startDir
 * @returns {Promise<string | null>}
 */
async function findGitRoot(startDir) {
  if (!startDir) return null;
  let dir = path.resolve(startDir);
  for (let i = 0; i < 40; i += 1) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    const root = await git(startDir, ["rev-parse", "--show-toplevel"]);
    return root || null;
  } catch {
    return null;
  }
}

/**
 * 主仓库根目录（worktree 目录也会归到同一主仓库）。
 * @param {string | undefined} startDir
 * @returns {Promise<string | null>}
 */
async function findRepoRoot(startDir) {
  const toplevel = await findGitRoot(startDir);
  if (!toplevel) return null;
  try {
    const common = await git(toplevel, ["rev-parse", "--git-common-dir"]);
    const absCommon = path.resolve(toplevel, common);
    if (path.basename(absCommon) === ".git") {
      return path.dirname(absCommon);
    }
    return toplevel;
  } catch {
    return toplevel;
  }
}

/**
 * @param {{ identifier?: string, title?: string, gitBranch?: string | null }} issue
 */
function suggestBranchName(issue) {
  const existing = String(issue?.gitBranch || "").trim();
  if (existing) return existing;
  const id = String(issue?.identifier || "task").trim();
  return id ? `issue/${id}` : "issue/task";
}

/**
 * @param {string} branch
 */
function worktreeFolderName(branch) {
  return String(branch || "task")
    .trim()
    .replace(/[\\/]+/g, "-")
    .replace(/[^\w.\-@]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "task";
}

/**
 * @param {string} gitRoot
 * @param {string} branch
 */
function suggestWorktreePath(gitRoot, branch) {
  return path.join(gitRoot, ".cursor", "worktrees", worktreeFolderName(branch));
}

/**
 * @param {string} gitRoot
 * @returns {Promise<Array<{ path: string, branch: string, bare: boolean, detached: boolean }>>}
 */
async function listWorktrees(gitRoot) {
  const out = await git(gitRoot, ["worktree", "list", "--porcelain"]);
  if (!out) return [];
  /** @type {Array<{ path: string, branch: string, bare: boolean, detached: boolean }>} */
  const items = [];
  /** @type {{ path?: string, branch?: string, bare?: boolean, detached?: boolean }} */
  let current = {};
  for (const line of out.split("\n")) {
    if (!line) {
      if (current.path) {
        items.push({
          path: current.path,
          branch: current.branch || "",
          bare: Boolean(current.bare),
          detached: Boolean(current.detached),
        });
      }
      current = {};
      continue;
    }
    if (line.startsWith("worktree ")) current.path = line.slice("worktree ".length);
    else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      current.branch = ref.replace(/^refs\/heads\//, "");
    } else if (line === "bare") current.bare = true;
    else if (line === "detached") current.detached = true;
  }
  if (current.path) {
    items.push({
      path: current.path,
      branch: current.branch || "",
      bare: Boolean(current.bare),
      detached: Boolean(current.detached),
    });
  }
  return items;
}

/**
 * @param {string} gitRoot
 * @param {string} branch
 */
async function branchExists(gitRoot, branch) {
  try {
    await git(gitRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} gitRoot
 * @returns {Promise<string[]>}
 */
async function listLocalBranches(gitRoot) {
  try {
    const out = await git(gitRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    if (!out) return [];
    return [...new Set(out.split("\n").map((line) => line.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

/**
 * @param {string} gitRoot
 * @returns {Promise<string>}
 */
async function currentBranch(gitRoot) {
  try {
    const name = await git(gitRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!name || name === "HEAD") return "";
    return name;
  } catch {
    return "";
  }
}

/**
 * Create (or attach) a worktree for the branch under .cursor/worktrees/.
 * @param {string} gitRoot
 * @param {string} branch
 * @param {{ path?: string, baseRef?: string }} [options]
 */
async function createWorktree(gitRoot, branch, options = {}) {
  const name = String(branch || "").trim();
  if (!name) throw new Error("分支名不能为空");

  const target = path.resolve(options.path || suggestWorktreePath(gitRoot, name));
  if (fs.existsSync(target)) {
    // Already a directory — if it's an existing worktree for this branch, reuse it.
    const existing = (await listWorktrees(gitRoot)).find((item) => path.resolve(item.path) === target);
    if (existing) {
      return { path: target, branch: existing.branch || name, reused: true };
    }
    throw new Error(`路径已存在且不是该仓库的 worktree: ${target}`);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });

  const exists = await branchExists(gitRoot, name);
  if (exists) {
    await git(gitRoot, ["worktree", "add", target, name]);
  } else {
    const base = String(options.baseRef || "HEAD").trim() || "HEAD";
    await git(gitRoot, ["worktree", "add", "-b", name, target, base]);
  }

  return { path: target, branch: name, reused: false };
}

/**
 * @param {string} worktreePath
 */
function shortWorktreeLabel(worktreePath, gitRoot) {
  const abs = path.resolve(worktreePath);
  const root = gitRoot ? path.resolve(gitRoot) : "";
  if (root && abs.startsWith(root + path.sep)) {
    return path.relative(root, abs);
  }
  return abs;
}

/**
 * worktree_path 支持单路径，或换行/JSON 数组多路径（兼容旧数据）。
 * @param {string | null | undefined} value
 * @returns {string[]}
 */
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

/**
 * @param {string[] | string | null | undefined} paths
 * @returns {string | null}
 */
function serializeWorktreePaths(paths) {
  const list = Array.isArray(paths)
    ? paths
    : parseWorktreePaths(paths);
  const uniq = [...new Set(list.map((item) => String(item || "").trim()).filter(Boolean))];
  if (!uniq.length) return null;
  return uniq.join("\n");
}

/**
 * @param {string} url
 * @returns {Promise<string[]>}
 */
async function listRemoteBranches(url) {
  const remote = String(url || "").trim();
  if (!remote) throw new Error("缺少 git 地址");
  const { stdout } = await execFileAsync("git", ["ls-remote", "--heads", remote], {
    maxBuffer: 8 * 1024 * 1024,
  });
  /** @type {string[]} */
  const branches = [];
  for (const line of String(stdout || "").split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const ref = line.slice(tab + 1).trim();
    if (!ref.startsWith("refs/heads/")) continue;
    const name = ref.slice("refs/heads/".length).trim();
    if (name) branches.push(name);
  }
  return [...new Set(branches)].sort((a, b) => a.localeCompare(b));
}

/**
 * @param {string} url
 * @param {string} dest
 * @param {{ branch?: string }} [options]
 * @returns {Promise<string>}
 */
async function cloneRepo(url, dest, options = {}) {
  const remote = String(url || "").trim();
  const target = String(dest || "").trim();
  const branch = String(options.branch || "").trim();
  if (!remote) throw new Error("缺少 git 地址");
  if (!target) throw new Error("缺少克隆目标目录");
  if (fs.existsSync(target)) {
    const entries = fs.readdirSync(target);
    if (entries.length) throw new Error(`目标目录非空: ${target}`);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  /** @type {string[]} */
  const args = ["clone"];
  if (branch) {
    args.push("--branch", branch, "--single-branch");
  }
  args.push(remote, target);
  await execFileAsync("git", args, {
    maxBuffer: 16 * 1024 * 1024,
  });
  return target;
}

module.exports = {
  findGitRoot,
  findRepoRoot,
  suggestBranchName,
  suggestWorktreePath,
  listWorktrees,
  listLocalBranches,
  listRemoteBranches,
  currentBranch,
  createWorktree,
  cloneRepo,
  shortWorktreeLabel,
  worktreeFolderName,
  parseWorktreePaths,
  serializeWorktreePaths,
};
