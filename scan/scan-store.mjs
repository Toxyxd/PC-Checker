// Shared scan storage + scoring for the opensource dashboard.
// Mirrors the logic in index.js so both servers write identical scan files.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCANS_DIR =
  process.env.SCANS_DIR ||
  path.join(__dirname, "..", "data", "scans");

if (!fs.existsSync(SCANS_DIR)) {
  fs.mkdirSync(SCANS_DIR, { recursive: true });
}

export function scanFilePath(scanId) {
  return path.join(SCANS_DIR, `${scanId}.json`);
}

function writeJsonAtomic(filePath, obj) {
  const tmpPath = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

export function validateScanPayload(body) {
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

export function toStoredScan(scan) {
  const stored = {
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
  stored.risk = analyzeRisk(stored);
  return stored;
}

export function insertScan(scan) {
  const stored = toStoredScan(scan);
  writeJsonAtomic(scanFilePath(scan.id), stored);
  return stored;
}

export function getScan(scanId) {
  const filePath = scanFilePath(scanId);
  if (!fs.existsSync(filePath)) return null;
  const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return { ...stored, risk: stored.risk || analyzeRisk(stored) };
}

export function listScans() {
  if (!fs.existsSync(SCANS_DIR)) return [];
  const scans = fs
    .readdirSync(SCANS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(SCANS_DIR, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.scanned_at) - new Date(a.scanned_at));
  return scans.map((s) => {
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
}

// Heuristic cheat detection, identical to index.js.
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

export function analyzeRisk(scan) {
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

export function makeScanId() {
  return uuidv4();
}