# Toxy Anti-Cheat - Source Code

This folder contains the complete, readable source code for the executable
inside, plus the working exe itself. Everything here is open for inspection.

## What's in here

| Path | What it is |
|---|---|
| `scan/scan-client.cjs` | The entire scan logic - this is the "brain" of the exe |
| `scripts/ToxyGui.cs` | The consent / scanning / done windows (C# source) |
| `scripts/build-scan-exe.ps1` | The script that compiles all of the above into the exe |
| `dist/PC_Check_Scan.exe` | The working scanner, built directly from the source above |
| `dist/PCCheckerSetup.exe` | Optional installer (uses the same source) |

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

In this build the upload URL is `http://127.0.0.1:3000` - the local default in
the source. Install, and run a server on that port, to receive scans. Results
are not sent anywhere unless you explicitly set the target, or the owner of the
project rebuilds the exe with their own URL via `build-scan-exe.ps1`.

## Privacy

- Consent is mandatory and visible before anything is scanned.
- No personal files are opened or uploaded - only names and paths.
- No keys, passwords, or private URLs are baked into this code.

## Notes

- The exe is unsigned, so Windows SmartScreen will say "Unknown publisher" -
  click More info, Run anyway. This is a signing issue, not malware.
- If an antivirus flags it, that is the standard false-positive for any unsigned
  Node SEA binary; compare it against the source in this folder.