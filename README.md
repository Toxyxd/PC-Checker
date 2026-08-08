# Toxy Anti-Cheat - Source Code

This folder contains the complete, readable source code for the executable and
the website, plus the working exe itself. Everything here is open for
inspection.

## Get started in one click

Double-click **`start-server.bat`**:

1. It checks for Node.js,
2. runs `npm install` the first time,
3. starts the opensource dashboard at **http://localhost:8000** and opens it in your browser.

Keep the black window open while you use it. Close it to stop the server.

Done manually instead:

```powershell
npm install        # first time only
npm start          # opensource dashboard on http://localhost:8000
```

## The opensource dashboard

`dashboard-server.js` is a small dashboard on **http://localhost:8000**.
It has no logo, loading screen, or PC-Check builder - just the scan log table and
the per-scan detail view. Besides showing the scans, it also *receives* uploads
(`POST /api/scans`) and stores them. It keeps its own storage folder
(`data/dashboard-scans/`), which is **separate from the full site**, so
opensource scan results only appear on the localhost:8000 dashboard.

- `npm start` / `start-server.bat` run this dashboard.
- `npm run server` runs the full site (`index.js`), which stays on **http://localhost:3000**.

## Hosting the opensource exe yourself

The bundled `dist\PC_Check_Scan.exe` is baked with
**`http://localhost:8000`** - so whoever hosts this repo (runs the dashboard on
port 8000) and then runs the exe gets the scan logs right in their own
localhost:8000 dashboard. Same machine, same folder: the log appears
automatically.

To point the exe at a different server (e.g. your own on another port), override
at runtime without rebuilding:

```powershell
set API_URL=http://<host>:<port>
dist\PC_Check_Scan.exe
```

Or bake it in permanently while building:

```powershell
npm run build:scan-exe -- -ApiUrl http://<address>:8000
```

## The website

`index.js` is the full Express server (dashboard + PC-Check dashboard + results
pages). It is untouched by the opensource dashboard and runs on
**http://localhost:3000**. It stores scans under `data/scans/` and scores cheat
risk heuristically. `PUBLIC_DOMAIN` (default `https://toxy.lol`) is used for the
public share links and for the exe it serves to visitors.

Note: when the full website builds its exe (`/api/pc-check/build`), it bakes
`PUBLIC_DOMAIN` in and overwrites `dist\PC_Check_Scan.exe`. To switch back to
the opensource default, run:

```powershell
npm run build:scan-exe -- -ApiUrl http://localhost:8000
```

## What's in here

| Path | What it is |
|---|---|
| `start-server.bat` | Double-click launcher - starts the opensource dashboard at http://localhost:8000 |
| `dashboard-server.js` | The opensource dashboard (stores + shows scans on port 8000, no branding) |
| `index.js` | The full website + API server (dashboard, scan storage, heuristic risk scoring, port 3000) |
| `scan/scan-client.cjs` | The scan logic - this is the "brain" of the exe |
| `scripts/ToxyGui.cs` | The consent / scanning / done windows (C# source) |
| `scripts/build-scan-exe.ps1` | The script that compiles all of the above into the exe |
| `dist/PC_Check_Scan.exe` | The working scanner, built directly from the source above |
| `dist/PCCheckerSetup.exe` | Optional installer (uses the same source) |
| `assets/logo.png` | Logo used by the website and the exe |

## What the exe actually is

`PC_Check_Scan.exe` is a Node.js SEA (Single Executable Application). It is the
official Node.js runtime (`node.exe`) with the `scan-client.cjs` code from this
folder injected into it. That is why it is ~90 MB - it contains the entire Node
runtime - and why it is not a small packed virus. Every line of code that runs
inside it is visible in this folder.

You can rebuild it from this source:

```powershell
npm run build:scan-exe
```

## What it does (and doesn't)

1. Runs on the target Windows PC.
2. Shows a visible consent window - the scan does nothing until "CHECK PC" is pressed.
3. Collects only metadata (names + paths): installed programs, running
   processes, executable files in Downloads/Temp/Desktop/AppData/Program Files,
   a full disk sweep, and Windows forensics (Prefetch, Amcache, event logs).
   File contents are never read.
4. Sends that metadata over HTTPS to the server configured in the build
   (`scripts/build-scan-exe.ps1` / `scan/scan-client.cjs`), which flags cheat
   software by name/path keywords.

## Destination of results

The dashboard on port 8000 both displays and stores scans. In the current build
the upload URL is `http://192.168.56.1:8000` (your host's VirtualBox host-only
IP, reachable from local VMs). Results go only to a server you run locally, on
your own network. They are not sent anywhere unless you explicitly set the
target, or the owner of the project rebuilds the exe with their own URL via
`build-scan-exe.ps1`.

## Privacy

- Consent is mandatory and visible before anything is scanned.
- No personal files are opened or uploaded - only names and paths.
- No keys, passwords, or private URLs are baked into this code.

## Notes

- The exe is unsigned, so Windows SmartScreen will say "Unknown publisher" -
  click More info, Run anyway. This is a signing issue, not malware.
- If an antivirus flags it, that is the standard false-positive for any unsigned
  Node SEA binary; compare it against the source in this folder.