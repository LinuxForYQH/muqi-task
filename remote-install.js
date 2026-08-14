"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20"];

/**
 * @param {string} [configPath]
 * @returns {string[]}
 */
function listSshHosts(configPath) {
  const file = configPath || path.join(os.homedir(), ".ssh", "config");
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const hosts = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*Host\s+(.+)$/i);
    if (!match) continue;
    for (const name of match[1].trim().split(/\s+/)) {
      if (!name || name.startsWith("!") || /[*?]/.test(name)) continue;
      hosts.push(name);
    }
  }
  return [...new Set(hosts)];
}

/**
 * @param {string} rootDir
 * @returns {string | null}
 */
function findLatestVsix(rootDir) {
  const dir = path.join(rootDir, "releases");
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".vsix"))
    .map((name) => {
      const full = path.join(dir, name);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.full || null;
}

function findCursorCli() {
  const candidates = [
    "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
    process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || "", "Programs", "cursor", "resources", "app", "bin", "cursor.cmd")
      : "",
    "cursor",
  ].filter(Boolean);
  for (const cmd of candidates) {
    if (cmd !== "cursor" && !fs.existsSync(cmd)) continue;
    const probe = spawnSync(cmd, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return cmd;
  }
  return null;
}

function failText(result, fallback) {
  const text = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
  return text || fallback;
}

/**
 * 安装到当前 Cursor（本机窗口）。
 * @param {string} vsixPath
 */
function installLocal(vsixPath) {
  const cli = findCursorCli();
  if (!cli) {
    throw new Error("找不到 Cursor CLI，请确认本机已安装 Cursor");
  }
  const result = spawnSync(cli, ["--install-extension", vsixPath, "--force"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(failText(result, "本机安装失败"));
  }
  return { ok: true, mode: "local", stdout: result.stdout || "" };
}

const REMOTE_BASH = `set -euo pipefail
VSIX="$1"
if [ ! -f "$VSIX" ]; then
  echo "missing vsix: $VSIX" >&2
  exit 1
fi
CLI=$(ls -dt "$HOME/.cursor-server/bin/"*/bin/remote-cli/cursor 2>/dev/null | head -1 || true)
if [ -z "$CLI" ]; then
  CLI=$(ls -dt "$HOME/.cursor-server/bin/"*/bin/remote-cli/code 2>/dev/null | head -1 || true)
fi
if [ -n "$CLI" ]; then
  "$CLI" --install-extension "$VSIX" --force
  echo "INSTALLED_CLI"
  exit 0
fi
if [ ! -d "$HOME/.cursor-server" ]; then
  echo "NO_CURSOR_SERVER" >&2
  exit 2
fi
python3 - "$VSIX" <<'PY'
import json, os, shutil, sys, tempfile, zipfile
vsix = sys.argv[1]
home = os.path.expanduser("~")
root = os.path.join(home, ".cursor-server", "extensions")
os.makedirs(root, exist_ok=True)
with tempfile.TemporaryDirectory() as td:
    with zipfile.ZipFile(vsix) as z:
        z.extractall(td)
    pkg_path = os.path.join(td, "extension", "package.json")
    with open(pkg_path, encoding="utf-8") as f:
        pkg = json.load(f)
    dest = os.path.join(root, "%s.%s-%s" % (pkg["publisher"], pkg["name"], pkg["version"]))
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    shutil.copytree(os.path.join(td, "extension"), dest)
    print("INSTALLED_EXTRACT", dest)
PY
`;

/**
 * 把本机 VSIX scp 到 SSH 主机，并装进远端 Cursor Server。
 * @param {{ host: string, vsixPath: string }} input
 */
function installRemote(input) {
  const host = String(input.host || "").trim();
  const vsixPath = String(input.vsixPath || "").trim();
  if (!host) throw new Error("缺少 SSH Host");
  if (!vsixPath || !fs.existsSync(vsixPath)) {
    throw new Error(`找不到 VSIX: ${vsixPath || "(empty)"}`);
  }
  const remoteTmp = `/tmp/${path.basename(vsixPath)}`;
  const scp = spawnSync(
    "scp",
    [...SSH_OPTS, vsixPath, `${host}:${remoteTmp}`],
    { encoding: "utf8" },
  );
  if (scp.status !== 0) {
    throw new Error(failText(scp, `scp 到 ${host} 失败（需要已配置免密 SSH）`));
  }
  const ssh = spawnSync(
    "ssh",
    [...SSH_OPTS, host, "bash", "-s", "--", remoteTmp],
    { encoding: "utf8", input: REMOTE_BASH },
  );
  const combined = `${ssh.stdout || ""}\n${ssh.stderr || ""}`;
  if (ssh.status !== 0) {
    if (/NO_CURSOR_SERVER/.test(combined)) {
      throw new Error(`主机 ${host} 还没有 Cursor Server，请先用 Cursor 连上该 SSH 一次`);
    }
    throw new Error(failText(ssh, `远程安装失败 (${host})`));
  }
  const mode = /INSTALLED_EXTRACT/.test(combined) ? "extract" : "cli";
  return { ok: true, mode, host, stdout: ssh.stdout || "" };
}

module.exports = {
  listSshHosts,
  findLatestVsix,
  findCursorCli,
  installLocal,
  installRemote,
};
