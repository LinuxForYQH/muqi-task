const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { findGitRoot, listLocalBranches } = require("./git-worktree");

const execFileAsync = promisify(execFile);

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function runGitRaw(cwd, args) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout: String(stdout || ""), stderr: String(stderr || "") };
  } catch (error) {
    const err = /** @type {Error & { stdout?: string, stderr?: string }} */ (error);
    const detail = String(err.stderr || err.stdout || err.message || "git 命令失败").trim();
    throw new Error(detail);
  }
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
async function runGit(cwd, args) {
  const { stdout } = await runGitRaw(cwd, args);
  return stdout.trim();
}

/**
 * @param {string} code
 */
function statusLabel(code) {
  const xy = String(code || "  ");
  if (xy === "??") return "未跟踪";
  if (xy.includes("U") || xy === "AA" || xy === "DD") return "冲突";
  if (xy[0] === "A" || xy[1] === "A") return "新增";
  if (xy[0] === "D" || xy[1] === "D") return "删除";
  if (xy[0] === "R" || xy[1] === "R") return "重命名";
  if (xy[0] === "M" || xy[1] === "M") return "修改";
  if (xy[0] === "C" || xy[1] === "C") return "复制";
  return xy.trim() || "变更";
}

/**
 * Decode git C-style quoted path: "foo\\345\\220\\210.docx"
 * @param {string} value
 */
function decodeGitPath(value) {
  let filePath = String(value || "");
  if (filePath.startsWith('"') && filePath.endsWith('"')) {
    try {
      // git uses C-style octal escapes; approximate via JSON after normalizing
      const normalized = filePath
        .replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
        .replace(/\\([abfnrtv\\"])/g, (_, ch) => {
          const map = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", '"': '"' };
          return map[ch] || ch;
        });
      filePath = normalized.slice(1, -1);
    } catch {
      filePath = filePath.slice(1, -1);
    }
  }
  return filePath;
}

/**
 * @param {string} line
 * @returns {{ code: string, path: string, oldPath?: string } | null}
 */
function parsePorcelainLine(line) {
  if (!line || line.length < 3) return null;
  // XY + space + path；不要对整段 status 做 trim，否则首行前导空格丢失会把 ".DS_Store" 解析成 "DS_Store"
  if (line.length < 4 || line[2] !== " ") return null;
  const code = line.slice(0, 2);
  const rest = line.slice(3);
  if (code.includes("R") || code.includes("C")) {
    const parts = rest.split(" -> ");
    if (parts.length === 2) {
      return { code, path: decodeGitPath(parts[1]), oldPath: decodeGitPath(parts[0]) };
    }
  }
  return { code, path: decodeGitPath(rest) };
}

/**
 * Parse `git status --porcelain=v1 -z` (NUL separated; rename = new\\0old\\0).
 * @param {string} porcelain
 * @returns {Array<{ code: string, path: string, oldPath?: string }>}
 */
function parsePorcelainZ(porcelain) {
  const raw = String(porcelain || "");
  if (!raw) return [];
  const parts = raw.split("\0");
  /** @type {Array<{ code: string, path: string, oldPath?: string }>} */
  const items = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (!entry) continue;
    if (entry.length < 4 || entry[2] !== " ") continue;
    const code = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (code.includes("R") || code.includes("C")) {
      const oldPath = parts[i + 1] || "";
      i += 1;
      items.push({ code, path: filePath, oldPath });
    } else {
      items.push({ code, path: filePath });
    }
  }
  return items;
}

/**
 * @param {string} folderPath
 */
async function inspectRepo(folderPath) {
  const folder = path.resolve(String(folderPath || "").trim());
  if (!folder || !fs.existsSync(folder)) {
    return {
      folderPath: folder,
      isGit: false,
      error: "文件夹不存在",
      gitRoot: "",
      branch: "",
      branches: [],
      files: [],
    };
  }
  const gitRoot = await findGitRoot(folder);
  if (!gitRoot) {
    return {
      folderPath: folder,
      isGit: false,
      error: "不是 Git 仓库",
      gitRoot: "",
      branch: "",
      branches: [],
      files: [],
    };
  }

  let branch = "";
  try {
    branch = await runGit(gitRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch === "HEAD") {
      const short = await runGit(gitRoot, ["rev-parse", "--short", "HEAD"]);
      branch = `detached@${short}`;
    }
  } catch {
    branch = "";
  }

  const branches = await listLocalBranches(gitRoot);
  let porcelain = "";
  try {
    // 不要 trimStart：首行可能以空格开头（未暂存修改）；改用 -z 更稳妥
    const { stdout } = await runGitRaw(gitRoot, ["status", "--porcelain=v1", "-z", "-uall"]);
    porcelain = stdout;
  } catch (error) {
    return {
      folderPath: folder,
      isGit: true,
      error: error instanceof Error ? error.message : String(error),
      gitRoot,
      branch,
      branches,
      files: [],
    };
  }

  const relPrefix = path.relative(gitRoot, folder).split(path.sep).join("/");
  const underFolder = (filePath) => {
    if (!relPrefix || relPrefix === ".") return true;
    const normalized = String(filePath || "").split(path.sep).join("/");
    return normalized === relPrefix || normalized.startsWith(`${relPrefix}/`);
  };

  const parsed = porcelain.includes("\0")
    ? parsePorcelainZ(porcelain)
    : porcelain
        .replace(/\r\n/g, "\n")
        .replace(/\s+$/, "")
        .split("\n")
        .map((line) => parsePorcelainLine(line))
        .filter(Boolean);

  const files = parsed
    .filter((item) => underFolder(item.path) || (item.oldPath && underFolder(item.oldPath)))
    .map((item) => ({
      path: item.path,
      oldPath: item.oldPath || "",
      code: item.code,
      label: statusLabel(item.code),
      selected: true,
    }));

  return {
    folderPath: folder,
    isGit: true,
    error: "",
    gitRoot,
    branch,
    branches,
    files,
  };
}

/**
 * @param {string[]} folderPaths
 */
async function inspectRepos(folderPaths) {
  const list = Array.isArray(folderPaths) ? folderPaths : [];
  const repos = [];
  for (const folder of list) {
    // eslint-disable-next-line no-await-in-loop
    repos.push(await inspectRepo(folder));
  }
  return repos;
}

/**
 * @param {string} name
 */
function assertValidBranchName(name) {
  const branch = String(name || "").trim();
  if (!branch) throw new Error("分支名不能为空");
  if (branch.startsWith("detached@")) throw new Error("无效分支名");
  if (
    /[\s~^:?*\[\\]/.test(branch) ||
    branch.includes("..") ||
    branch.startsWith("-") ||
    branch.endsWith(".") ||
    branch.endsWith("/") ||
    branch.includes("//")
  ) {
    throw new Error("分支名包含非法字符");
  }
  return branch;
}

/**
 * @param {string} folderPath
 * @param {string} branch
 */
async function checkoutBranch(folderPath, branch) {
  const name = assertValidBranchName(branch);
  const gitRoot = await findGitRoot(folderPath);
  if (!gitRoot) throw new Error("不是 Git 仓库");
  await runGit(gitRoot, ["checkout", name]);
  return inspectRepo(folderPath);
}

/**
 * 新建并切换到分支；若同名分支已存在则直接 checkout。
 * @param {string} folderPath
 * @param {string} branch
 * @param {{ from?: string }} [options]
 */
async function createAndCheckoutBranch(folderPath, branch, options = {}) {
  const name = assertValidBranchName(branch);
  const gitRoot = await findGitRoot(folderPath);
  if (!gitRoot) throw new Error("不是 Git 仓库");
  const branches = await listLocalBranches(gitRoot);
  if (branches.includes(name)) {
    await runGit(gitRoot, ["checkout", name]);
  } else {
    const from = String(options.from || "").trim();
    if (from && !from.startsWith("detached@")) {
      await runGit(gitRoot, ["checkout", "-b", name, from]);
    } else {
      await runGit(gitRoot, ["checkout", "-b", name]);
    }
  }
  return inspectRepo(folderPath);
}

/**
 * Push current branch to its upstream, or set upstream to origin/<branch>.
 * @param {string} folderPath
 * @param {{ branch?: string }} [options]
 */
async function pushBranch(folderPath, options = {}) {
  const gitRoot = await findGitRoot(folderPath);
  if (!gitRoot) throw new Error("不是 Git 仓库");

  let branch = String(options.branch || "").trim();
  if (!branch || branch.startsWith("detached@")) {
    branch = await runGit(gitRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  }
  if (!branch || branch === "HEAD") {
    throw new Error("当前处于 detached HEAD，无法推送");
  }

  let upstream = "";
  try {
    upstream = await runGit(gitRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  } catch {
    upstream = "";
  }

  if (upstream) {
    await runGitRaw(gitRoot, ["push"]);
  } else {
    // 新分支：推到 origin 并建立 upstream
    await runGitRaw(gitRoot, ["push", "-u", "origin", branch]);
  }

  return { branch, upstream: upstream || `origin/${branch}` };
}

/**
 * @param {string} folderPath
 * @param {{ files: string[], message: string, push?: boolean }} options
 */
async function commitSelected(folderPath, options = {}) {
  const message = String(options.message || "").trim();
  if (!message) throw new Error("请填写提交说明");
  const files = Array.isArray(options.files)
    ? [...new Set(options.files.map((item) => String(item || "").trim()).filter(Boolean))]
    : [];
  if (!files.length) throw new Error("请至少勾选一个文件");

  const gitRoot = await findGitRoot(folderPath);
  if (!gitRoot) throw new Error("不是 Git 仓库");

  await runGitRaw(gitRoot, ["add", "--", ...files]);
  await runGitRaw(gitRoot, ["commit", "-m", message]);

  let hash = "";
  try {
    hash = await runGit(gitRoot, ["rev-parse", "--short", "HEAD"]);
  } catch {
    hash = "";
  }

  let pushed = false;
  let pushTarget = "";
  if (options.push) {
    const pushResult = await pushBranch(folderPath);
    pushed = true;
    pushTarget = pushResult.upstream || "";
  }

  const repo = await inspectRepo(folderPath);
  return {
    ...repo,
    commitHash: hash,
    commitMessage: message,
    pushed,
    pushTarget,
  };
}

module.exports = {
  inspectRepo,
  inspectRepos,
  checkoutBranch,
  createAndCheckoutBranch,
  commitSelected,
  pushBranch,
  statusLabel,
};
