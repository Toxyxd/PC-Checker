// Toxy Anti-Cheat - Opensource Dashboard
//
// This server hosts the scan dashboard and ALSO receives uploads from the
// scan client (POST /api/scans), storing them in the same data/scans folder
// that index.js uses. It is intentionally separate from index.js (the full
// site) so the live server on :3000 and toxy.lol keep working exactly as
// before. It binds to 0.0.0.0 so scans sent from a VM (reachable via the
// host IP) are stored and shown here.
//
// Run: node dashboard-server.js   ->   http://localhost:8000

import express from "express";
import { v4 as uuidv4 } from "uuid";
import {
  listScans,
  getScan,
  insertScan,
  validateScanPayload,
} from "./scan/scan-store.mjs";

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "0.0.0.0";

function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Scan Dashboard</title>
  <style>
    * { box-sizing: border-box; }
    :root { color-scheme: dark; font-family: Inter, Segoe UI, system-ui, sans-serif; }
    body { margin: 0; background: #0d1524; color: #e8edf5; }
    .wrap { max-width: 1200px; margin: 0 auto; padding: 32px 20px; }
    h1 { font-size: 22px; letter-spacing: 1px; margin: 0 0 4px; }
    .muted { color: #cbd5e1; }
    .layout { display: grid; grid-template-columns: 340px 1fr; gap: 20px; }
    @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
    .panel { background: rgba(20,26,40,.5); border: 1px solid rgba(148,163,184,.25); border-radius: 16px; padding: 20px; }
    .scan-card { width: 100%; text-align: left; background: rgba(20,20,24,.12); color: inherit; border: 1px solid rgba(148,163,184,.25); border-radius: 12px; padding: 14px; margin-bottom: 10px; cursor: pointer; }
    .scan-card.active { border-color: #38bdf8; background: rgba(12,29,56,.55); }
    .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 16px; }
    .meta > div { background: #141824; border: 1px solid rgba(148,163,184,.22); border-radius: 12px; padding: 12px; }
    .tabs button { margin-right: 8px; margin-bottom: 12px; padding: 8px 14px; border-radius: 999px; border: 1px solid rgba(148,163,184,.35); background: #141824; color: #e8edf5; cursor: pointer; }
    .tabs button.active { background: #38bdf8; color: #04111f; border-color: #38bdf8; }
    input { width: 100%; padding: 10px; border-radius: 10px; border: 1px solid rgba(148,163,184,.35); background: #141824; color: #e8edf5; margin-bottom: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px; border-bottom: 1px solid rgba(148,163,184,.22); text-align: left; vertical-align: top; font-size: 13px; }
    th { color: #cbd5e1; }
    .badge { display: inline-block; padding: 4px 8px; border-radius: 999px; background: rgba(21,128,61,.22); color: #34d399; font-size: 12px; }
    .risk-low { color: #4ade80; }
    .risk-medium { color: #facc15; }
    .risk-high { color: #f87171; font-weight: 700; }
    .summary { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; padding: 14px; background: #141824; border: 1px solid rgba(148,163,184,.22); border-radius: 12px; }
    .empty { color: #cbd5e1; text-align: center; padding: 24px; }
    .hidebtn { padding: 6px 12px; border-radius: 8px; border: 1px solid rgba(148,163,184,.4); background: #141824; color: #cbd5e1; cursor: pointer; }
    .riskbig { display: flex; align-items: center; gap: 24px; margin-bottom: 14px; padding: 18px; background: #141824; border: 1px solid rgba(148,163,184,.28); border-radius: 14px; }
    .riskbig-title { font-size: 28px; font-weight: 800; }
    .riskbig.high .riskbig-title { color: #f87171; }
    .riskbig.medium .riskbig-title { color: #facc15; }
    .riskbig.low .riskbig-title { color: #4ade80; }
    .pbar { height: 8px; border-radius: 999px; background: rgba(148,163,184,.25); overflow: hidden; margin-bottom: 16px; }
    .pbar-in { height: 100%; background: #facc15; transition: width 1s ease; }
    .pbar-in.high { background: #f87171; }
    .pbar-in.low { background: #4ade80; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Dashboard</h1>
    <div class="muted" style="margin-bottom:18px">Toxy Anti-Cheat - opensource scan log viewer (read-only)</div>
    <div class="layout" id="scans">
      <section class="panel">
        <div id="summary" class="summary"><span class="muted">Loading...</span></div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <h2 style="margin:0;font-size:18px">Scans</h2>
          <button class="hidebtn" onclick="refreshScans()">Refresh</button>
        </div>
        <div id="scan-list" class="muted">Loading...</div>
      </section>
      <section class="panel">
        <div id="detail" class="empty">Select a scan.</div>
      </section>
    </div>
  </div>
  <script>
    let scans = [], selected = null, tab = "programs", query = "";
    const fmt = (v) => v ? new Date(v).toLocaleString() : "—";
    const bytes = (v) => v == null ? "—" : v < 1024 ? v + " B" : v < 1048576 ? (v/1024).toFixed(1)+" KB" : (v/1048576).toFixed(1)+" MB";

    function refreshScans() { if (typeof loadScans === "function") loadScans(); }

    async function loadScans() {
      const res = await fetch("/api/scans");
      scans = await res.json();
      renderSummary();
      const list = document.getElementById("scan-list");
      if (!list) return;
      if (!scans.length) { list.innerHTML = '<div class="empty">No scans yet. Run the scan client to upload a scan.</div>'; return; }
      list.innerHTML = scans.map(s => \`
        <button class="scan-card \${selected?.id===s.id?'active':''}" data-id="\${s.id}">
          <div>\${s.device_name || 'Unnamed'}</div>
          <span class="risk-\${s.risk_level}">[\${(s.risk_score||0)}% \${(s.risk_level||'low').toUpperCase()}]</span>
          <div class="muted" style="font-size:12px">\${fmt(s.scanned_at)}</div>
          <div class="muted" style="font-size:12px">\${s.program_count} programs · \${s.process_count} procs · \${s.download_count} downloads · \${s.dll_count} DLLs</div>
        </button>\`).join("");
      list.querySelectorAll(".scan-card").forEach(btn => btn.onclick = () => loadDetail(btn.dataset.id));
      if (selected) setActive(selected.id);
    }

    function esc(v) { return String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c])); }

    function setActive(id) {
      document.querySelectorAll(".scan-card").forEach(b => b.classList.toggle("active", b.dataset.id === id));
    }

    function ring(pct, size) {
      const s = size || 128, stroke = Math.max(8, Math.round(s / 10));
      const r = (s / 2) - stroke / 2, c = 2 * Math.PI * r;
      const off = c * (1 - pct / 100);
      const col = pct >= 50 ? "#f87171" : pct >= 25 ? "#facc15" : "#4ade80";
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
      el.innerHTML = \`<div><strong>\${flagged}/\${total}</strong> PCs flagged · <span class="muted">heuristic cheat-risk scan</span></div>\`;
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
      const rcol = r.level || "low";
      el.innerHTML = \`
        <div class="meta">
          <div><span class="muted">Device</span><br><strong>\${esc(selected.device_name)}</strong></div>
          <div><span class="muted">Device ID</span><br><strong>\${esc(selected.device_id)}</strong></div>
          <div><span class="muted">Scanned</span><br><strong>\${fmt(selected.scanned_at)}</strong></div>
          <div><span class="muted">Consent</span><br><span class="badge">\${selected.consent_given ? "Given" : "Missing"}</span></div>
        </div>
        <div class="riskbig \${rcol}">
          <div class="riskbig-circle">\${ring((r.score || 0), 200)}</div>
          <div class="riskbig-label">
            <div class="riskbig-title">\${r.score >= 55 ? "High cheat risk" : r.score >= 25 ? "Moderate risk" : "Looks clean"}</div>
            <div class="muted">\${(r.flags || []).length} flagged items</div>
          </div>
        </div>
        <div class="pbar"><div class="pbar-in \${rcol}" style="width:\${r.score || 0}%"></div></div>
        <div class="tabs">
          <button class="\${tab==='programs'?'active':''}" onclick="setTab('programs')">Programs</button>
          <button class="\${tab==='processes'?'active':''}" onclick="setTab('processes')">Processes</button>
          <button class="\${tab==='downloads'?'active':''}" onclick="setTab('downloads')">Downloads</button>
          <button class="\${tab==='temp'?'active':''}" onclick="setTab('temp')">Temp</button>
          <button class="\${tab==='desktop'?'active':''}" onclick="setTab('desktop')">Desktop</button>
          <button class="\${tab==='system'?'active':''}" onclick="setTab('system')">System</button>
          <button class="\${tab==='dll'?'active':''}" onclick="setTab('dll')">DLLs</button>
          <button class="\${tab==='disk'?'active':''}" onclick="setTab('disk')">Disks</button>
          <button class="\${tab==='prefetch'?'active':''}" onclick="setTab('prefetch')">Prefetch</button>
          <button class="\${tab==='amcache'?'active':''}" onclick="setTab('amcache')">Amcache</button>
          <button class="\${tab==='shimcache'?'active':''}" onclick="setTab('shimcache')">ShimCache</button>
          <button class="\${tab==='evtx'?'active':''}" onclick="setTab('evtx')">Event Logs</button>
          <button class="\${tab==='flags'?'active':''}" onclick="setTab('flags')">Flags</button>
        </div>
        <input placeholder="Filter..." value="\${query}" oninput="setQuery(this.value)" />
        <div style="overflow:auto">
          \${tab === 'programs' ? \`<table><thead><tr><th>Name</th><th>Version</th><th>Publisher</th><th>Install Date</th></tr></thead><tbody>\${data.map(r => \`<tr><td>\${esc(r.name)}</td><td>\${esc(r.version||'—')}</td><td>\${esc(r.publisher||'—')}</td><td>\${esc(r.install_date||'—')}</td></tr>\`).join('')}</tbody></table>\` : ''}
          \${tab === 'processes' ? \`<table><thead><tr><th>Name</th><th>PID</th><th>Path</th><th>Started</th></tr></thead><tbody>\${data.map(r => \`<tr><td>\${esc(r.name)}</td><td>\${esc(r.pid)}</td><td>\${esc(r.path||'—')}</td><td>\${fmt(r.started_at)}</td></tr>\`).join('')}</tbody></table>\` : ''}
          \${['downloads','temp','desktop','system','dll','disk'].includes(tab) ? \`<table><thead><tr><th>Name</th><th>Path</th><th>Size</th><th>Modified</th></tr></thead><tbody>\${data.map(r => \`<tr><td>\${esc(r.name)}</td><td>\${esc(r.path)}</td><td>\${bytes(r.size_bytes)}</td><td>\${fmt(r.modified_at)}</td></tr>\`).join('')}</tbody></table>\` : ''}
          \${tab === 'flags' ? \`<table><thead><tr><th>Type</th><th>Name</th><th>Path</th><th>Reason</th></tr></thead><tbody>\${data.map(r => \`<tr><td class="risk-\${selected.risk?.level || 'low'}">\${esc(r.type)}</td><td>\${esc(r.name)}</td><td>\${esc(r.path || '—')}</td><td>\${esc(r.reason)}</td></tr>\`).join('')}</tbody></table>\` : ''}
          \${tab === 'prefetch' ? \`<table><thead><tr><th>Exe</th><th>File</th><th>Size</th><th>Modified</th></tr></thead><tbody>\${data.map(r => \`<tr><td>\${esc(r.exe || '—')}</td><td>\${esc(r.name || '—')}</td><td>\${bytes(r.size_bytes)}</td><td>\${fmt(r.modified_at)}</td></tr>\`).join('')}</tbody></table>\` : ''}
          \${tab === 'amcache' ? \`<table><thead><tr><th>Executable path</th></tr></thead><tbody>\${data.map(r => \`<tr><td>\${esc(r.exe)}</td></tr>\`).join('')}</tbody></table>\` : ''}
          \${tab === 'shimcache' ? \`<table><thead><tr><th>Executable path</th></tr></thead><tbody>\${data.map(r => \`<tr><td>\${esc(r.exe)}</td></tr>\`).join('')}</tbody></table>\` : ''}
          \${tab === 'evtx' ? \`<table><thead><tr><th>Log</th><th>ID</th><th>Level</th><th>Time</th><th>Message</th></tr></thead><tbody>\${data.map(r => \`<tr><td>\${esc(r.log)}</td><td>\${esc(r.id ?? '—')}</td><td>\${esc(r.level || '—')}</td><td>\${fmt(r.time)}</td><td>\${esc(r.message || '—')}</td></tr>\`).join('')}</tbody></table>\` : ''}
        </div>
        \${truncated ? '<div class="muted" style="margin:8px 0">Showing first ' + MAX_ROWS + ' of ' + all.length + ' rows — filter to narrow down.</div>' : ''}
        \${data.length ? '' : '<div class="empty">No rows match.</div>'}\`;
    }

    window.setTab = (t) => { tab = t; renderDetail(); };
    window.setQuery = (q) => { query = q; renderDetail(); };

    loadScans();
    setInterval(loadScans, 5000);
  </script>
</body>
</html>`;
}

const app = express();
app.use(express.json({ limit: "80mb" }));
app.get("/api/health", (_req, res) => res.json({ ok: true }));
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
    id: req.body.id || uuidv4(),
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
app.get("/", (_req, res) => res.type("html").send(dashboardHtml()));

app.listen(PORT, HOST, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});