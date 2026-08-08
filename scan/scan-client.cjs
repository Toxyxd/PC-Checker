const { execFile, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const FILE_SCAN_LIMIT = Number(process.env.FILE_SCAN_LIMIT || 6000);
const TRACKED_EXTENSIONS = new Set([
  ".exe", ".msi", ".bat", ".cmd", ".com", ".scr", ".pif",
  ".zip", ".rar", ".7z", ".jar",
  ".dll", ".sys", ".drv", ".ocx",
  ".js", ".vbs", ".vbe", ".ps1", ".reg", ".cfg", ".ini",
]);

// Build-time default target. scripts/build-scan-exe.ps1 replaces the token.
// Override per-PC with the API_URL env var.
const DEFAULT_API_URL = "__SCAN_API_URL__";
const API_URL = process.env.API_URL || DEFAULT_API_URL;

// Custom name override. If the download was built with a name (the "name" field on
// the pc-check site), the exe ships next to a scan-name.txt and the dashboard shows
// that name instead of the PC's hostname. SCAN_NAME env var wins first.
function resolveScanName() {
  try {
    if (process.env.SCAN_NAME && process.env.SCAN_NAME.trim()) return process.env.SCAN_NAME.trim();
    const dir = path.dirname(process.execPath);
    for (const f of ["scan-name.txt", "scan-name.json"]) {
      const p = path.join(dir, f);
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, "utf8").trim();
        const val = f.endsWith(".json") ? (() => { try { const o = JSON.parse(raw); return String(o.name ?? "").trim(); } catch { return raw; } })() : raw;
        if (val) return val;
      }
    }
  } catch { /* fall through */ }
  return null;
}
const DEVICE_NAME = resolveScanName() || os.hostname();

async function runPowerShell(script) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { maxBuffer: 20 * 1024 * 1024, windowsHide: true }
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

// Subdirectories too noisy/slow to recurse into during a system-wide sweep.
const SKIP_DIRS = new Set([
  "Packages", "PackageCache", "packages", "node_modules",
  "npm-cache", "pnpm-cache", "yarn", "nuget", "__pycache__",
  "Windows", "System32", "SysWOW64", "AppReadiness", "assembly",
  "Installer", "WindowsApps", "ServicePackInstall",
  ".git", "cache", "Cache", "Caches",
]);

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

function getDesktopFiles() {
  const desktop = path.join(os.homedir(), "Desktop");
  const oneDriveDesktop = path.join(os.homedir(), "OneDrive", "Desktop");
  const dirs = [desktop, oneDriveDesktop].filter((p) => fs.existsSync(p));
  return collectTrackedFiles(dirs, FILE_SCAN_LIMIT);
}

// Deep sweep of AppData (Roaming + Local), Program Files, the Recycle Bin
// and the user's other folders where cheat loaders/injectors hide.
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

  // Recycle Bins on every fixed drive.
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

// getFixedDrives() returns "C:" (no trailing slash), which Node resolves to the
// *current working directory* on that drive. As a scan root we want the drive
// root, so normalise to "C:\\".
function driveRoots() {
  return getFixedDrives().map((d) => (d.endsWith("\\") ? d : d + "\\")).filter((p) => fs.existsSync(p));
}

// Dynamically-linked libraries: every DLL/OCX/SYS/DRV on all fixed drives,
// INCLUDING the system folders (System32, SysWOW64, Program Files) where cheat
// loaders and injectors are largely served from. Only the heaviest pure-cache
// dirs are skipped so the cap isn't wasted.
const DLL_EXTENSIONS = new Set([".dll", ".sys", ".drv", ".ocx"]);
const DLL_SWEEP_LIMIT = Number(process.env.DLL_SCAN_LIMIT || 20000);

const DLL_SKIP_DIRS = new Set([
  "Packages", "PackageCache", "packages", "node_modules",
  "npm-cache", "pnpm-cache", "yarn", "nuget", "__pycache__",
  "Installer", "WindowsApps", ".git", "cache", "Cache", "Caches",
  "$Recycle.Bin", "System Volume Information", "Recovery", "Config.Msi",
]);

// Re-scan every fixed drive looking only for DLL-family binaries.
function getDllFiles() {
  return collectTrackedFiles(driveRoots(), DLL_SWEEP_LIMIT, DLL_SKIP_DIRS, DLL_EXTENSIONS);
}

const DISK_SKIP_DIRS = new Set([
  ...SKIP_DIRS,
  "$Recycle.Bin", "System Volume Information", "Recovery",
  "$SysReset", "Config.Msi", "Temp", "ProgramData\\Microsoft",
]);

// Full "This PC" sweep: every fixed drive, every tracked file type. This is the
// deepest pass, so it honours a separate (smaller) cap and skips only the
// highest-volume system/cache dirs that would otherwise dwarf everything else.
function getDiskSweep() {
  const limit = Number(process.env.DISK_SCAN_LIMIT || 6000);
  return collectTrackedFiles(driveRoots(), limit, DISK_SKIP_DIRS);
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

// ---- GUI loader panel ------------------------------------------------------
// The exe shows a compiled WinForms loader window instead of a console prompt.
// The GUI is a small C# GUI-subsystem exe (ToxyGui.exe) embedded in this bundle
// as base64, so no PowerShell console is ever spawned and no window flashes.

const TOXY_GUI_B64 = "__TOXY_GUI_B64__";

function ensureGuiExe() {
  const tmpDir = path.join(os.tmpdir(), "toxy-gui");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const exe = path.join(tmpDir, "ToxyGui.exe");
  const b64 = TOXY_GUI_B64;
  if (!b64 || b64.indexOf("TOXY_GUI_B64") !== -1) {
    // Not baked (source run without the build step): fall back to a compiled
    // copy next to the repo if present.
    const dev = path.join(__dirname, "..", "dist", "ToxyGui.exe");
    if (fs.existsSync(dev)) {
      fs.copyFileSync(dev, exe);
      return exe;
    }
    throw new Error("ToxyGui.exe was not embedded in this build.");
  }
  const bytes = Buffer.from(b64, "base64");
  // Always overwrite: a stale ToxyGui.exe from an older build can share the same
  // byte size, so a size-only check would keep reusing the broken copy. Compare by
  // bytes to be safe, and force a rewrite on any mismatch.
  let needsWrite = true;
  try {
    if (fs.existsSync(exe)) {
      const existing = fs.readFileSync(exe);
      needsWrite = existing.length !== bytes.length || !existing.equals(bytes);
    }
  } catch { needsWrite = true; }
  if (needsWrite) fs.writeFileSync(exe, bytes);
  return exe;
}

// Shows the loader panel; resolves true if the user pressed CHECK.
function askConsentGui() {
  const exe = ensureGuiExe();
  const resultFile = path.join(os.tmpdir(), "toxy-gui", `consent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  return new Promise((resolve) => {
    execFile(exe, ["consent", resultFile], { maxBuffer: 1024 * 1024 }, (err) => {
      let yes = false;
      try { yes = fs.readFileSync(resultFile, "utf8").trim() === "YES"; } catch { /* no result file */ }
      try { fs.unlinkSync(resultFile); } catch { /* ignore */ }
      resolve(yes);
    });
  });
}

// Non-blocking "scanning..." window with an animated radar + shimmer bar.
function showScanningWindow(progressFile) {
  const exe = ensureGuiExe();
  const child = spawn(exe, ["wait", progressFile || ""], { stdio: "ignore" });
  return child;
}

async function runScan() {
  const consent = await askConsentGui();
  if (!consent) {
    process.exit(0);
  }

  const progressFile = path.join(os.tmpdir(), "toxy-gui", "progress.json");
  // Create the progress file up front so the loading/bar window always reads it.
  try { fs.mkdirSync(path.dirname(progressFile), { recursive: true }); fs.writeFileSync(progressFile, JSON.stringify({ pct: 0 }), "utf8"); } catch { }

  const scanningWindow = showScanningWindow(progressFile);

  // Each collector is isolated so one failure never kills the whole scan.
  const safe = async (fn, label) => {
    try {
      return await fn();
    } catch (err) {
      console.log(`  ! Could not collect ${label}: ${err.message}`);
      return [];
    }
  };

  // Live progress is published to a file the ToxyGui "wait" window polls so the
  // loading bar fills 0 -> 100% and lands on 100% right when the scan is done.
const setProgress = (pct) => {
    try { fs.writeFileSync(progressFile, JSON.stringify({ pct }), "utf8"); } catch { }
  };
  setProgress(2);

  // Heartbeat: keep the loading bar gently climbing even between milestone,
  // pulls it toward 90 so it clears 100% only when the scan really finishes.
  let heartbeat = null;
  const stopHeartbeat = () => { if (heartbeat) clearInterval(heartbeat); heartbeat = null; };
  heartbeat = setInterval(() => {
    try {
      const cur = JSON.parse(fs.readFileSync(progressFile, "utf8").toString() || "{}");
      const n = Math.max(0, Math.min(90, (cur.pct || 0) + 0.7));
      fs.writeFileSync(progressFile, JSON.stringify({ pct: Math.min(90, Math.round(n)) }), "utf8");
    } catch { /* ignore */ }
  }, 400);

  const payload = {
    deviceId: await safe(getDeviceId, "device id"),
    deviceName: DEVICE_NAME,
    consentGiven: true,
    scannedAt: new Date().toISOString(),
  };
  payload.installedPrograms = await safe(getInstalledPrograms, "installed programs"); setProgress(18);
  payload.runningProcesses = await safe(getRunningProcesses, "running processes"); setProgress(34);
  payload.downloadFiles = safeSync(getDownloadFiles, "download files"); setProgress(42);
  payload.tempFiles = safeSync(getTempFiles, "temp files"); setProgress(50);
  payload.desktopFiles = safeSync(getDesktopFiles, "desktop files"); setProgress(58);
  payload.systemFiles = safeSync(getSystemFiles, "system files"); setProgress(66);
  payload.dllFiles = safeSync(getDllFiles, "dll files"); setProgress(74);
  payload.diskSweep = safeSync(getDiskSweep, "disk sweep"); setProgress(86);
  payload.forensics = await safe(getForensics, "forensics artifacts"); setProgress(93);

  console.log(`Found ${payload.installedPrograms.length} programs, ${payload.runningProcesses.length} processes, ${payload.downloadFiles.length} download files, ${payload.tempFiles.length} temp files, ${payload.desktopFiles.length} desktop files, ${payload.systemFiles.length} system files, ${(payload.dllFiles || []).length} DLL files, ${(payload.diskSweep || []).length} disk files, ${(payload.forensics.prefetch || []).length} prefetch entries, ${(payload.forensics.evtx || []).length} event log entries.`);
  console.log(`Uploading to ${API_URL} ...`);

  let response = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      response = await fetch(`${API_URL}/api/scans`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      break;
    } catch (err) {
      console.log(`  Upload attempt ${attempt}/3 failed: ${err.message}`);
      if (attempt === 3) {
        writeErrorReport(err, payload);
        closeScanningWindow(scanningWindow);
        showDoneGui("Scan failed", "Could not send the scan to the server.\n\nA report was saved next to this exe as scan-error.txt.\nSend that file to the person who gave you this tool.");
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  const body = await response.json();
  if (!response.ok) {
    writeErrorReport(new Error(`Server returned ${response.status}: ${JSON.stringify(body)}`), payload);
    closeScanningWindow(scanningWindow);
    showDoneGui("Scan failed", "The server rejected the scan. A report was saved next to this exe.");
    process.exit(1);
  }

  setProgress(100);
  stopHeartbeat();
  // Let the bar visibly reach 100% before switching to the done screen.
  await new Promise((r) => setTimeout(r, 700));
  closeScanningWindow(scanningWindow);
  showDoneGui("Scan complete", `Scan complete!\n\nYour results were sent successfully.\nScan ID: ${body.id}`);
}

function safeSync(fn, label) {
  try {
    return fn();
  } catch (err) {
    console.log(`  ! Could not collect ${label}: ${err.message}`);
    return [];
  }
}

function closeScanningWindow(child) {
  if (!child) return;
  try { child.kill(); } catch { /* already closed */ }
}

// Message box for the "done"/"failed" states, shown via ToxyGui.exe.
function showDoneGui(title, message) {
  try {
    const exe = ensureGuiExe();
    const tmpDir = path.join(os.tmpdir(), "toxy-gui");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const jsonFile = path.join(tmpDir, `done-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
    fs.writeFileSync(jsonFile, JSON.stringify({ title, message }), "utf8");
    spawn(exe, ["done", jsonFile], { stdio: "ignore" }).unref();
    const cleanup = setTimeout(() => { try { fs.unlinkSync(jsonFile); } catch {} }, 2000);
    if (cleanup && typeof cleanup.unref === "function") cleanup.unref();
  } catch {
    // If the GUI exe is unavailable, degrade to a plain message box.
    try {
      execFile("powershell.exe", ["-NoProfile", "-Command", `[System.Windows.Forms.MessageBox]::Show(${JSON.stringify(message)}, ${JSON.stringify(title)})`], { windowsHide: true }, () => {});
    } catch { /* ignore */ }
  }
}

function writeErrorReport(err, payload) {
  try {
    const exeDir = path.dirname(process.execPath);
    const report = {
      at: new Date().toISOString(),
      url: API_URL,
      node: process.version,
      platform: process.platform,
      error: String(err && (err.stack || err.message || err)),
      counts: {
        programs: (payload.installedPrograms || []).length,
        processes: (payload.runningProcesses || []).length,
        downloads: (payload.downloadFiles || []).length,
        temp: (payload.tempFiles || []).length,
        desktop: (payload.desktopFiles || []).length,
        system: (payload.systemFiles || []).length,
        dlls: (payload.dllFiles || []).length,
        disk: (payload.diskSweep || []).length,
        forensics: (payload.forensics || {}).prefetch ? (payload.forensics.prefetch.length + (payload.forensics.evtx || []).length) : 0,
      },
    };
    fs.writeFileSync(path.join(exeDir, "scan-error.txt"), JSON.stringify(report, null, 2), "utf8");
  } catch {
    // Nothing more we can do.
  }
}

runScan().catch((err) => {
  console.error(err);
  writeErrorReport(err, {});
  process.exit(1);
});