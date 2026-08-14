"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

/**
 * Read an image from the OS clipboard (extension host — not webview).
 * Webview paste events often omit image/*; host-side read is the reliable path.
 *
 * @returns {Promise<null | { mime: string, name: string, dataBase64: string }>}
 */
async function readClipboardImage() {
  const platform = process.platform;
  if (platform === "darwin") return readClipboardImageMac();
  if (platform === "win32") return readClipboardImageWindows();
  if (platform === "linux") return readClipboardImageLinux();
  return null;
}

/**
 * @param {string} filePath
 * @param {string} mime
 * @param {string} name
 */
function fileToPayload(filePath, mime, name) {
  if (!fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore cleanup errors
  }
  if (!buf.length) return null;
  return {
    mime,
    name,
    dataBase64: `data:${mime};base64,${buf.toString("base64")}`,
  };
}

function tempImagePath(ext) {
  return path.join(os.tmpdir(), `cursor-taskboard-clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
}

async function readClipboardImageMac() {
  const outPath = tempImagePath("png");
  const script = `
try
  set png_data to the clipboard as «class PNGf»
  set out to open for access (POSIX file "${outPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}") with write permission
  set eof out to 0
  write png_data to out
  close access out
  return "ok"
on error
  try
    close access (POSIX file "${outPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")
  end try
  return "empty"
end try
`;
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 4000 });
    if (!String(stdout || "").includes("ok")) return null;
    return fileToPayload(outPath, "image/png", "screenshot.png");
  } catch {
    try {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch {
      // ignore
    }
    return null;
  }
}

async function readClipboardImageWindows() {
  const outPath = tempImagePath("png");
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $img) { exit 2 }
$img.Save('${outPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$img.Dispose()
`;
  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { timeout: 5000 },
    );
    return fileToPayload(outPath, "image/png", "screenshot.png");
  } catch {
    try {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch {
      // ignore
    }
    return null;
  }
}

async function readClipboardImageLinux() {
  const outPath = tempImagePath("png");
  const attempts = [
    ["wl-paste", ["--type", "image/png"]],
    ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
  ];
  for (const [cmd, args] of attempts) {
    try {
      const { stdout } = await execFileAsync(cmd, args, {
        encoding: "buffer",
        maxBuffer: 25 * 1024 * 1024,
        timeout: 4000,
      });
      if (!stdout || !stdout.length) continue;
      fs.writeFileSync(outPath, stdout);
      const payload = fileToPayload(outPath, "image/png", "screenshot.png");
      if (payload) return payload;
    } catch {
      // try next tool
    }
  }
  return null;
}

module.exports = { readClipboardImage };
