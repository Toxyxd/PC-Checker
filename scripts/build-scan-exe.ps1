param(
  [string]$OutputName = "PC_Check_Scan.exe",
  [string]$ApiUrl = "http://localhost:3000"
)

$ErrorActionPreference = "Stop"

# Reject placeholder URLs so a friend's scan can never silently go nowhere.
if ($ApiUrl -match "your-server|something-random|YOUR_") {
  throw "Invalid ApiUrl '$ApiUrl'. That is an example placeholder. Use the REAL URL from cloudflared (e.g. https://abc123.trycloudflare.com) or your public server."
}

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$seaDir = Join-Path $root "sea"
$distDir = Join-Path $root "dist"
$configPath = Join-Path $seaDir "sea-config.json"
$blobPath = Join-Path $seaDir "prep.blob"
$postjectCli = Join-Path $root "node_modules\postject\dist\cli.js"

if (-not (Test-Path $postjectCli)) {
  throw "postject is missing. Run: npm install --save-dev postject"
}

$nodeBin = (Get-Command node).Source
if (-not $nodeBin) { throw "Node.js not found on PATH." }

if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }
$outPath = Join-Path $distDir $OutputName

# Remove any leftover output first (avoids locks / stale partial files).
if (Test-Path -LiteralPath $outPath) {
  Remove-Item -LiteralPath $outPath -Force -ErrorAction SilentlyContinue
}

# Bake the upload URL into a bundle copy of the source (SEA packs a single file).
$sourcePath = Join-Path $root "scan\scan-client.cjs"
$bundlePath = Join-Path $seaDir "scan-client.bundle.cjs"
if (-not (Test-Path $seaDir)) { New-Item -ItemType Directory -Path $seaDir | Out-Null }
$source = Get-Content -LiteralPath $sourcePath -Raw
$source = $source.Replace("__SCAN_API_URL__", $ApiUrl)

# Compile the WinForms GUI helper and embed it in the bundle as base64 so the
# single-file exe is fully self-contained (no PowerShell child windows, no flash).
$cscCandidates = @(
  "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$csc = $null
foreach ($cand in $cscCandidates) {
  if (Test-Path $cand) { $csc = $cand; break }
}
if (-not $csc) {
  throw ".NET Framework csc.exe not found. The ToxyGui.exe helper could not be compiled."
}
$guiCs = Join-Path $root "scripts\ToxyGui.cs"
$guiExe = Join-Path $distDir "ToxyGui.exe"
$logoPng = Join-Path $root "assets\logo.png"
if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }
if (Test-Path $logoPng) {
  # Embed the website logo into the GUI (replaces the __LOGO_PNG_B64__ placeholder).
  $logoB64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($logoPng))
  $guiSrc = Get-Content -LiteralPath $guiCs -Raw
  $guiSrc = $guiSrc.Replace("__LOGO_PNG_B64__", $logoB64)
  $tmpCs = Join-Path $distDir "ToxyGui.generated.cs"
  Set-Content -LiteralPath $tmpCs -Value $guiSrc -Encoding UTF8
  $guiCs = $tmpCs
}
& $csc /nologo /target:winexe /platform:anycpu /out:$guiExe `
  /reference:System.Windows.Forms.dll /reference:System.Drawing.dll $guiCs
if ($LASTEXITCODE -ne 0) { throw "Failed to compile ToxyGui.exe (csc exit $LASTEXITCODE)." }
$guiB64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($guiExe))
$source = $source.Replace("__TOXY_GUI_B64__", $guiB64)
Set-Content -LiteralPath $bundlePath -Value $source -Encoding ASCII

Write-Host "1/4 Generating SEA blob..."
& node --experimental-sea-config $configPath

Write-Host "2/4 Copying node binary -> $outPath"
Copy-Item -LiteralPath $nodeBin -Destination $outPath -Force

# Strip Authenticode signature if signtool is available so the injection is clean.
$signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
if ($signtool) {
  Write-Host "   Stripping signature..."
  & $signtool.Source remove /s $outPath 2>$null | Out-Null
}

Write-Host "3/4 Injecting SEA blob with postject..."
# Retry: Windows Defender / AV can briefly lock the freshly written exe.
$maxAttempts = 5
$injected = $false
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
  & node $postjectCli $outPath NODE_SEA_BLOB $blobPath `
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
  if ($LASTEXITCODE -eq 0 -and (Get-Item $outPath).Length -gt (Get-Item $nodeBin).Length) {
    $injected = $true
    break
  }
  Write-Host "   Injection write was blocked; retrying ($attempt/$maxAttempts)..."
  Start-Sleep -Milliseconds 200
}
if (-not $injected) { throw "postject failed to inject the SEA blob after $maxAttempts attempts." }

# Patch the PE optional-header Subsystem flag from CUI (3) to GUI (2) so the
# exe never opens a console window. Node still runs fine as a GUI subsystem app.
function Set-GuiSubsystem {
  param([string]$Path)
  $fs = [System.IO.File]::Open($Path, 'Open', 'ReadWrite')
  try {
    $br = New-Object System.IO.BinaryReader($fs)
    $fs.Position = 0x3C
    $e_lfanew = $br.ReadUInt32()
    $subsystemOffset = $e_lfanew + 4 + 20 + 68
    $fs.Position = $subsystemOffset
    $current = $br.ReadUInt16()
    if ($current -ne 2) {
      $fs.Position = $subsystemOffset
      $fs.WriteByte(2)
      $fs.WriteByte(0)
      Write-Host "   PE subsystem patched to GUI (no console window)."
    }
  } finally {
    $fs.Close()
  }
}
Set-GuiSubsystem -Path $outPath

# Set the website logo as the exe icon (generates logo.ico from logo.png if needed).
$icoPath = Join-Path $root "assets\logo.ico"
if (-not (Test-Path $icoPath)) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "make-ico.ps1") -Source $logoPng -Output $icoPath | Out-Null
}
# Icon step: rcedit can hang on the ~90MB exe (Defender/large-file lock), so run it
# in a child process with a hard timeout. On timeout we kill it and keep going.
$rcedit = Join-Path $root "tools\rcedit.exe"
if ((Test-Path $icoPath) -and (Test-Path $rcedit)) {
  Write-Host "   Setting exe icon (up to 45s)..."
  $proc = Start-Process -FilePath $rcedit -ArgumentList @("$outPath", "--set-icon", "$icoPath") -PassThru -NoNewWindow
  if (-not $proc.WaitForExit(45000)) {
    Write-Host "   (rcedit timed out; killing it and skipping icon)"
    try { $proc.Kill() } catch { }
    try { $proc.WaitForExit(5000) } catch { }
  } else {
    Write-Host "   (rcedit exit code $($proc.ExitCode))"
  }
}

Write-Host "4/4 Done."
$sizeMb = [Math]::Round((Get-Item $outPath).Length / 1MB, 1)
Write-Host ""
Write-Host "Built: $outPath ($sizeMb MB)"
Write-Host "Default upload URL baked in: $ApiUrl (override at runtime with API_URL env var)"
