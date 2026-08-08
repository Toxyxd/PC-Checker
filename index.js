import { execFile, spawn } from "child_process";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";
import zlib from "zlib";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const SCANS_DIR = path.join(DATA_DIR, "scans");
const DIST_DIR = path.join(__dirname, "dist");
const EXE_PATH = path.join(DIST_DIR, "PC_Check_Scan.exe");
const HCC_LOG_DIR = path.join(os.tmpdir(), "pc-checker");
const TUNNEL_LOG = path.join(os.tmpdir(), "pc-checker", "cloudflared-web.log");
const BG_VIDEO = resolveBgVideo();
const LOGO = path.join(__dirname, "assets", "logo.png");

function resolveBgVideo() {
  const home = os.homedir();
  const candidates = [
    path.join(home, "Desktop", "furina-under-dark-skies.1920x1080.mp4"),
    path.join(home, "Desktop", "folder", "prana-system-error.3840x2160.mp4"),
    path.join(home, "Desktop", "prana-system-error.3840x2160.mp4"),
    path.join(home, "Desktop", "prana-system-error.mp4"),
    path.join(home, "Desktop", "folder", "prana-system-error.mp4"),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}
const PORT = Number(process.env.PORT || 3000);
const API_URL = process.env.API_URL || `http://localhost:${PORT}`;
const PUBLIC_DOMAIN = process.env.PUBLIC_DOMAIN || "https://toxy.lol";
const DOWNLOAD_LINK = `${PUBLIC_DOMAIN}/api/pc-check/download`;

function dosDate(d) { return (d.getFullYear() - 1980) << 9 | (d.getMonth() + 1) << 5 | d.getDate(); }
function dosTime(d) { return d.getHours() << 11 | d.getMinutes() << 5 | (d.getSeconds() >> 1); }

// Minimal STORE (no compression) zip so a named download can ship the exe together
// with a small scan-name.txt the client reads to tag the scan with a custom name.
function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const data = e.data;
    const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(dosTime(now), 10);
    lh.writeUInt16LE(dosDate(now), 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(dosTime(now), 12);
    c.writeUInt16LE(dosDate(now), 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt16LE(0, 30);
    c.writeUInt16LE(0, 32);
    c.writeUInt16LE(0, 34);
    c.writeUInt16LE(0, 36);
    c.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([c, nameBuf]));
    parts.push(Buffer.concat([lh, nameBuf, data]));
    offset += lh.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cd, eocd]);
}
const FILE_SCAN_LIMIT = Number(process.env.FILE_SCAN_LIMIT || 6000);
const TRACKED_EXTENSIONS = new Set([
  ".exe", ".msi", ".bat", ".cmd", ".com", ".scr", ".pif",
  ".zip", ".rar", ".7z", ".jar",
  ".dll", ".sys", ".drv", ".ocx",
  ".js", ".vbs", ".vbe", ".ps1", ".reg", ".cfg", ".ini",
]);

// Subdirectories too noisy/slow to recurse into during a system-wide sweep.
const SKIP_DIRS = new Set([
  "Packages", "PackageCache", "packages", "node_modules",
  "npm-cache", "pnpm-cache", "yarn", "nuget", "__pycache__",
  "Windows", "System32", "SysWOW64", "AppReadiness", "assembly",
  "Installer", "WindowsApps", "ServicePackInstall",
  ".git", "cache", "Cache", "Caches",
]);

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(SCANS_DIR)) {
  fs.mkdirSync(SCANS_DIR, { recursive: true });
}

function scanFilePath(scanId) {
  return path.join(SCANS_DIR, `${scanId}.json`);
}

function toStoredScan(scan) {
  return {
    id: scan.id,
    device_id: scan.deviceId,
    device_name: scan.deviceName,
    consent_given: Boolean(scan.consentGiven),
    scanned_at: scan.scannedAt,
    created_at: new Date().toISOString(),
    installedPrograms: (scan.installedPrograms ?? []).map((p) => ({
      name: p.name,
      version: p.version ?? null,
      publisher: p.publisher ?? null,
      install_date: p.installDate ?? null,
    })),
    runningProcesses: (scan.runningProcesses ?? []).map((p) => ({
      name: p.name,
      pid: p.pid,
      path: p.path ?? null,
      started_at: p.startedAt ?? null,
    })),
    downloadFiles: (scan.downloadFiles ?? []).map((f) => ({
      name: f.name,
      path: f.path,
      size_bytes: f.sizeBytes ?? null,
      modified_at: f.modifiedAt ?? null,
    })),
    tempFiles: (scan.tempFiles ?? []).map((f) => ({
      name: f.name,
      path: f.path,
      size_bytes: f.sizeBytes ?? null,
      modified_at: f.modifiedAt ?? null,
    })),
    desktopFiles: (scan.desktopFiles ?? []).map((f) => ({
      name: f.name,
      path: f.path,
      size_bytes: f.sizeBytes ?? null,
      modified_at: f.modifiedAt ?? null,
    })),
    systemFiles: (scan.systemFiles ?? []).map((f) => ({
      name: f.name,
      path: f.path,
      size_bytes: f.sizeBytes ?? null,
      modified_at: f.modifiedAt ?? null,
    })),
    dllFiles: (scan.dllFiles ?? []).map((f) => ({
      name: f.name,
      path: f.path,
      size_bytes: f.sizeBytes ?? null,
      modified_at: f.modifiedAt ?? null,
    })),
    diskSweep: (scan.diskSweep ?? []).map((f) => ({
      name: f.name,
      path: f.path,
      size_bytes: f.sizeBytes ?? null,
      modified_at: f.modifiedAt ?? null,
    })),
    forensics: {
      prefetch: (scan.forensics?.prefetch ?? []).map((p) => ({
        name: p.name,
        exe: p.exe ?? null,
        size_bytes: p.size_bytes ?? null,
        modified_at: p.modified_at ?? null,
      })),
      amcache: scan.forensics?.amcache ?? { present: false },
      shimcache: scan.forensics?.shimcache ?? [],
      evtx: (scan.forensics?.evtx ?? []).map((e) => ({
        log: e.log,
        id: e.id ?? null,
        level: e.level ?? null,
        time: e.time ?? null,
        message: e.message ?? null,
      })),
    },
  };
  // Compute cheat risk once at store time; the list and detail endpoints reuse
  // this cached result instead of re-scanning every DLL/disk entry on each poll.
  stored.risk = analyzeRisk(stored);
  return stored;
}

function writeJsonAtomic(filePath, obj) {
  const tmpPath = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

function insertScan(scan) {
  const stored = toStoredScan(scan);
  writeJsonAtomic(scanFilePath(scan.id), stored);
}

let listCache = { key: null, data: null };

function listScans() {
  if (!fs.existsSync(SCANS_DIR)) return [];

  const entries = fs
    .readdirSync(SCANS_DIR, { withFileTypes: true })
    .filter((e) => e.name.endsWith(".json"));

  const sig = entries.map((e) => `${e.name}:${e.mtimeMs}`).join(",");
  if (listCache.key === sig) return listCache.data;

  const scans = entries
    .map((e) => {
      const fullPath = path.join(SCANS_DIR, e.name);
      try {
        return JSON.parse(fs.readFileSync(fullPath, "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  scans.sort((a, b) => new Date(b.scanned_at) - new Date(a.scanned_at));

  // Keep list payload small (UI list only needs counts + timestamps). Risk is
  // read from the cached per-scan result, never recomputed here.
  const data = scans.map((s) => {
    const risk = s.risk || analyzeRisk(s);
    return {
      id: s.id,
      device_id: s.device_id,
      device_name: s.device_name,
      consent_given: Boolean(s.consent_given),
      scanned_at: s.scanned_at,
      created_at: s.created_at,
      program_count: (s.installedPrograms ?? []).length,
      process_count: (s.runningProcesses ?? []).length,
      download_count: (s.downloadFiles ?? []).length,
      temp_count: (s.tempFiles ?? []).length,
      desktop_count: (s.desktopFiles ?? []).length,
      system_count: (s.systemFiles ?? []).length,
      dll_count: (s.dllFiles ?? []).length,
      disk_count: (s.diskSweep ?? []).length,
      forensics_count:
        (s.forensics?.prefetch ?? []).length +
        (s.forensics?.evtx ?? []).length,
      risk_score: risk.score,
      risk_level: risk.level,
    };
  });

  listCache = { key: sig, data };
  return data;
}

function getScan(scanId) {
  const filePath = scanFilePath(scanId);
  if (!fs.existsSync(filePath)) return null;

  const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return {
    ...stored,
    consent_given: Boolean(stored.consent_given),
    risk: stored.risk || analyzeRisk(stored),
  };
}

// Heuristic cheat detection. This is a best-effort keyword/location scanner,
// not a guarantee. Each match adds weight to a 0-100 risk score.
const CHEAT_PATTERNS = [
  { re: /cheat/i, w: 4, label: "filename/path mentions 'cheat'" },
  { re: /\bhack(?!\w)/i, w: 4, label: "filename/path mentions 'hack'" },
  { re: /aimbot/i, w: 7, label: "aimbot tool" },
  { re: /wallhack|wall ?hack/i, w: 7, label: "wallhack tool" },
  { re: /\besp(?!32)\b/i, w: 7, label: "ESP overlay tool" },
  { re: /triggerbot/i, w: 7, label: "triggerbot tool" },
  { re: /bhop/i, w: 4, label: "bhop/auto-jump script" },
  { re: /no[-_ ]?recoil/i, w: 5, label: "recoil control tool" },
  { re: /injector/i, w: 6, label: "DLL/process injector" },
  { re: /\binject\b/i, w: 6, label: "DLL/process injector" },
  { re: /mod[ _-]?menu/i, w: 6, label: "mod menu tool" },
  { re: /krypton/i, w: 8, label: "known cheat DLL (krypton)" },
  { re: /tartarus/i, w: 8, label: "known cheat DLL (tartarus)" },
  { re: /arceus/i, w: 8, label: "known cheat tool (arceus)" },
  { re: /axolotl/i, w: 8, label: "known cheat tool (axolotl)" },
  { re: /spoof/i, w: 6, label: "HWID/hardware spoofer" },
  { re: /bypass/i, w: 6, label: "anti-cheat bypass tool" },
  { re: /manual[ _-]?map/i, w: 6, label: "manual map injector" },
  { re: /maphack/i, w: 7, label: "maphack tool" },
  { re: /pixelbot|pixel ?bot/i, w: 6, label: "pixel bot (auto-aim tool)" },
  { re: /hacktool|hack ?tool/i, w: 5, label: "hack tool" },
{ re: /crack/i, w: 3, label: "crack-style file" },
  { re: /keygen/i, w: 3, label: "keygen-style file" },
  { re: /\b(process ?hacker|x64dbg)\b/i, w: 5, label: "memory debugger/editor" },
  { re: /cheat ?engine/i, w: 7, label: "memory scanner/editor" },
  { re: /\b(injector|dll ?inject|manual ?map|mapper)\b/i, w: 6, label: "DLL injection/mapping utility" },
  { re: /driver ?(loader|mapper)|manual ?driver/i, w: 6, label: "kernel driver loader/mapper" },
  { re: /dse ?(fix|patch|disable|bypass)|hvci ?bypass|ci ?bypass/i, w: 8, label: "kernel integrity bypass tool" },
  { re: /(vulnerable|discarded) ?driver/i, w: 7, label: "kernel vulnerable-driver tool" },
  { re: /kdmapper|rdr.?mapper|byovd/i, w: 7, label: "kernel driver mapper" },
  { re: /\b(wpm|read ?process ?memory|write ?process ?memory)\b/i, w: 7, label: "memory read/write utility" },
  { re: /\b(undetected|antidebug|anti ?vm|antivm)\b/i, w: 6, label: "detection-evasion tool" },
  { re: /themida|vmprotect|enigma ?protector/i, w: 4, label: "executable packer/protector" },
  { re: /trace ?cleaner|log ?clean|event ?log ?wipe|registry ?wipe/i, w: 3, label: "trace/registry cleaning tool" },
];

const RISK_THRESHOLD = 12;

// Known cheat software. ANY trace of these on a scanned PC forces the scan to
// 100% cheat risk regardless of other evidence (hard match, not heuristic).
const HARD_CHEATS = [
  { re: /\bmadium\b/i, label: "Madium" },
  { re: /\bxeno\b/i, label: "Xeno" },
  { re: /\bmatrix\b/i, label: "Matrix" },
  { re: /\bvolt\b/i, label: "Volt" },
  { re: /\bffm\b/i, label: "FFM" },
  { re: /\bnexomia\b/i, label: "Nexomia" },
  { re: /\bnewui\b/i, label: "NewUI" },
  { re: /\boldui\b/i, label: "OldUI" },
  { re: /\bvelocity\b/i, label: "Velocity" },
  { re: /\bpotassium\b/i, label: "Potassium Vortex" },
  { re: /\bvortex\b/i, label: "Potassium Vortex" },
  { re: /\bbyte[\s_-]?breaker\b/i, label: "ByteBreaker" },
  { re: /\bsolara\b/i, label: "Solara" },
  { re: /\breal\b/i, label: "Real" },
  { re: /\bessential\b/i, label: "Essential" },
  { re: /\bwave\b/i, label: "Wave" },
];

// Known legit software that contains "cheat"/"inject" in its name (anti-cheat
// clients, Windows tooling). These are excluded from flagging.
const SAFE_TOKENS = [
  "mavinject",
  "dependencyinjection", "injection",
  "anticheat", "anti-cheat",
  "battleye", "easyanticheat", "easyanti",
  "denuvo", "vgk.sys", "nvcontainer",
  "gameoverlay", "overlayrenderer", "overlayvulkan",
  "steam", "valve", "citizen", "fivem", "five-m",
  "nvidia", "geforce", "discord",
  "toxygui", "toxy-gui",
];

function analyzeRisk(scan) {
  const flags = [];
  let score = 0;

  const check = (type, name, fullPath) => {
    const haystack = `${name || ""} ${fullPath || ""}`;
    const lower = haystack.toLowerCase();
    for (const h of HARD_CHEATS) {
      if (h.re.test(haystack)) {
        score = 100;
        flags.push({ type, name: name || null, path: fullPath || null, reason: `${h.label} detected — 100% cheat risk` });
        return;
      }
    }
    for (const t of SAFE_TOKENS) {
      if (lower.includes(t)) return;
    }
    for (const p of CHEAT_PATTERNS) {
      if (p.re.test(haystack)) {
        score += p.w;
        flags.push({ type, name: name || null, path: fullPath || null, reason: p.label });
        return;
      }
    }
  };

  const seen = new Set();
  const fileLists = [
    ["file", scan.systemFiles],
    ["file", scan.tempFiles],
    ["file", scan.downloadFiles],
    ["file", scan.desktopFiles],
    ["file", scan.dllFiles],
    ["file", scan.diskSweep],
    ["program", scan.installedPrograms],
  ];
  for (const [type, arr] of fileLists) {
    for (const f of arr || []) {
      if (!f || seen.has(f.path)) continue;
      seen.add(f.path);
      check(type, f.name, f.path);
    }
  }

  for (const p of scan.runningProcesses || []) {
    const key = `${p.pid || ""}-${p.name || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    check("process", p.name, p.path);

    const path = (p.path || "").toLowerCase();
    if (!path.includes("toxy-gui") && path.includes("temp") && /\\[^\\]+\.exe$/i.test(path)) {
      score += 4;
      flags.push({ type: "process", name: p.name, path: p.path, reason: "process running from a temp directory" });
    }
  }

  // Forensics artifacts: programs that ran even if deleted afterwards.
  const f = scan.forensics || {};
  for (const pf of f.prefetch || []) {
    const exe = pf.exe || pf.name || "";
    const name = `${exe} ${pf.name || ""}`.trim();
    check("prefetch", name, null);
  }
  for (const exe of f.amcache?.exes || []) {
    check("amcache", exe, null);
  }
  for (const exe of f.shimcache || []) {
    check("shimcache", exe, null);
  }
  for (const ev of f.evtx || []) {
    const haystack = `${ev.message || ""} ${ev.log || ""}`.toLowerCase();
    const suspicious =
      (haystack.includes("inject") && !SAFE_TOKENS.some((t) => haystack.includes(t))) ||
      (haystack.includes("kernel") && haystack.includes("driver") && !haystack.includes("verified")) ||
      haystack.includes("dse") ||
      haystack.includes("bypass") ||
      haystack.includes("obfuscat");
    if (suspicious) {
      score += 3;
      flags.push({ type: "event", name: `#${ev.id}`, path: ev.log, reason: `suspicious event log entry (${(ev.message || "").slice(0, 60)})` });
    }
  }

  const level = score >= 60 ? "high" : score >= RISK_THRESHOLD ? "medium" : "low";
  return { score: Math.min(100, score), level, flags };
}

function validateScanPayload(body) {
  if (!body?.consentGiven) return "consentGiven must be true.";
  if (!body.deviceId || !body.deviceName) return "deviceId and deviceName are required.";
  if (!Array.isArray(body.installedPrograms)) return "installedPrograms must be an array.";
  if (!Array.isArray(body.runningProcesses)) return "runningProcesses must be an array.";
  if (!Array.isArray(body.downloadFiles)) return "downloadFiles must be an array.";
  if (!Array.isArray(body.tempFiles)) return "tempFiles must be an array.";
  if (body.desktopFiles != null && !Array.isArray(body.desktopFiles)) return "desktopFiles must be an array.";
  if (body.systemFiles != null && !Array.isArray(body.systemFiles)) return "systemFiles must be an array.";
  if (body.dllFiles != null && !Array.isArray(body.dllFiles)) return "dllFiles must be an array.";
  if (body.diskSweep != null && !Array.isArray(body.diskSweep)) return "diskSweep must be an array.";
  if (body.forensics != null && typeof body.forensics !== "object") return "forensics must be an object.";
  return null;
}

// ---- Web "PC Check" loader builder -----------------------------------------
// The dashboard builds the scan exe on demand: it (re)uses a cloudflared tunnel
// pointing at this server, reads the real public URL from the log, runs the
// existing build-scan-exe.ps1 with that URL baked in, then serves the exe.

const pcCheckState = {
  building: false,
  url: null,
  builtAt: null,
  error: null,
  message: "",
};

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findCloudflared() {
  const tryPaths = [];
  try {
    const { stdout } = await execFileAsync("where", ["cloudflared"]);
    tryPaths.push(...stdout.trim().split(/\r?\n/).filter(Boolean));
  } catch {
    // Not on PATH.
  }
  tryPaths.push("C:\\Program Files (x86)\\cloudflared\\cloudflared.exe");
  for (const p of tryPaths) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

async function ensureTunnel() {
  const cf = await findCloudflared();
  if (!cf) {
    throw new Error("cloudflared not found. Install it once: winget install --id Cloudflare.cloudflared");
  }

  if (!fs.existsSync(HCC_LOG_DIR)) fs.mkdirSync(HCC_LOG_DIR, { recursive: true });

  // Try to reuse an already-running tunnel: its logfile has the public URL.
  const oldLog = path.join(HCC_LOG_DIR, "cloudflared.log");
  if (fs.existsSync(oldLog)) {
    const m = fs.readFileSync(oldLog, "utf8").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) {
      const stillAlive = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\" | Select-Object -First 1 | Measure-Object | % { $_.Count }",
      ]).then((r) => r.stdout.trim() === "1").catch(() => false);
      if (stillAlive) return m[0];
    }
  }

  // Start a fresh quick tunnel for this server.
  try { fs.unlinkSync(TUNNEL_LOG); } catch { /* not present */ }
  const proc = spawn(cf, [
    "tunnel",
    "--url", `http://localhost:${PORT}`,
    "--no-autoupdate",
    "--logfile", TUNNEL_LOG,
    "--loglevel", "info",
  ], { stdio: "ignore", windowsHide: true });
  proc.on("error", () => {});

  for (let i = 0; i < 45; i++) {
    await sleepMs(1000);
    if (fs.existsSync(TUNNEL_LOG)) {
      const m = fs.readFileSync(TUNNEL_LOG, "utf8").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) return m[0];
    }
  }
  throw new Error("Could not get a public tunnel URL. Check that cloudflared can reach the internet.");
}

async function buildScanExe(url) {
  const script = path.join(__dirname, "scripts", "build-scan-exe.ps1");
  const { stdout, stderr } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-ApiUrl", url],
    { maxBuffer: 20 * 1024 * 1024, windowsHide: true }
  );
  return `${stdout}${stderr}`.trim();
}

async function buildPcCheck() {
  if (pcCheckState.building) return;
  pcCheckState.building = true;
  pcCheckState.error = null;
  pcCheckState.message = "Building exe (takes ~4s)...";
  try {
    pcCheckState.url = PUBLIC_DOMAIN;
    const output = await buildScanExe(PUBLIC_DOMAIN);
    pcCheckState.builtAt = new Date().toISOString();
    pcCheckState.message = output.split(/\r?\n/).filter((l) => l.trim()).pop() || "Build done.";
  } catch (err) {
    pcCheckState.error = String(err.message || err);
    pcCheckState.message = "Build failed.";
  } finally {
    pcCheckState.building = false;
  }
}

function pcCheckStatus() {
  let size = null;
  try {
    if (fs.existsSync(EXE_PATH)) size = fs.statSync(EXE_PATH).size;
  } catch { /* ignore */ }
  return {
    building: pcCheckState.building,
    url: pcCheckState.url,
    builtAt: pcCheckState.builtAt,
    error: pcCheckState.error,
    message: pcCheckState.message,
    exeExists: fs.existsSync(EXE_PATH),
    exeSize: size,
  };
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Toxy Anti-Cheat</title>
  <link rel="icon" type="image/png" href="/logo" />
  <meta name="description" content="Toxy Anti-Cheat" />
  <style>
    :root { color-scheme: dark; font-family: Inter, Segoe UI, system-ui, sans-serif; }
    body { margin: 0; background: transparent; color: #e8edf5; }
    #loader { position: fixed; inset: 0; z-index: 100; background: #1a2740; display: flex; align-items: center; justify-content: center; overflow: hidden; transition: opacity .5s ease, visibility .5s; }
    #loader.done { opacity: 0; visibility: hidden; pointer-events: none; }
    .bg-orb { position: absolute; border-radius: 50%; pointer-events: none; filter: blur(70px); }
    .bg-orb.o1 { width: 440px; height: 440px; top: -90px; left: -70px; background: radial-gradient(circle, rgba(84,132,224,.45), transparent 62%); animation: drift 21s ease-in-out infinite; }
    .bg-orb.o2 { width: 400px; height: 400px; bottom: -110px; right: -90px; background: radial-gradient(circle, rgba(64,150,188,.38), transparent 62%); animation: drift2 25s ease-in-out infinite; }
    .bg-orb.o3 { width: 260px; height: 260px; top: 52%; left: 48%; background: radial-gradient(circle, rgba(132,172,244,.22), transparent 62%); filter: blur(60px); animation: drift3 17s ease-in-out infinite; }
    @keyframes drift { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(70px,46px) scale(1.15); } }
    @keyframes drift2 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(-74px,-56px) scale(1.18); } }
    @keyframes drift3 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(-44px,52px) scale(1.12); } }
    .bg-particles { position: absolute; inset: 0; pointer-events: none; }
    .bg-particles i { position: absolute; bottom: -12px; width: 4px; height: 4px; border-radius: 50%; background: #bcd3f5; box-shadow: 0 0 8px 2px rgba(170,200,248,.55); opacity: 0; animation: rise 13s linear infinite; }
    .bg-particles i.dim { width: 2px; height: 2px; box-shadow: 0 0 6px 1px rgba(170,200,240,.4); animation-duration: 18s; }
    .bg-particles i.bright { width: 6px; height: 6px; box-shadow: 0 0 12px 3px rgba(180,210,250,.7); animation-duration: 10s; }
    @keyframes rise { 0% { transform: translateY(0) translateX(0); opacity: 0; } 12% { opacity: .7; } 85% { opacity: .45; } 100% { transform: translateY(-115vh) translateX(var(--dx, 0px)); opacity: 0; } }
    .bg-sweep { position: absolute; inset: -60%; pointer-events: none; background: conic-gradient(from 0deg, transparent 0deg, rgba(120,170,235,.09) 70deg, transparent 140deg); animation: sweepSpin 26s linear infinite; }
    @keyframes sweepSpin { to { transform: rotate(360deg); } }
    .loader-box { text-align: center; position: relative; z-index: 1; animation: loaderFloat 5s ease-in-out infinite; }
    @keyframes loaderFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-9px); } }
    .loader-logo-box { position: relative; width: 136px; height: 136px; margin: 0 auto 22px; }
    .loader-glow { position: absolute; inset: -18px; border-radius: 50%; background: radial-gradient(circle, rgba(96,156,216,.42) 0%, rgba(58,86,132,.2) 45%, transparent 72%); filter: blur(8px); animation: glowPulse 2.4s ease-in-out infinite; }
    @keyframes glowPulse { 0%,100% { opacity: .4; transform: scale(.97); } 50% { opacity: .95; transform: scale(1.06); } }
    .loader-ring { position: absolute; inset: 0; border-radius: 50%; border: 3px solid rgba(64,88,128,.5); border-top-color: #93b6e2; border-right-color: rgba(147,182,226,.45); box-shadow: 0 0 18px rgba(50,72,110,.5), inset 0 0 18px rgba(50,72,110,.35); animation: loaderSpin 1.1s linear infinite; }
    @keyframes loaderSpin { to { transform: rotate(360deg); } }
    .loader-logo { position: absolute; width: 110px; height: 110px; top: 50%; left: 50%; transform: translate(-50%,-50%); object-fit: contain; filter: drop-shadow(0 0 18px rgba(96,150,230,.6)); z-index: 1; }
    .loader-spark { position: absolute; top: 50%; left: 50%; width: 9px; height: 9px; margin: -4.5px 0 0 -4.5px; border-radius: 50%; background: #b9d4f4; box-shadow: 0 0 12px 3px rgba(147,182,226,.8); animation: sparkOrbit 2.2s linear infinite; z-index: 2; }
    .loader-spark.s2 { width: 6px; height: 6px; margin: -3px 0 0 -3px; background: rgba(147,182,226,.85); box-shadow: 0 0 10px 2px rgba(147,182,226,.6); animation-delay: 1.1s; animation-duration: 3.4s; }
    @keyframes sparkOrbit { to { transform: rotate(360deg) translateX(68px); } }
    .loader-text { font-size: 15px; font-weight: 700; letter-spacing: 5px; color: #93b6e2; text-shadow: 0 0 14px rgba(60,84,120,.6); }
    .loader-bar { width: 270px; height: 4px; margin: 18px auto 0; border-radius: 999px; background: rgba(64,88,128,.4); overflow: hidden; }
    .loader-bar-fill { height: 100%; width: 40%; border-radius: 999px; background: linear-gradient(90deg, rgba(147,182,226,.35), #93b6e2, rgba(147,182,226,.35)); box-shadow: 0 0 12px rgba(147,182,226,.9); animation: barSweep 1.4s ease-in-out infinite; }
    @keyframes barSweep { 0% { transform: translateX(-110%); } 100% { transform: translateX(360%); } }
    #bg-video { position: fixed; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; z-index: -2; }
    #bg-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(5,10,25,.06); z-index: -1; }
    .wrap { max-width: 1200px; margin: 0 auto; padding: 32px 20px; }
    section[id] { scroll-margin-top: 20px; }
    .hero { text-align: center; position: relative; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 0; perspective: 650px; }
    .hero.locked { position: fixed; top: -9999px; left: 0; width: 100%; pointer-events: none; visibility: hidden; }
    #content.content-visible { padding-top: 40px; }
    .hero-logo { height: clamp(160px, 32vw, 340px); max-width: 90vw; object-fit: contain; cursor: pointer; will-change: transform; filter: drop-shadow(0 0 30px rgba(20,20,25,.6)); }
    .title-in { display: inline-block; opacity: 1; animation: titleSpinIn 1.4s cubic-bezier(.2,.9,.3,1.3) forwards; will-change: transform; }
    @keyframes titleSpinIn { 0% { opacity: 0; transform: rotateX(-90deg) scale(.4) translateY(40px); filter: blur(6px); } 60% { opacity: 1; } 100% { opacity: 1; transform: rotateX(0deg) scale(1) translateY(0); filter: blur(0); } }
    .status-pill { display: inline-flex; align-items: center; gap: 8px; padding: 6px 16px; border-radius: 999px; border: 1px solid rgba(22,101,52,.5); background: rgba(22,101,52,.12); color: #34d399; font-size: 13px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; backdrop-filter: blur(2px); margin-bottom: 18px; }
    .hero-stack { display: flex; flex-direction: column; align-items: center; transform: translateY(-24px); transform-style: preserve-3d; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #14532d; box-shadow: 0 0 10px rgba(20,83,45,.5); animation: statusPulse 1.6s ease-in-out infinite; }
    @keyframes statusPulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .45; transform: scale(.75); } }
    .hero-menu { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin: 22px auto 0; max-width: 720px; opacity: 0; transform: translateY(-14px) scale(.96); visibility: hidden; pointer-events: none; transition: opacity .35s ease, transform .35s cubic-bezier(.2,.9,.3,1.2), visibility .35s; }
    .hero-menu.open { opacity: 1; transform: translateY(0) scale(1); visibility: visible; pointer-events: auto; }
    .hero-menu a { display: inline-flex; align-items: center; gap: 8px; padding: 14px 34px; border-radius: 999px; border: 1px solid rgba(148,163,184,.4); background: rgba(10,15,30,.3); color: #e8edf5; text-decoration: none; font-weight: 600; font-size: 17px; backdrop-filter: blur(2px); transition: transform .2s ease, border-color .2s ease, background .2s ease; animation: menuIn .45s cubic-bezier(.2,.9,.3,1.2) backwards; }
    .hero-menu a:hover { transform: translateY(-3px); border-color: #38bdf8; background: rgba(56,189,248,.25); }
    @keyframes menuIn { from { opacity: 0; transform: translateY(-12px) scale(.9); } to { opacity: 1; transform: translateY(0) scale(1); } }
    #content { opacity: 0; visibility: hidden; transform: translateY(24px); transition: opacity .2s ease, transform .2s ease, visibility .2s; }
    #content.content-visible { opacity: 1; visibility: visible; transform: translateY(0); }
    .layout { display: grid; grid-template-columns: 320px 1fr; gap: 20px; }
    @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
    .panel { background: rgba(20,20,24,.18); border: 1px solid rgba(148,163,184,.3); border-radius: 16px; padding: 20px; backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); }
    .scan-card { width: 100%; text-align: left; background: rgba(20,20,24,.12); color: inherit; border: 1px solid rgba(148,163,184,.25); border-radius: 12px; padding: 14px; margin-bottom: 10px; cursor: pointer; backdrop-filter: blur(2px); }
    .scan-card.active { border-color: #1e457a; background: rgba(12,29,56,.5); box-shadow: 0 0 0 1px rgba(30,69,122,.5), 0 14px 30px rgba(0,2,8,.5); }
    .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 16px; }
    .meta > div { background: rgba(20,20,24,.12); border: 1px solid rgba(148,163,184,.25); border-radius: 12px; padding: 12px; backdrop-filter: blur(2px); }
    .tabs button { margin-right: 8px; margin-bottom: 12px; padding: 8px 14px; border-radius: 999px; border: 1px solid rgba(148,163,184,.35); background: rgba(20,20,24,.14); color: inherit; cursor: pointer; backdrop-filter: blur(2px); }
    .tabs button.active { background: #38bdf8; color: #04111f; border-color: #38bdf8; }
    input { width: 100%; padding: 10px; border-radius: 10px; border: 1px solid rgba(148,163,184,.35); background: rgba(20,20,24,.14); color: inherit; margin-bottom: 12px; backdrop-filter: blur(2px); }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px; border-bottom: 1px solid rgba(148,163,184,.25); text-align: left; vertical-align: top; }
    th { color: #cbd5e1; }
    .muted { color: #cbd5e1; }
    .badge { display: inline-block; padding: 4px 8px; border-radius: 999px; background: rgba(21,128,61,.22); color: #34d399; font-size: 12px; }
    .risk-low { color: #166534; }
    .risk-medium { color: #78350f; }
    .risk-high { color: #7f1d1d; font-weight: 700; }
    .summary { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; background: rgba(20,20,24,.12); border: 1px solid rgba(148,163,184,.25); border-radius: 12px; padding: 14px; backdrop-filter: blur(2px); }
    .empty { color: #cbd5e1; text-align: center; padding: 24px; }
    .pccheck-panel { margin-bottom: 20px; }
    .hidden { display: none !important; }
    #home-btn { position: fixed; top: 16px; left: 16px; z-index: 60; width: 44px; height: 44px; border-radius: 12px; border: 1px solid rgba(148,163,184,.4); background: rgba(20,20,24,.3); color: #e8edf5; font-size: 22px; line-height: 1; cursor: pointer; backdrop-filter: blur(2px); display: flex; align-items: center; justify-content: center; transition: transform .2s ease, border-color .2s ease, background .2s ease; }
    #home-btn:hover { transform: scale(1.08); border-color: #38bdf8; background: rgba(56,189,248,.25); }
    .riskbig { display: flex; align-items: center; gap: 24px; margin-bottom: 14px; padding: 18px; background: rgba(20,20,24,.18); border: 1px solid rgba(148,163,184,.3); border-radius: 14px; backdrop-filter: blur(2px); animation: riskPop .5s cubic-bezier(.2,.9,.3,1.2); }
    .riskbig-circle { line-height: 0; }
    .riskbig-label { display: flex; flex-direction: column; gap: 6px; }
    .riskbig-title { font-size: 28px; font-weight: 800; }
    .riskbig.high .riskbig-title { color: #7f1d1d; }
    .riskbig.medium .riskbig-title { color: #78350f; }
    .riskbig.low .riskbig-title { color: #14532d; }
    .pbar { height: 8px; border-radius: 999px; background: rgba(148,163,184,.25); overflow: hidden; margin-bottom: 16px; }
    .pbar-in { height: 100%; border-radius: 999px; transition: width 1s ease; }
    .pbar-in.high { background: #7f1d1d; }
    .pbar-in.medium { background: #78350f; }
    .pbar-in.low { background: #14532d; }
    @keyframes riskPop { from { opacity: 0; transform: scale(.85); } to { opacity: 1; transform: scale(1); } }
.pcc-btn { display: inline-block; padding: 10px 18px; border-radius: 10px; border: 1px solid #38bdf8; background: rgba(56,189,248,.85); color: #04111f; font-weight: 600; cursor: pointer; text-decoration: none; font-family: inherit; }
.pcc-btn:hover { background: #7dd3fc; }
.pcc-btn-download { background: rgba(20,83,45,.6); border-color: #14532d; }
.pcc-btn-download:hover { background: #166534; }
.pcc-name-row { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; margin: 14px 0; padding: 14px 18px; border-radius: 16px; background: linear-gradient(135deg, rgba(20,20,24,.45), rgba(16,14,20,.3)); border: 1px solid rgba(56,189,248,.28); box-shadow: 0 0 22px rgba(56,189,248,.06); }
.pcc-name-label { display: inline-flex; align-items: center; justify-content: center; height: 44px; margin: 0; padding: 0; box-sizing: border-box; font-size: 13px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; color: #94a3b8; white-space: nowrap; line-height: 1; }
.pcc-name-input { box-sizing: border-box; height: 44px; line-height: 1; width: 200px; padding: 0 16px; margin: 0; font-size: 14px; color: #f1f5f9; background: rgba(2,8,20,.4); border: 1px solid rgba(56,189,248,.55); border-radius: 12px; outline: none; box-shadow: 0 0 0 1px rgba(56,189,248,.1), 0 0 20px rgba(56,189,248,.12), inset 0 0 14px rgba(56,189,248,.05); transition: border-color .2s, box-shadow .2s; font-family: inherit; vertical-align: middle; }
.pcc-name-input::placeholder { color: #64748b; }
.pcc-name-input:focus { border-color: #7dd3fc; box-shadow: 0 0 0 3px rgba(56,189,248,.25), 0 0 28px rgba(56,189,248,.35), inset 0 0 14px rgba(56,189,248,.08); }
    code { background: rgba(10,15,30,.3); border: 1px solid rgba(148,163,184,.3); padding: 2px 6px; border-radius: 6px; font-size: 0.85em; }
    .hidebtn { padding: 6px 12px; border-radius: 8px; border: 1px solid rgba(148,163,184,.4); background: rgba(10,15,30,.25); color: #cbd5e1; cursor: pointer; font-family: inherit; font-size: 13px; backdrop-filter: blur(2px); }
    .hidebtn:hover { border-color: #38bdf8; color: #e8edf5; }
    .scan-card { transition: transform .2s ease, border-color .2s ease, box-shadow .2s ease, background .2s ease; }
    .scan-card:hover { border-color: #142c4d; box-shadow: 0 12px 28px rgba(0,2,8,.5); transform: translateY(-1px); background: rgba(10,23,40,.45); }
    .panel { transition: border-color .25s ease, box-shadow .25s ease; }
    .panel:hover { border-color: rgba(148,163,184,.4); box-shadow: 0 10px 24px rgba(0,8,22,.35); }
    .riskbig-circle svg { animation: riskGlowLow 2.6s ease-in-out infinite; }
    .riskbig.medium .riskbig-circle svg { animation-name: riskGlowMed; }
    .riskbig.high .riskbig-circle svg { animation-name: riskGlowHigh; }
    @keyframes riskGlowLow { 0%,100% { filter: drop-shadow(0 0 1px rgba(30,122,69,.3)); } 50% { filter: drop-shadow(0 0 4px rgba(30,122,69,.5)); } }
    @keyframes riskGlowMed { 0%,100% { filter: drop-shadow(0 0 1px rgba(154,106,14,.3)); } 50% { filter: drop-shadow(0 0 4px rgba(154,106,14,.5)); } }
    @keyframes riskGlowHigh { 0%,100% { filter: drop-shadow(0 0 1px rgba(159,38,54,.35)); } 50% { filter: drop-shadow(0 0 5px rgba(159,38,54,.5)); } }
  </style>
</head>
<body>
  <div id="loader">
    <div class="bg-orb o1"></div>
    <div class="bg-orb o2"></div>
    <div class="bg-orb o3"></div>
    <div class="bg-particles">
      <i style="left:8%;--dx:-30px;animation-delay:0s;animation-duration:12s"></i>
      <i style="left:22%;--dx:20px;animation-delay:3s;animation-duration:15s"></i>
      <i style="left:38%;--dx:-12px;animation-delay:6s;animation-duration:11s"></i>
      <i style="left:56%;--dx:26px;animation-delay:1.5s;animation-duration:14s"></i>
      <i style="left:72%;--dx:-24px;animation-delay:4.5s;animation-duration:13s"></i>
      <i style="left:88%;--dx:14px;animation-delay:7.5s;animation-duration:16s"></i>
      <i class="dim" style="left:14%;--dx:18px;animation-delay:2s"></i>
      <i class="dim" style="left:30%;--dx:-16px;animation-delay:5s"></i>
      <i class="dim" style="left:48%;--dx:22px;animation-delay:8s"></i>
      <i class="dim" style="left:66%;--dx:-10px;animation-delay:1s"></i>
      <i class="dim" style="left:80%;--dx:16px;animation-delay:6s"></i>
      <i class="dim" style="left:95%;--dx:-20px;animation-delay:9s"></i>
      <i class="bright" style="left:16%;--dx:40px;animation-delay:3.5s"></i>
      <i class="bright" style="left:60%;--dx:-36px;animation-delay:7s"></i>
      <i class="bright" style="left:92%;--dx:28px;animation-delay:2.5s"></i>
    </div>
    <div class="bg-sweep"></div>
    <div class="loader-box">
      <div class="loader-logo-box">
        <div class="loader-glow"></div>
        <div class="loader-ring"></div>
        <img class="loader-logo" src="/logo" alt="Toxy Anti-Cheat" />
        <div class="loader-spark"></div>
        <div class="loader-spark s2"></div>
      </div>
      <div class="loader-text">Loading...</div>
      <div class="loader-bar"><div class="loader-bar-fill"></div></div>
    </div>
  </div>
  <video id="bg-video" autoplay muted loop playsinline>
    <source src="/background?v=2" type="video/mp4" />
  </video>
  <div id="bg-overlay"></div>
    <button id="home-btn" title="Home" aria-label="Home">⌂</button>
    <div class="wrap">
      <header class="hero" id="hero">
        <div class="hero-stack">
          <div class="status-pill"><span class="status-dot"></span> working</div>
          <img id="hero-title" class="hero-logo" src="/logo" alt="Toxy Anti-Cheat" title="Menu" />
        </div>
        <nav id="hero-menu" class="hero-menu" aria-hidden="true">
          <a href="#dashboard" data-target="dashboard">Dashboard</a>
          <a href="#pccheck" data-target="pccheck">PC Check</a>
        </nav>
      </header>
    <div id="content" class="content-hidden">
    <section class="panel pccheck-panel" id="pccheck">
      <h2>PC Check</h2>
      <p class="muted">Build the scan exe and send it to the PC you want to check. Building bakes in this machine's public URL so results come back here automatically.</p>
      <div id="pccheck-body"><span class="muted">Loading...</span></div>
    </section>
    <section class="panel" id="dashboard">
      <h2>Dashboard</h2>
      <div class="layout" id="scans">
      <section class="panel">
        <div id="summary" class="summary"><span class="muted">Loading...</span></div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <h2 style="margin:0">Scans</h2>
          <span style="display:inline-flex;gap:10px;align-items:center"><button class="hidebtn" onclick="refreshScans()">Refresh</button><button class="hidebtn" id="scan-toggle" onclick="toggleScans()">Hide</button></span>
        </div>
        <div id="scan-list" class="muted">Loading...</div>
        <div id="scan-list-hidden" class="empty muted" style="display:none"><span class="muted">Scans hidden.</span></div>
      </section>
      <section class="panel">
        <div id="detail" class="empty">Select a scan.</div>
      </section>
      </div>
    </section>
    <section class="panel" id="about">
      <h2>About</h2>
      <p class="muted">Toxy Anti-Cheat is a consent-based PC integrity checker. The scan client collects installed programs, running processes, executable files, and Windows forensics artifacts, then sends the results to this dashboard for a heuristic cheat-risk review. Nothing is read without the scanned PC's explicit consent.</p>
    </section>
    <section class="panel" id="settings">
      <h2>Settings</h2>
      <p class="muted">Settings coming soon.</p>
    </section>
    </div>
  </div>
  <script>
    let scans = [], selected = null, tab = "programs", query = "";
    window.__DOWNLOAD_LINK = \`${DOWNLOAD_LINK}\`;
    history.scrollRestoration = "manual";
    window.scrollTo(0, 0);

    // 3s invisible loading hold on entry/refresh, then fade away.
    (function loader() {
      const el = document.getElementById("loader");
      if (!el) return;
      setTimeout(() => el.classList.add("done"), 3000);
    })();

    const fmt = (v) => v ? new Date(v).toLocaleString() : "—";
    const bytes = (v) => v == null ? "—" : v < 1024 ? v + " B" : v < 1048576 ? (v/1024).toFixed(1)+" KB" : (v/1048576).toFixed(1)+" MB";
  const brandName = (v) => String(v ?? "").replace(/toxy/gi, "Tester");
  // Yellow TESTER badge so everyone knows the scan came from a tester.
  const isTester = (v) => /toxy|tester/i.test(String(v ?? ""));
  const testerBadge = () => '<span style="color:#ffd60a;font-weight:800;letter-spacing:.5px">TESTER</span>';
  // Blue badge for every other device name, styled identically to the tester badge.
  const nameBadge = (v) => '<span style="color:#38bdf8;font-weight:800;letter-spacing:.5px">' + brandName(v) + '</span>';

async function pccCheck() {
      const el = document.getElementById("pccheck-body");
      const link = \`\${window.__DOWNLOAD_LINK}\`;
      const linkId = "pcc-link";
      const nameId = "pcc-name";
      el.innerHTML = \`
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-bottom:8px">
          <button class="pcc-btn pcc-btn-download" onclick="copyDownloadLink(this)">Copy link</button>
          <code id="pcc-link-out" style="flex:1;min-width:200px;word-break:break-all;background:rgba(20,20,24,.3);padding:8px 12px;border-radius:8px;border:1px solid rgba(148,163,184,.3);font-size:13px">\${escapeHtml(link)}</code>
        </div>
        <div class="pcc-name-row">
          <label class="pcc-name-label" for="pcc-name">Name</label>
          <input id="pcc-name" class="pcc-name-input" type="text" placeholder="custom name" maxlength="40" oninput="updatePcLink()" />
        </div>
        <div class="muted" style="font-size:13px">Send this link to the target PC. Give it a name so the scan shows up as that name on the dashboard instead of the PC's device name.</div>
      \`;
      window.__pccLink = () => {
        const raw = (document.getElementById("pcc-name")?.value || "").trim();
        return raw ? \`\${link}?name=\${encodeURIComponent(raw)}\` : link;
      };
      window.updatePcLink = () => {
        const out = document.getElementById("pcc-link-out");
        if (out) out.textContent = window.__pccLink();
      };
    }

    // Copies the shareable download link (https://toxy.lol/api/pc-check/download).
    // Opening that link in a browser auto-starts the exe download.
    function refreshScans() { if (typeof loadScans === "function") loadScans(); }
    function copyDownloadLink(btn) {
      const link = (window.__pccLink || (() => window.__DOWNLOAD_LINK))();
      const done = () => { const old = btn.textContent; btn.textContent = "Copied!"; setTimeout(() => { btn.textContent = old; }, 1600); };
      (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject())
        .then(done).catch(() => {
          const ta = document.createElement("textarea");
          ta.value = link; document.body.appendChild(ta); ta.select();
          try { document.execCommand("copy"); done(); } catch {}
          document.body.removeChild(ta);
        });
    }

function escapeHtml(v) {
      return String(v ?? "").replace(/[&<>"']/g, (c) =>
        ({ "&":"&", "<":"<", ">":">", "\\"":"&quot;", "'":"&#39;" }[c]));
    }

    pccCheck();

    // Clicking the "Toxy Anti-Cheat" title toggles the animated nav menu.
    (function heroMenu() {
      const title = document.getElementById("hero-title");
      const menu = document.getElementById("hero-menu");
      const content = document.getElementById("content");
      const hero = document.getElementById("hero");
      if (!title || !menu) return;
      let open = false;

      function setOpen(state) {
        open = state;
        menu.classList.toggle("open", open);
        menu.setAttribute("aria-hidden", String(!open));
        const links = menu.querySelectorAll("a");
        links.forEach((a, i) => {
          a.style.animationDelay = open ? (i * 70) + "ms" : "0ms";
        });
      }

      title.addEventListener("click", (e) => {
        e.stopPropagation();
        setOpen(!open);
      });

      function showSection(name) {
        ["dashboard", "pccheck"].forEach((id) => {
          const s = document.getElementById(id);
          if (!s) return;
          s.classList.toggle("hidden", id !== name);
        });
      }

      menu.querySelectorAll("a").forEach((a) => {
        a.addEventListener("click", (e) => {
          const target = a.dataset.target;
          const el = target && document.getElementById(target);
          setOpen(false);
          if (el) {
            e.preventDefault();
            if (hero) hero.classList.add("locked");
            showSection(target);
            // Pre-load the newest scan report the moment the Scans/Dashboard
            // section is opened, so the report is already there (no empty panel).
            if (target === "dashboard") loadScans().then(() => {
              if (scans[0]) loadDetail(scans[0].id);
            });
            if (content && content.classList.contains("content-hidden")) {
              content.classList.remove("content-hidden");
              content.classList.add("content-visible");
              setTimeout(() => el.scrollIntoView({ behavior: "auto", block: "start" }), 80);
            } else {
              el.scrollIntoView({ behavior: "auto", block: "start" });
            }
          }
        });
      });

      document.addEventListener("click", (e) => {
        if (open && !e.target.closest(".hero")) setOpen(false);
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && open) setOpen(false);
      });

      // Home button: return to the landing hero page.
      const homeBtn = document.getElementById("home-btn");
      if (homeBtn) homeBtn.addEventListener("click", () => {
        setOpen(false);
        if (hero) hero.classList.remove("locked");
        if (content) {
          content.classList.remove("content-visible");
          content.classList.add("content-hidden");
        }
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    })();

    // Logo tilts in 3D and drifts against the mouse; the status pill stays put.
    (function mouseDrift() {
      const title = document.getElementById("hero-title");
      let tx = 0, ty = 0, txTarget = 0, tyTarget = 0;
      let rx = 0, ry = 0, rxTarget = 0, ryTarget = 0, raf = null;
      window.addEventListener("mousemove", (e) => {
        const nx = (e.clientX / window.innerWidth) - 0.5;
        const ny = (e.clientY / window.innerHeight) - 0.5;
        txTarget = -nx * 18;
        tyTarget = -ny * 18;
        rxTarget = -ny * 16;
        ryTarget = -nx * 16;
      }, { passive: true });
      function loop() {
        tx += (txTarget - tx) * 0.09;
        ty += (tyTarget - ty) * 0.09;
        rx += (rxTarget - rx) * 0.09;
        ry += (ryTarget - ry) * 0.09;
        title.style.transform = "perspective(650px) translate3d(" + tx.toFixed(2) + "px," + ty.toFixed(2) + "px,40px) rotateX(" + rx.toFixed(2) + "deg) rotateY(" + ry.toFixed(2) + "deg) scale(1.02)";
        title.style.filter = "drop-shadow(" + (-ry * 0.8).toFixed(1) + "px " + (rx * 0.8).toFixed(1) + "px 24px rgba(20,20,25,.7))";
        raf = requestAnimationFrame(loop);
      }
      loop();
    })();

    window.toggleScans = function() {
      const list = document.getElementById("scan-list");
      const hidden = document.getElementById("scan-list-hidden");
      const btn = document.getElementById("scan-toggle");
      const isHidden = !hidden.style.display || hidden.style.display === "none";
      list.style.display = isHidden ? "none" : "block";
      hidden.style.display = isHidden ? "block" : "none";
      btn.textContent = isHidden ? "Show" : "Hide";
    };

    async function loadScans() {
      const res = await fetch("/api/scans");
      const prev = scans[0]?.id;
      scans = await res.json();
      renderSummary();
      const list = document.getElementById("scan-list");
      if (!list) return;
      if (!scans.length) { list.innerHTML = '<div class="empty">No scans yet. Run: npm run scan</div>'; return; }
      list.innerHTML = scans.map(s => \`
        <button class="scan-card \${selected?.id===s.id?'active':''}" data-id="\${s.id}">
          \${isTester(s.device_name) ? testerBadge() : nameBadge(s.device_name)} <span class="risk-\${s.risk_level}">[\${(s.risk_score||0)}% \${s.risk_level.toUpperCase()}]</span><br>
          \${fmt(s.scanned_at)}<br>
          <span class="muted">\${s.program_count} programs · \${s.process_count} processes · \${s.download_count} downloads · \${s.temp_count || 0} temp · \${s.system_count || 0} system · \${s.dll_count || 0} DLLs · \${s.disk_count || 0} disk · \${s.forensics_count || 0} forensics</span>
        </button>\`).join("");
      list.querySelectorAll(".scan-card").forEach(btn => btn.onclick = () => loadDetail(btn.dataset.id));
      // New scan log dropped: jump to the newest and pop its big risk circle.
      if (scans[0] && (prev !== scans[0].id)) loadDetail(scans[0].id);
    }

    function setActive(id) {
      document.querySelectorAll(".scan-card").forEach(b => b.classList.toggle("active", b.dataset.id === id));
    }

    function ring(pct, size) {
      const s = size || 128, stroke = Math.max(8, Math.round(s / 10));
      const r = (s / 2) - stroke / 2, c = 2 * Math.PI * r;
      const off = c * (1 - pct / 100);
      const col = pct >= 50 ? "#9f2636" : pct >= 25 ? "#9a6a0e" : "#1e7a45";
      return \`<svg width="\${s}" height="\${s}" viewBox="0 0 \${s} \${s}">
        <circle cx="\${s/2}" cy="\${s/2}" r="\${r}" fill="none" stroke="rgba(148,163,184,.3)" stroke-width="\${stroke}"/>
        <circle cx="\${s/2}" cy="\${s/2}" r="\${r}" fill="none" stroke="\${col}" stroke-width="\${stroke}"
          stroke-dasharray="\${c}" stroke-dashoffset="\${off}" stroke-linecap="round"
          transform="rotate(-90 \${s/2} \${s/2})"/>
        <text x="\${s/2}" y="\${s/2 + s/28}" text-anchor="middle" font-size="\${Math.round(s/5)}" font-weight="700" fill="#9fb0cd">\${pct}%</text>
        <text x="\${s/2}" y="\${s/2 + s/9}" text-anchor="middle" font-size="\${Math.round(s/11)}" fill="#7d8ba3">cheat risk</text>
      </svg>\`;
    }

    function renderSummary() {
      const el = document.getElementById("summary");
      const total = scans.length;
      const flagged = scans.filter(s => (s.risk_score || 0) >= 25).length;
      el.innerHTML = \`<div>
        <strong>\${flagged}/\${total}</strong> PCs flagged<br>
        <span class="muted">heuristic cheat-risk scan (name/path keywords)</span>
      </div>\`;
    }

    async function loadDetail(id) {
      setActive(id);
      const res = await fetch("/api/scans/" + id);
      selected = await res.json();
      renderDetail();
    }

    function rows() {
      const q = query.trim().toLowerCase();
      const match = (arr) => arr.filter(r => JSON.stringify(r).toLowerCase().includes(q));
      if (tab === "programs") return match(selected.installedPrograms);
      if (tab === "processes") return match(selected.runningProcesses);
      if (tab === "temp") return match(selected.tempFiles || []);
      if (tab === "desktop") return match(selected.desktopFiles || []);
      if (tab === "system") return match(selected.systemFiles || []);
      if (tab === "dll") return match(selected.dllFiles || []);
      if (tab === "disk") return match(selected.diskSweep || []);
      if (tab === "flags") return selected.risk?.flags || [];
      if (tab === "prefetch") return selected.forensics?.prefetch || [];
      if (tab === "amcache") return selected.forensics?.amcache?.exes?.map((e) => ({ exe: e })) || [];
      if (tab === "shimcache") return selected.forensics?.shimcache?.map((e) => ({ exe: e })) || [];
      if (tab === "evtx") return selected.forensics?.evtx || [];
      return match(selected.downloadFiles);
    }

    function renderDetail() {
      const el = document.getElementById("detail");
      if (!selected) { el.innerHTML = '<div class="empty">Select a scan.</div>'; return; }
      const all = rows();
      const MAX_ROWS = 400;
      const data = all.length > MAX_ROWS ? all.slice(0, MAX_ROWS) : all;
      const truncated = all.length > MAX_ROWS;
      const r = selected.risk || {};
      const rcol = r.level;
      el.innerHTML = \`
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center">
          <button class="hidebtn" id="share-btn" onclick="copyShareLink()">Copy share link</button>
          <a class="hidebtn" style="display:inline-flex;align-items:center;text-decoration:none" href="/r/\${selected.id}" target="_blank" rel="noopener">Open public page →</a>
        </div>
        <div class="meta">
          <div><span class="muted">Device</span><br>\${isTester(selected.device_name) ? testerBadge() : nameBadge(selected.device_name)}</div>
          <div><span class="muted">Device ID</span><br><strong>\${selected.device_id}</strong></div>
          <div><span class="muted">Scanned</span><br><strong>\${fmt(selected.scanned_at)}</strong></div>
          <div><span class="muted">Consent</span><br><span class="badge">\${selected.consent_given ? "Given" : "Missing"}</span></div>
        </div>
        <div class="riskbig \${r.level || 'low'}">
          <div class="riskbig-circle">\${ring((r.score || 0), 200)}</div>
          <div class="riskbig-label">
            <div class="riskbig-title">\${r.score >= 50 ? "High cheat risk" : r.score >= 25 ? "Moderate risk" : "Looks clean"}</div>
            <div class="muted">\${isTester(selected.device_name) ? testerBadge() : nameBadge(selected.device_name)} · \${(r.flags || []).length} flagged items</div>
          </div>
        </div>
        <div class="pbar"><div class="pbar-in \${rcol || 'low'}" style="width:\${r.score || 0}%"></div></div>
        <div class="tabs">
          <button class="\${tab==='programs'?'active':''}" onclick="setTab('programs')">Installed Programs</button>
          <button class="\${tab==='processes'?'active':''}" onclick="setTab('processes')">Running Processes</button>
          <button class="\${tab==='downloads'?'active':''}" onclick="setTab('downloads')">Downloads Folder</button>
          <button class="\${tab==='temp'?'active':''}" onclick="setTab('temp')">Temp Files</button>
          <button class="\${tab==='desktop'?'active':''}" onclick="setTab('desktop')">Desktop</button>
          <button class="\${tab==='system'?'active':''}" onclick="setTab('system')">System (AppData/Prog/Recycle)</button>
          <button class="\${tab==='dll'?'active':''}" onclick="setTab('dll')">DLL Files</button>
          <button class="\${tab==='disk'?'active':''}" onclick="setTab('disk')">This PC / Disks</button>
          <button class="\${tab==='prefetch'?'active':''}" onclick="setTab('prefetch')">Prefetch</button>
          <button class="\${tab==='amcache'?'active':''}" onclick="setTab('amcache')">Amcache</button>
          <button class="\${tab==='shimcache'?'active':''}" onclick="setTab('shimcache')">ShimCache</button>
          <button class="\${tab==='evtx'?'active':''}" onclick="setTab('evtx')">Event Logs</button>
          <button class="\${tab==='flags'?'active':''}" onclick="setTab('flags')">Cheat Flags</button>
        </div>
        <input placeholder="Filter..." value="\${query}" oninput="setQuery(this.value)" />
        <div style="overflow:auto">
          \${tab === 'programs' ? \`
            <table><thead><tr><th>Name</th><th>Version</th><th>Publisher</th><th>Install Date</th></tr></thead>
            <tbody>\${data.map(r => \`<tr><td>\${r.name}</td><td>\${r.version||'—'}</td><td>\${r.publisher||'—'}</td><td>\${r.install_date||'—'}</td></tr>\`).join('')}</tbody></table>\` : ''}
          \${tab === 'processes' ? \`
            <table><thead><tr><th>Name</th><th>PID</th><th>Path</th><th>Started</th></tr></thead>
            <tbody>\${data.map(r => \`<tr><td>\${r.name}</td><td>\${r.pid}</td><td>\${r.path||'—'}</td><td>\${fmt(r.started_at)}</td></tr>\`).join('')}</tbody></table>\` : ''}
          \${tab === 'downloads' ? \`
            <table><thead><tr><th>Name</th><th>Path</th><th>Size</th><th>Modified</th></tr></thead>
            <tbody>\${data.map(r => \`<tr><td>\${r.name}</td><td>\${r.path}</td><td>\${bytes(r.size_bytes)}</td><td>\${fmt(r.modified_at)}</td></tr>\`).join('')}</tbody></table>\` : ''}
          \${tab === 'temp' ? \`
            <table><thead><tr><th>Name</th><th>Path</th><th>Size</th><th>Modified</th></tr></thead>
            <tbody>\${data.map(r => \`<tr><td>\${r.name}</td><td>\${r.path}</td><td>\${bytes(r.size_bytes)}</td><td>\${fmt(r.modified_at)}</td></tr>\`).join('')}</tbody></table>\` : ''}
          \${tab === 'desktop' ? \`
            <table><thead><tr><th>Name</th><th>Path</th><th>Size</th><th>Modified</th></tr></thead>
            <tbody>\${data.map(r => \`<tr><td>\${r.name}</td><td>\${r.path}</td><td>\${bytes(r.size_bytes)}</td><td>\${fmt(r.modified_at)}</td></tr>\`).join('')}</tbody></table>\` : ''}
          \${tab === 'system' ? \`
            <table><thead><tr><th>Name</th><th>Path</th><th>Size</th><th>Modified</th></tr></thead>
            <tbody>\${data.map(r => \`<tr><td>\${r.name}</td><td>\${r.path}</td><td>\${bytes(r.size_bytes)}</td><td>\${fmt(r.modified_at)}</td></tr>\`).join('')}</tbody></table>\` : ''}
          \${tab === 'dll' ? \`
            <table><thead><tr><th>Name</th><th>Path</th><th>Size</th><th>Modified</th></tr></thead>
            <tbody>\${data.map(r => \`<tr><td>\${r.name}</td><td>\${r.path}</td><td>\${bytes(r.size_bytes)}</td><td>\${fmt(r.modified_at)}</td></tr>\`).join('')}</tbody></table>\` : ''}
          \${tab === 'disk' ? \`
            <table><thead><tr><th>Name</th><th>Path</th><th>Size</th><th>Modified</th></tr></thead>
            <tbody>\${data.map(r => \`<tr><td>\${r.name}</td><td>\${r.path}</td><td>\${bytes(r.size_bytes)}</td><td>\${fmt(r.modified_at)}</td></tr>\`).join('')}</tbody></table>\` : ''}
          \${tab === 'flags' ? \`
            <table><thead><tr><th>Type</th><th>Name</th><th>Path</th><th>Reason</th></tr></thead>
            <tbody>\${data.map(r => \`<tr><td class="risk-\${selected.risk?.level || 'low'}">\${r.type}</td><td>\${r.name}</td><td>\${r.path || '—'}</td><td>\${r.reason}</td></tr>\`).join('')}</tbody></table>\` : ''}
          \${tab === 'prefetch' ? \`
            <table><thead><tr><th>Exe</th><th>File</th><th>Size</th><th>Modified</th></tr></thead>
            <tbody>\${data.map(r => \`<tr><td>\${r.exe || '—'}</td><td>\${r.name || '—'}</td><td>\${bytes(r.size_bytes)}</td><td>\${fmt(r.modified_at)}</td></tr>\`).join('')}</tbody></table>\` : ''}
          \${tab === 'amcache' ? \`
            <div class="muted" style="margin-bottom:8px">\${selected.forensics?.amcache?.present ? 'Amcache hive present' : 'Amcache hive not present/accessible'}\${selected.forensics?.amcache?.size_bytes != null ? ' · ' + bytes(selected.forensics.amcache.size_bytes) : ''}</div>
            <table><thead><tr><th>Executable path</th></tr></thead>
            <tbody>\${data.map(r => \`<tr><td>\${r.exe}</td></tr>\`).join('')}</tbody></table>\` : ''}
          \${tab === 'shimcache' ? \`
            <table><thead><tr><th>Executable path</th></tr></thead>
            <tbody>\${data.map(r => \`<tr><td>\${r.exe}</td></tr>\`).join('')}</tbody></table>\` : ''}
          \${tab === 'evtx' ? \`
            <table><thead><tr><th>Log</th><th>ID</th><th>Level</th><th>Time</th><th>Message</th></tr></thead>
            <tbody>\${data.map(r => \`<tr><td>\${r.log}</td><td>\${r.id ?? '—'}</td><td>\${r.level || '—'}</td><td>\${fmt(r.time)}</td><td>\${r.message || '—'}</td></tr>\`).join('')}</tbody></table>\` : ''}
        </div>
        \${truncated ? '<div class="muted" style="margin:8px 0">Showing first ' + MAX_ROWS + ' of ' + all.length + ' rows — filter to narrow down.</div>' : ''}
        \${data.length ? '' : '<div class="empty">No rows match.</div>'}\`;
    }

    window.setTab = (t) => { tab = t; renderDetail(); };
    window.setQuery = (q) => {
      query = q;
      renderDetail();
      const el = document.querySelector('input[placeholder="Filter..."]');
      if (el) { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch { } }
    };

    function copyShareLink() {
      const url = location.origin + "/r/" + selected.id;
      const done = () => {
        const b = document.getElementById("share-btn");
        if (b) { b.textContent = "Link copied!"; setTimeout(() => { b.textContent = "Copy share link"; }, 1800); }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, done);
      else {
        const ta = document.createElement("textarea");
        ta.value = url; document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); } catch { }
        ta.remove(); done();
      }
    }

    loadScans();
    // Live: watch for new scan logs and pop the big cheat-risk circle.
    setInterval(loadScans, 5000);
  </script>
</body>
</html>`;
}

function escHtml(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Public, shareable read-only results page for a single scan (toxy.lol/r/:id).
function resultPageHtml(scan) {
  const risk = scan.risk || { score: 0, level: "low", flags: [] };
  const score = risk.score || 0;
  const level = risk.level || "low";
  const col = level === "high" ? "#7f1d1d" : level === "medium" ? "#78350f" : "#14532d";
  const dim = level === "high" ? "rgba(127,29,29,.14)" : level === "medium" ? "rgba(120,53,15,.14)" : "rgba(20,83,45,.13)";
  const title = score >= 50 ? "High cheat risk" : score >= 25 ? "Moderate risk" : "Looks clean";
  const flags = risk.flags || [];
  const rows = flags
    .map((f) => `<tr><td><span class="pill t-${escHtml(f.type || "?")}">${escHtml(f.type || "—")}</span></td><td>${escHtml(f.name || "—")}</td><td class="mono">${escHtml(f.path || "—")}</td><td>${escHtml(f.reason || "")}</td></tr>`)
    .join("");
  const stats = [
    ["Programs", scan.installedPrograms?.length || 0],
    ["Processes", scan.runningProcesses?.length || 0],
    ["Downloads", scan.downloadFiles?.length || 0],
    ["Temp files", scan.tempFiles?.length || 0],
    ["Desktop", scan.desktopFiles?.length || 0],
    ["System", scan.systemFiles?.length || 0],
    ["DLLs", scan.dllFiles?.length || 0],
    ["Disk", scan.diskSweep?.length || 0],
  ]
    .map(([label, n]) => `<div class="stat"><div class="num">${n}</div><div class="lab">${label}</div></div>`)
    .join("");
  const barW = Math.max(4, Math.min(100, score));
  const verdict = flags.length
    ? `<div class="flags">
         <div class="flags-title">${flags.length} flagged item${flags.length > 1 ? "s" : ""}</div>
         <div class="flags-wrap">
           <table><thead><tr><th>Type</th><th>Name</th><th>Path</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table>
         </div>
       </div>`
    : `<div class="clean"><svg width="26" height="26" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="11" fill="#14532d" opacity=".2"/><path d="M7 12.5l3 3 7-7" stroke="#14532d" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg><div><div class="clean-title">All clear</div><div class="clean-sub">No suspicious files, processes, or traces found.</div></div></div>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex"/>
<title>Scan result — ${escHtml(scan.device_name || "PC")}</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; font-family: Inter, Segoe UI, system-ui, sans-serif; min-height:100vh; color:#e8edf5; display:flex; align-items:center; justify-content:center; padding:28px;
    background:#0d1524; background-image: radial-gradient(1000px 600px at 20% -10%, rgba(56,130,246,.25), transparent 60%), radial-gradient(900px 600px at 105% 110%, rgba(94,140,220,.18), transparent 60%); }
  .card { width:100%; max-width:720px; background:rgba(20,32,54,.45); border:1px solid rgba(148,163,184,.22); border-radius:20px; padding:34px 36px;
    box-shadow: 0 30px 80px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.05); backdrop-filter: blur(6px); }
  .head { display:flex; align-items:center; justify-content:space-between; gap:14px; margin-bottom:26px; }
  .brand { display:flex; align-items:center; gap:12px; }
  .brand img { height:40px; width:40px; border-radius:10px; object-fit:cover; box-shadow:0 0 8px rgba(90,140,220,.2); }
  .brand .nm { font-weight:800; letter-spacing:2px; color:#93b6e2; font-size:15px; }
  .brand .lo { font-size:11px; color:#64748b; letter-spacing:1px; }
  .pill-consent { font-size:11px; font-weight:700; letter-spacing:1px; color:#14532d; padding:6px 12px; border-radius:999px; background:rgba(20,53,45,.22); border:1px solid rgba(20,83,45,.5); white-space:nowrap; }
  h1 { margin:0; font-size:28px; line-height:1.15; }
  .when { color:#94a3b8; font-size:13px; margin-top:4px; }
  .scorecard { display:grid; grid-template-columns:190px 1fr; gap:22px; align-items:center; padding:20px; border-radius:16px; border:1px solid rgba(148,163,184,.18); background:rgba(255,255,255,.03); margin:22px 0; }
  .scorenum { font-size:58px; font-weight:900; line-height:1; letter-spacing:-2px; }
  .scorelab { font-size:13px; letter-spacing:2px; text-transform:uppercase; margin-top:4px; }
  .scorebar { height:9px; border-radius:999px; background:rgba(148,163,184,.18); overflow:hidden; margin-top:16px; }
  .scorebar i { display:block; height:100%; border-radius:999px; background:${col}; box-shadow:0 0 4px ${col}44; transition:width .6s ease; }
  .grades { display:flex; justify-content:space-between; font-size:11px; color:#7d8ba3; margin-top:6px; }
  .clean { display:flex; gap:14px; align-items:center; padding:18px 20px; border-radius:14px; background:rgba(20,83,45,.09); border:1px solid rgba(20,83,45,.35); }
  .clean-title { font-weight:800; font-size:17px; color:#14532d; }
  .clean-sub { color:#94a3b8; font-size:13px; margin-top:2px; }
  .flags-title { font-weight:700; margin-bottom:10px; color:#78350f; }
  .flags-wrap { max-height:340px; overflow:auto; border:1px solid rgba(148,163,184,.18); border-radius:12px; background:rgba(255,255,255,.02); }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:10px 12px; border-bottom:1px solid rgba(148,163,184,.14); vertical-align:top; font-size:13px; }
  th { color:#7b8ba3; font-size:11px; letter-spacing:1px; text-transform:uppercase; position:sticky; top:0; background:#152036; }
  .mono { font-family:Consolas, monospace; font-size:12px; color:#cbd5e1; word-break:break-all; }
  .pill { display:inline-block; font-size:11px; font-weight:700; padding:3px 9px; border-radius:999px; text-transform:uppercase; letter-spacing:.5px; background:rgba(148,163,184,.15); color:#cbd5e1; border:1px solid rgba(148,163,184,.3); }
  .stats { display:grid; grid-template-columns:repeat(4, 1fr); gap:10px; margin-top:22px; }
  .stat { text-align:center; padding:14px 8px; border-radius:12px; background:rgba(255,255,255,.035); border:1px solid rgba(148,163,184,.16); }
  .stat .num { font-size:22px; font-weight:800; color:#93b6e2; }
  .stat .lab { font-size:11px; color:#7b8ba3; margin-top:3px; letter-spacing:.5px; }
  .foot { margin-top:26px; color:#5a6b85; font-size:12px; text-align:center; }
  @media (max-width:700px) {
    .card { padding:24px 20px; }
    .scorecard { grid-template-columns:1fr; row-gap:6px; text-align:center; }
    .scorenum { font-size:46px; }
    .stats { grid-template-columns:repeat(2,1fr); }
    .when { text-align:center; }
    .head { flex-direction:column; align-items:flex-start; }
  }
</style></head><body>
  <div class="card">
    <div class="head">
      <div class="brand"><img src="/logo" alt=""/><div><div class="nm">TOXY ANTI-CHEAT</div><div class="lo">integrity check</div></div></div>
      <span class="pill-consent">consented scan</span>
    </div>
    <h1>${escHtml(scan.device_name || "Unnamed device")}</h1>
    <div class="when">Scanned ${new Date(scan.scanned_at || new Date()).toLocaleString()}</div>
    <div class="scorecard">
      <div>
        <div class="scorenum" style="color:${col}">${score}%</div>
        <div class="scorelab" style="color:${col}">${title}</div>
      </div>
      <div>
        <div class="scorebar"><i style="width:${barW}%"></i></div>
        <div class="grades"><span>0 clean</span><span>25</span><span>50 high</span><span>100</span></div>
      </div>
    </div>
    ${verdict}
    <div class="stats">${stats}</div>
    <div class="foot">Generated by Toxy Anti-Cheat · consent-based integrity review · no personal data stored beyond scan contents</div>
  </div>
</body></html>`;
}

function startServer() {
  const app = express();
  app.use(express.json({ limit: "80mb" }));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/logo", (_req, res) => {
    if (!fs.existsSync(LOGO)) return res.status(404).type("text/plain").send("Logo not found.");
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(LOGO).pipe(res);
  });
  app.get("/background", (_req, res) => {
    if (!fs.existsSync(BG_VIDEO)) return res.status(404).type("text/plain").send("Background video not found.");
    const stat = fs.statSync(BG_VIDEO);
    const total = stat.size;
    const range = _req.headers.range;
    // Enable browser streaming/buffering with HTTP byte ranges and let the
    // tunnel/browser cache it, so the 4K background doesn't freeze.
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "public, max-age=86400");
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (start >= total || start > end) {
        res.status(416).setHeader("Content-Range", `bytes */${total}`).end();
        return;
      }
      res.status(206).setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
      res.setHeader("Content-Length", end - start + 1);
      fs.createReadStream(BG_VIDEO, { start, end }).pipe(res);
    } else {
      res.setHeader("Content-Length", total);
      fs.createReadStream(BG_VIDEO).pipe(res);
    }
  });
  app.get("/api/pc-check/status", (_req, res) => res.json(pcCheckStatus()));
  app.post("/api/pc-check/build", (_req, res) => {
    if (pcCheckState.building) {
      return res.status(409).json({ error: "A build is already in progress.", ...pcCheckStatus() });
    }
    buildPcCheck();
    res.json({ started: true, ...pcCheckStatus() });
  });
  app.get("/api/pc-check/download", (req, res) => {
    if (!fs.existsSync(EXE_PATH)) {
      return res.status(404).json({ error: "The exe has not been built yet." });
    }
    const name = String(req.query.name ?? "").trim();
    if (name && name.length <= 40 && /^[A-Za-z0-9 _.-]+$/.test(name)) {
      const zip = buildZip([
        { name: "PC_Check_Scan.exe", data: fs.readFileSync(EXE_PATH) },
        { name: "scan-name.txt", data: Buffer.from(name, "utf8") },
      ]);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="PC_Check_Scan_${name.replace(/[^A-Za-z0-9_]/g, "_")}.zip"`);
      return res.send(zip);
    }
    res.download(EXE_PATH, "PC_Check_Scan.exe");
  });
  app.get("/api/scans", (_req, res) => res.json(listScans()));
  app.get("/api/scans/:id", (req, res) => {
    const scan = getScan(req.params.id);
    if (!scan) return res.status(404).json({ error: "Scan not found." });
    res.json(scan);
  });
  app.post("/api/scans", (req, res) => {
    const error = validateScanPayload(req.body);
    if (error) return res.status(400).json({ error });
    const scan = {
      id: uuidv4(),
      deviceId: req.body.deviceId,
      deviceName: req.body.deviceName,
      consentGiven: true,
      scannedAt: req.body.scannedAt || new Date().toISOString(),
      installedPrograms: req.body.installedPrograms,
      runningProcesses: req.body.runningProcesses,
      downloadFiles: req.body.downloadFiles,
      tempFiles: req.body.tempFiles,
      desktopFiles: req.body.desktopFiles,
      systemFiles: req.body.systemFiles,
      dllFiles: req.body.dllFiles,
      diskSweep: req.body.diskSweep,
      forensics: req.body.forensics,
    };
    insertScan(scan);
    res.status(201).json({ id: scan.id, message: "Scan stored." });
  });
  app.get("/r/:id", (req, res) => {
    const scan = getScan(req.params.id);
    if (!scan) return res.status(404).type("text/plain").send("Scan not found.");
    res.type("html").send(resultPageHtml(scan));
  });
  app.get("/", (_req, res) => res.type("html").send(dashboardHtml()));

  app.listen(PORT, () => {
    console.log(`PC Integrity Checker running at http://localhost:${PORT}`);
    console.log(`Dashboard: http://localhost:${PORT}`);
    console.log(`Run a scan:  npm run scan`);
  });
}

async function runPowerShell(script) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { maxBuffer: 20 * 1024 * 1024 }
  );
  return stdout.trim();
}

function normalizeInstallDate(raw) {
  if (!raw || raw.length !== 8) return raw || null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

async function getInstalledPrograms() {
  if (process.platform !== "win32") return [];
  const script = `
    $paths = @(
      'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
      'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
      'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
    )
    $items = foreach ($p in $paths) {
      Get-ItemProperty $p -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -and $_.SystemComponent -ne 1 } |
        Select-Object @{n='name';e={$_.DisplayName}}, @{n='version';e={$_.DisplayVersion}}, @{n='publisher';e={$_.Publisher}}, @{n='installDate';e={$_.InstallDate}}
    }
    $items | Sort-Object name -Unique | ConvertTo-Json -Compress
  `;
  const out = await runPowerShell(script);
  if (!out) return [];
  const parsed = JSON.parse(out);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((r) => ({
    name: r.name,
    version: r.version || null,
    publisher: r.publisher || null,
    installDate: normalizeInstallDate(r.installDate),
  }));
}

async function getRunningProcesses() {
  if (process.platform !== "win32") return [];
  const script = `
    Get-Process | ForEach-Object {
      $path = $null
      try { $path = $_.Path } catch {}
      [PSCustomObject]@{
        name = $_.ProcessName
        pid = $_.Id
        path = $path
        startedAt = if ($_.StartTime) { $_.StartTime.ToUniversalTime().ToString('o') } else { $null }
      }
    } | ConvertTo-Json -Compress
  `;
  const out = await runPowerShell(script);
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function getDownloadFiles() {
  const downloads = path.join(os.homedir(), "Downloads");
  if (!fs.existsSync(downloads)) return [];
  return collectTrackedFiles([downloads], FILE_SCAN_LIMIT);
}

function getTempFiles() {
  const candidates = [];
  if (process.env.TEMP) candidates.push(process.env.TEMP);
  if (process.env.TMP) candidates.push(process.env.TMP);
  const localTemp = path.join(os.homedir(), "AppData", "Local", "Temp");
  candidates.push(localTemp);

  const uniqueCandidates = [...new Set(candidates)].filter((p) => fs.existsSync(p));
  return collectTrackedFiles(uniqueCandidates, FILE_SCAN_LIMIT);
}

function getDesktopFiles() {
  const desktop = path.join(os.homedir(), "Desktop");
  const oneDriveDesktop = path.join(os.homedir(), "OneDrive", "Desktop");
  const dirs = [desktop, oneDriveDesktop].filter((p) => fs.existsSync(p));
  return collectTrackedFiles(dirs, FILE_SCAN_LIMIT);
}

function getSystemFiles() {
  const dirs = [];
  if (process.env.APPDATA) dirs.push(process.env.APPDATA);
  if (process.env.LOCALAPPDATA) dirs.push(process.env.LOCALAPPDATA);
  if (process.env.ProgramFiles) dirs.push(process.env.ProgramFiles);
  if (process.env["ProgramFiles(x86)"]) dirs.push(process.env["ProgramFiles(x86)"]);
  if (process.env.WINDIR) dirs.push(process.env.WINDIR);
  if (process.env.ProgramData) dirs.push(process.env.ProgramData);

  // The user's own folders.
  const home = os.homedir();
  for (const sub of ["Documents", "Pictures", "Music", "Videos", "OneDrive", "Downloads"]) {
    const p = path.join(home, sub);
    if (fs.existsSync(p)) dirs.push(p);
  }

  for (const drive of getFixedDrives()) {
    dirs.push(path.join(drive, "$Recycle.Bin"));
  }

  const uniqueDirs = [...new Set(dirs)].filter((p) => p && fs.existsSync(p));
  return collectTrackedFiles(uniqueDirs, FILE_SCAN_LIMIT, SKIP_DIRS);
}

function getFixedDrives() {
  const drives = [];
  for (let code = 67; code <= 90; code++) {
    const drive = `${String.fromCharCode(code)}:`;
    try {
      if (fs.statSync(drive).isDirectory()) drives.push(drive);
    } catch {
      // No such drive.
    }
  }
  if (!drives.length) drives.push(process.env.SystemDrive || "C:");
  return drives;
}

function driveRoots() {
  return getFixedDrives().map((d) => (d.endsWith("\\") ? d : d + "\\")).filter((p) => fs.existsSync(p));
}

const DLL_EXTENSIONS = new Set([".dll", ".sys", ".drv", ".ocx"]);
const DLL_SWEEP_LIMIT = Number(process.env.DLL_SCAN_LIMIT || 20000);

const DLL_SKIP_DIRS = new Set([
  "Packages", "PackageCache", "packages", "node_modules",
  "npm-cache", "pnpm-cache", "yarn", "nuget", "__pycache__",
  "Installer", "WindowsApps", ".git", "cache", "Cache", "Caches",
  "$Recycle.Bin", "System Volume Information", "Recovery", "Config.Msi",
]);

function getDllFiles() {
  return collectTrackedFiles(driveRoots(), DLL_SWEEP_LIMIT, DLL_SKIP_DIRS, DLL_EXTENSIONS);
}

function getDiskSweep() {
  const limit = Number(process.env.DISK_SCAN_LIMIT || 6000);
  return collectTrackedFiles(driveRoots(), limit, DISK_SKIP_DIRS);
}

function collectTrackedFiles(rootDirs, maxFiles, skipDirs = new Set(), extensions = TRACKED_EXTENSIONS) {
  const out = [];
  const queue = [...rootDirs];
  const seen = new Set();

  while (queue.length > 0 && out.length < maxFiles) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);

    let dirEntries = [];
    try {
      dirEntries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of dirEntries) {
      if (out.length >= maxFiles) break;
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        queue.push(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!extensions.has(path.extname(entry.name).toLowerCase())) continue;

      try {
        const stat = fs.statSync(fullPath);
        out.push({
          name: entry.name,
          path: fullPath,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        });
      } catch {
        // Ignore unreadable files.
      }
    }
  }

  return out.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
}

async function getDeviceId() {
  if (process.platform === "win32") {
    try {
      const out = await runPowerShell(
        "(Get-CimInstance Win32_ComputerSystemProduct).UUID"
      );
      if (out) return out;
    } catch {
      // fallback below
    }
  }
  return `${os.hostname()}-${os.userInfo().username}`.toLowerCase();
}

// Forensics artifacts: Prefetch, Amcache, ShimCache and event logs. These catch
// programs that RAN (even ones the user deleted afterwards) and other traces.
// Best-effort: anything requiring admin rights degrades gracefully to empty.
async function getForensics() {
  if (process.platform !== "win32") {
    return { prefetch: [], amcache: { present: false }, shimcache: [], evtx: [] };
  }
  const script = `
$r = [ordered]@{}
$pf = @(Get-ChildItem $env:WINDIR\\Prefetch -Filter *.pf -ErrorAction SilentlyContinue | ForEach-Object { $e = ($_.BaseName -split '-')[0]; [PSCustomObject]@{ name=$_.Name; exe=$e; size_bytes=$_.Length; modified_at=$_.LastWriteTime.ToUniversalTime().ToString('o') } } | Select-Object -First 300)
$r.prefetch = $pf
$amPath = Join-Path $env:WINDIR 'AppCompat\\Programs\\Amcache.hve'
$amExes = @()
if (Test-Path $amPath -ErrorAction SilentlyContinue) {
  try {
    $fi = Get-Item $amPath
    if ($fi.Length -lt 100MB) {
      $bytes = [System.IO.File]::ReadAllBytes($amPath)
      $u = [System.Text.Encoding]::Unicode.GetString($bytes)
      $amExes = @([regex]::Matches($u, '[ -~]{3,}\\.exe') | ForEach-Object { $_.Value } | Select-Object -Unique | Select-Object -First 200)
    }
    $r.amcache = [PSCustomObject]@{ present=$true; path=$amPath; size_bytes=$fi.Length; modified_at=$fi.LastWriteTime.ToUniversalTime().ToString('o'); exes=$amExes }
  } catch { $r.amcache = [PSCustomObject]@{ present=$false } }
} else { $r.amcache = [PSCustomObject]@{ present=$false } }
$shim = @()
try {
  $sb = (Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\AppCompatCache' -ErrorAction Stop).AppCompatCache
  if ($sb) {
    $a = [System.Text.Encoding]::ASCII.GetString($sb)
    $u2 = [System.Text.Encoding]::Unicode.GetString($sb)
    $shim = @(([regex]::Matches($a, '[ -~]{4,}\\.exe') | ForEach-Object { $_.Value }) + ([regex]::Matches($u2, '[ -~]{3,}\\.exe') | ForEach-Object { $_.Value }) | Select-Object -Unique | Select-Object -First 200)
  }
} catch {}
$r.shimcache = $shim
$ev = @()
foreach ($log in @('Microsoft-Windows-PowerShell/Operational','Security','System')) {
  $events = @(Get-WinEvent -LogName $log -MaxEvents 60 -ErrorAction SilentlyContinue)
  foreach ($e in $events) {
    $msg = (($e | Out-String) -replace '\\s+',' ').Trim()
    if ($msg.Length -gt 400) { $msg = $msg.Substring(0,400) }
    $ev += [PSCustomObject]@{ log=$log; id=$e.Id; level=$e.LevelDisplayName; time=$e.TimeCreated.ToUniversalTime().ToString('o'); message=$msg }
  }
}
$r.evtx = $ev
$r | ConvertTo-Json -Depth 5 -Compress
`;
  const out = await runPowerShell(script);
  if (!out) return { prefetch: [], amcache: { present: false }, shimcache: [], evtx: [] };
  try {
    const parsed = JSON.parse(out);
    return {
      prefetch: Array.isArray(parsed.prefetch) ? parsed.prefetch : [],
      amcache: parsed.amcache || { present: false },
      shimcache: Array.isArray(parsed.shimcache) ? parsed.shimcache : [],
      evtx: Array.isArray(parsed.evtx) ? parsed.evtx : [],
    };
  } catch {
    return { prefetch: [], amcache: { present: false }, shimcache: [], evtx: [] };
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function runScan() {
  console.log("\n=== PC Integrity Checker (Scan Mode) ===\n");
  console.log("This scan collects ONLY:");
  console.log("  - Installed programs (Windows registry)");
  console.log("  - Currently running processes");
  console.log("  - Executable/archive files in your Downloads folder");
  console.log("  - Executable/archive files in Temp folders\n");
  console.log("It does NOT scan your entire disk or personal files.\n");

  const answer = (await ask("Type YES to consent and start the scan: ")).trim();
  if (answer.toUpperCase() !== "YES") {
    console.log("Scan cancelled. Consent was not given.");
    process.exit(0);
  }

  console.log("\nScanning...");
  const payload = {
    deviceId: await getDeviceId(),
    deviceName: os.hostname(),
    consentGiven: true,
    scannedAt: new Date().toISOString(),
    installedPrograms: await getInstalledPrograms(),
    runningProcesses: await getRunningProcesses(),
    downloadFiles: getDownloadFiles(),
    tempFiles: getTempFiles(),
    desktopFiles: getDesktopFiles(),
    systemFiles: getSystemFiles(),
    dllFiles: getDllFiles(),
    diskSweep: getDiskSweep(),
    forensics: await getForensics(),
  };

  console.log(`Found ${payload.installedPrograms.length} programs, ${payload.runningProcesses.length} processes, ${payload.downloadFiles.length} download files, ${payload.tempFiles.length} temp files, ${payload.desktopFiles.length} desktop files, ${payload.systemFiles.length} system files, ${(payload.dllFiles || []).length} DLL files, ${(payload.diskSweep || []).length} disk files, ${(payload.forensics.prefetch || []).length} prefetch entries.`);
  console.log(`Uploading to ${API_URL} ...`);

  const response = await fetch(`${API_URL}/api/scans`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const body = await response.json();
  if (!response.ok) {
    console.error("Upload failed:", body.error || body);
    process.exit(1);
  }

  console.log(`\nScan complete! ID: ${body.id}`);
  console.log(`Open dashboard: ${API_URL}`);
}

const mode = process.argv[2];
if (mode === "scan") {
  runScan().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  startServer();
}
