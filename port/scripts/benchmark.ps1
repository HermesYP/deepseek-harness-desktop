<#
.SYNOPSIS
  Plan and drive same-machine release comparisons between the pinned reference and
  the Rust/Tauri port.

.DESCRIPTION
  Milestone 6 of docs/implementation-plan.md requires release-build comparisons of
  reference and port on the same machine and the same fixtures, for:

    - cold start and first usable UI
    - warm start and first usable UI
    - p50/p95 interaction, render, scroll, session-open and long-conversation latency
    - active streaming, reconnect, terminal IO and agent-continuation behaviour
    - whole-process-tree private memory (Rust shell + WebView2 + Node + tool
      children), idle CPU, and retained-memory growth

  This script measures the two metrics that need no UI automation, and it PLANS the
  rest rather than pretending to run them.

  What it actually measures (runnable today, no desktop launch):
    - `RustGatewayStatic` : HTTP latency/throughput of the Rust gateway's static
      handler against a fixture tree, started by the `dsh-gateway` benchmark
      harness (a normal `cargo bench`/test binary, not the desktop app).
    - `ReferenceStatic`   : the same fixture served by the reference's
      `serveWebDocument` under plain Node, which needs `_upstream/` only as a
      read-only source of that function.

  What it deliberately does NOT do:
    - It never launches the desktop application and never starts a replacement GUI
      server. Per the implementation plan, a launch needs an isolated qualification
      command reviewed by the lead.
    - It never starts anything against the live Harness home or port 3080.
    - It does not publish benchmark numbers as results. `-Plan` prints the harness
      design; the measured lanes print a machine fingerprint so a number can never
      be quoted without the machine it came from.

  A number from this script is evidence about the static handler only. It is NOT
  evidence about startup, memory, or UI latency. Those require the planned harness
  in `-Plan` output.

.PARAMETER Mode
  plan      print the full benchmark design, including the lanes that need an
            approved isolated launch. Performs no measurement.
  static    measure the two static-handler lanes that need no desktop launch.
  all       plan then static.

.PARAMETER FixtureBytes
  Size of each generated fixture asset. Default 1048576 (1 MiB).

.PARAMETER Requests
  Measured requests per lane. Default 2000.

.PARAMETER Warmup
  Unmeasured warmup requests per lane. Default 200.

.PARAMETER Repetitions
  Independent repetitions; results are reported per repetition and as a median of
  medians, so a single noisy run cannot be quoted as the result. Default 5.

.PARAMETER OutputDir
  Where raw per-request samples and the fingerprint are written. Defaults to
  `port\.scratch\benchmark\`.

.EXAMPLE
  .\port\scripts\benchmark.ps1 -Mode plan

.EXAMPLE
  .\port\scripts\benchmark.ps1 -Mode static -Repetitions 5
#>
[CmdletBinding()]
param(
  [ValidateSet('plan', 'static', 'all')]
  [string]$Mode = 'plan',

  [int]$FixtureBytes = 1048576,
  [int]$Requests = 2000,
  [int]$Warmup = 200,
  [int]$Repetitions = 5,
  [string]$OutputDir
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $PSScriptRoot.EndsWith('scripts')) {
  throw "benchmark.ps1 must live in <repo>/port/scripts; found $PSScriptRoot"
}
$portRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $portRoot
$upstream = Join-Path $repoRoot '_upstream'
$tauriRoot = Join-Path $portRoot 'src-tauri'

if (-not $OutputDir) { $OutputDir = Join-Path $portRoot '.scratch\benchmark' }

function Write-Section([string]$Title) {
  Write-Host ''
  Write-Host ('=' * 78) -ForegroundColor DarkGray
  Write-Host $Title -ForegroundColor Cyan
  Write-Host ('=' * 78) -ForegroundColor DarkGray
}

<#
  The machine fingerprint exists so a quoted number always carries the machine it
  came from. Cross-machine comparison is meaningless for every lane here.
#>
function Get-MachineFingerprint {
  $cpu = $null
  try { $cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name } catch { $cpu = '<unavailable>' }
  $os = $null
  try { $os = (Get-CimInstance Win32_OperatingSystem).Caption } catch { $os = '<unavailable>' }
  $totalRam = $null
  try {
    $totalRam = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
  } catch { $totalRam = '<unavailable>' }

  [pscustomobject]@{
    capturedAtUtc      = (Get-Date).ToUniversalTime().ToString('o')
    osCaption          = $os
    cpu                = $cpu
    logicalProcessors  = [Environment]::ProcessorCount
    totalRamGiB        = $totalRam
    powershellVersion  = $PSVersionTable.PSVersion.ToString()
    dotnetFramework    = $PSVersionTable.CLRVersion
    fixtureBytes       = $FixtureBytes
    requests           = $Requests
    warmup             = $Warmup
    repetitions        = $Repetitions
    upstreamCommit     = (Get-UpstreamCommit)
  }
}

function Get-UpstreamCommit {
  if (-not (Test-Path (Join-Path $upstream '.git'))) { return '<no _upstream checkout>' }
  try {
    return (& git -C $upstream rev-parse HEAD 2>$null).Trim()
  } catch {
    return '<unavailable>'
  }
}

<#
  A deterministic fixture tree. Determinism matters: the reference and the port must
  serve byte-identical assets, or the comparison measures the fixtures rather than
  the servers. The pseudo-random body keeps the filesystem from deduplicating or
  trivially compressing the asset.
#>
function New-FixtureTree([string]$Root, [int]$AssetBytes) {
  if (Test-Path $Root) { Remove-Item -Recurse -Force $Root }
  New-Item -ItemType Directory -Force -Path $Root | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $Root 'assets') | Out-Null

  # The index is small and stable; its size does not vary with -FixtureBytes so the
  # boot-injection path stays comparable across runs.
  $indexHtml = @'
<!doctype html><html><head><meta charset="utf-8"><title>dsh benchmark fixture</title>
<link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div>
<script type="module" src="/assets/app.js"></script></body></html>
'@
  Set-Content -NoNewline -Path (Join-Path $Root 'index.html') -Value $indexHtml -Encoding utf8
  Set-Content -NoNewline -Path (Join-Path $Root 'assets\app.js') -Value "globalThis.__benchmark = true;`n" -Encoding utf8
  Set-Content -NoNewline -Path (Join-Path $Root 'assets\app.css') -Value ":root{--bench:1}`n" -Encoding utf8

  $state = [uint32]2654435761
  $chunk = New-Object byte[] 65536
  $stream = [System.IO.File]::Create((Join-Path $Root 'assets\big.js'))
  try {
    $written = 0
    while ($written -lt $AssetBytes) {
      for ($i = 0; $i -lt $chunk.Length; $i += 4) {
        $state = [uint32](([uint64]$state * 1664525 + 1013904223) % 4294967296)
        $chunk[$i] = [byte]($state -band 0xFF)
        $chunk[$i + 1] = [byte](($state -shr 8) -band 0xFF)
        $chunk[$i + 2] = [byte](($state -shr 16) -band 0xFF)
        $chunk[$i + 3] = [byte](($state -shr 24) -band 0xFF)
      }
      $take = [Math]::Min($chunk.Length, $AssetBytes - $written)
      $stream.Write($chunk, 0, $take)
      $written += $take
    }
  } finally {
    $stream.Dispose()
  }
  return $Root
}

function Show-Fingerprint($Fingerprint) {
  Write-Host 'Machine fingerprint (a number is only meaningful with this attached):' -ForegroundColor Yellow
  $Fingerprint.PSObject.Properties | ForEach-Object {
    Write-Host ("  {0,-20} {1}" -f $_.Name, $_.Value)
  }
}

function Get-Percentile([double[]]$Sorted, [double]$Percentile) {
  if ($Sorted.Count -eq 0) { return [double]::NaN }
  $rank = [Math]::Ceiling($Percentile / 100.0 * $Sorted.Count) - 1
  if ($rank -lt 0) { $rank = 0 }
  if ($rank -ge $Sorted.Count) { $rank = $Sorted.Count - 1 }
  return $Sorted[$rank]
}

<#
  The plan is printed, not implied. Each lane names the metric, the harness that can
  produce it, and the reason it is or is not runnable in this session. Lanes needing a
  desktop launch are explicitly gated on an isolated qualification command reviewed by
  the lead - the script never launches one on its own initiative.
#>
function Show-Plan {
  Write-Section 'Benchmark design: reference vs port, same machine, same fixtures'

  Write-Host @'
Comparison rules that apply to EVERY lane below
------------------------------------------------
  R1  Same machine, same OS build, same power plan, same background load.
      Interleave reference and port runs; never batch one then the other.
  R2  Same fixture tree, byte-identical, generated once and hashed. Record the hash.
  R3  Same viewport, DPI scale, window size, theme and locale for UI lanes.
  R4  Release builds only. A debug build is not a release comparison.
  R5  Report the machine fingerprint and the fixture hash with every number.
  R6  Discard the first run of each lane (cold filesystem caches differ from warm
      ones in ways the lane itself is trying to measure).
  R7  Report per-repetition values and the median of medians. A single run is not
      a result, and a best-of-N is not a result either.
  R8  Never state a cross-machine or simulated comparison. If only one side ran,
      report that lane as incomplete.
'@

  Write-Host ''
  Write-Host 'LANE 1 - Cold start to first usable UI' -ForegroundColor Green
  Write-Host @'
  Metric   Wall time from process create to the moment the workspace accepts input
           (not paint, not DOMContentLoaded: the first interaction that responds).
  Harness  Automated launch of each release build in turn, on a cleared standby
           list and an empty OS file cache, driven by the port's existing capture
           tooling so the "usable" predicate is the same one parity capture uses.
  Needs    An approved isolated launch command, a throwaway DSH_HOME under
           port\.scratch\, and a port above 3084. NOT runnable here.
  Why      Launching the desktop is exactly the operation this lane's plan must be
           reviewed for; the script will not do it implicitly.
  Caveat   Cache clearing is approximate. State the method used; do not claim an
           exact cold-cache state.
'@

  Write-Host ''
  Write-Host 'LANE 2 - Warm start to first usable UI' -ForegroundColor Green
  Write-Host @'
  Metric   The same predicate as Lane 1, immediately after a preceding run of the
           same build, with caches warm.
  Harness  Identical to Lane 1 with the cache step removed.
  Needs    Same approved launch. NOT runnable here.
  Caveat   Warm start is dominated by WebView2 profile reuse; record whether the
           WebView2 user-data directory was preserved or reset, because that single
           choice moves this number more than any port change.
'@

  Write-Host ''
  Write-Host 'LANE 3 - Interaction latency (p50 / p95)' -ForegroundColor Green
  Write-Host @'
  Metric   Input-to-visible-response for: keystroke echo in the composer, send,
           session open, sidebar scroll, long-conversation scroll, and tab switch.
  Harness  Scripted interaction against each build with timestamped markers; for
           render latency prefer a browser-driven measurement over screen capture,
           which adds an unpredictable compositor delay.
  Needs    Approved launch plus the existing capture harness. NOT runnable here.
  Caveat   Report the measurement point. "Input to paint" and "input to handler
           completion" differ by an order of magnitude and must never be mixed
           across the two builds.
'@

  Write-Host ''
  Write-Host 'LANE 4 - Long session: open, scroll, render' -ForegroundColor Green
  Write-Host @'
  Metric   Time to open and scroll a session of a fixed, stated size (record the
           message count and the fixture identity), p50/p95.
  Fixture  A recorded session log replayed into an isolated home. The fixture must
           be the same generation for both builds; a session written by one build's
           format and read by the other is a compatibility test, not a benchmark.
  Needs    Approved launch. NOT runnable here.
'@

  Write-Host ''
  Write-Host 'LANE 5 - Streaming, reconnect, terminal IO, agent continuation' -ForegroundColor Green
  Write-Host @'
  Metric   Sustained frame/flush cadence during an active stream; time to recover
           after a forced transport drop; terminal output throughput; time from
           continuation request to first visible token.
  Harness  Deterministic local stubs first. Real-provider runs only with approved
           credentials and budget, and reported separately.
  Needs    Approved launch. NOT runnable here.
  Caveat   Without a deterministic stub on both sides this lane measures the
           provider, not the port. Do not run it against a real provider to compare
           shells.
'@

  Write-Host ''
  Write-Host 'LANE 6 - Whole process-tree private memory' -ForegroundColor Green
  Write-Host @'
  Metric   Sum of private working set across the ENTIRE tree: Rust shell, WebView2
           (browser + all renderer/GPU/utility children), the Node Host, and any
           tool children. Sampled after settling, not at peak.
  Harness  Walk the process tree from the launched root by parent id, accumulate
           private bytes only (shared/standby pages are not this application's
           memory), and record the per-process breakdown - a total without the
           breakdown cannot be audited.
  Needs    Approved launch. NOT runnable here.
  Rule     A shell-only number must never be presented as the application's memory.
'@

  Write-Host ''
  Write-Host 'LANE 7 - Idle CPU and retained-memory growth' -ForegroundColor Green
  Write-Host @'
  Metric   Idle CPU over a stated quiet interval, and private memory at successive
           checkpoints across an idle soak, to separate steady state from a leak.
  Harness  The same tree walk as Lane 6 on a schedule, plus a CPU sample over a
           fixed window. A single end-point memory figure cannot distinguish a
           leak from a large steady state.
  Needs    Approved launch. NOT runnable here.
'@

  Write-Host ''
  Write-Host 'LANE 8 - Rust release profile comparison (measured, not assumed)' -ForegroundColor Green
  Write-Host @'
  Metric   The lanes above, repeated for each candidate [profile.release] setting
           (opt-level "s" vs 3, lto, codegen-units, panic strategy).
  Rule     Choose from data. Do not change opt-level on the assumption that a
           size-oriented setting costs latency or that speed orientation improves it.
           Size and startup/latency must both be measured per candidate.
  Needs    Approved launch per candidate. NOT runnable here.
'@

  Write-Host ''
  Write-Host 'RUNNABLE NOW' -ForegroundColor Green
  Write-Host @'
  LANE 9 - Static handler latency and throughput (this script, -Mode static)
    Metric   Per-request latency p50/p95/p99 and requests/second for:
               (a) the Rust gateway static handler  (-Engine port)
               (b) the reference serveWebDocument  (-Engine reference)
             over the same fixture tree, for the index (boot-injection path) and
             for a large asset (bulk-read path).
    Engine   The Rust side runs the gateway through its own test/bench harness, not
             the desktop app, so no desktop launch is involved.
    Scope    This lane is evidence about one HTTP handler. It is NOT evidence about
             startup, memory, or UI latency, and must not be quoted as such.
'@

  Write-Host ''
  Write-Host 'NOT COVERED ANYWHERE ABOVE' -ForegroundColor DarkYellow
  Write-Host @'
  - Installation and update timing (Milestone 4/5), which needs real artifacts.
  - GPU/compositor behaviour under animation (needs a display and a real window).
  - macOS and any non-Windows target (needs its own host).
  No lane here may be reported as complete without its measured data attached.
'@
}

<#
  Head-of-line latency probe over a loopback HTTP endpoint. Uses .NET HttpClient
  directly so the measurement is the server's cost, not PowerShell's per-call overhead.
#>
function Invoke-LatencyProbe {
  param(
    [Parameter(Mandatory)][string]$BaseUrl,
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][int]$Requests,
    [Parameter(Mandatory)][int]$Warmup,
    [string]$Cookie
  )

  # `System.Net.Http` is not loaded by default under Windows PowerShell 5.1.
  Add-Type -AssemblyName System.Net.Http -ErrorAction Stop
  $handler = New-Object System.Net.Http.HttpClientHandler
  $handler.UseProxy = $false
  $handler.MaxConnectionsPerServer = 8
  if ($Cookie) {
    # HttpClientHandler owns cookie handling and silently DROPS a Cookie header set
    # through DefaultRequestHeaders (it still appears in HttpRequestMessage.Headers
    # when inspected, which makes the failure look like a server rejection). The
    # cookie must be installed in the handler's own container to reach the wire.
    $handler.UseCookies = $true
    $container = New-Object System.Net.CookieContainer
    $pair = $Cookie.Split('=', 2)
    if ($pair.Count -ne 2) { throw "malformed cookie pair from the harness: $Cookie" }
    $origin = [Uri]$BaseUrl
    $container.Add($origin, (New-Object System.Net.Cookie($pair[0], $pair[1], '/', $origin.Host)))
    $handler.CookieContainer = $container
  } else {
    $handler.UseCookies = $false
  }
  $client = New-Object System.Net.Http.HttpClient($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(60)

  $url = "$BaseUrl$Path"
  $samples = New-Object 'System.Collections.Generic.List[double]'

  try {
    # Warmup is unmeasured: the first requests pay TLS-free but still real costs
    # (JIT, connection setup, filesystem metadata) that belong to neither tail.
    for ($i = 0; $i -lt $Warmup; $i++) {
      $r = $client.GetAsync($url).GetAwaiter().GetResult()
      $null = $r.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
      $r.Dispose()
    }

    $sw = New-Object System.Diagnostics.Stopwatch
    for ($i = 0; $i -lt $Requests; $i++) {
      $sw.Restart()
      $r = $client.GetAsync($url).GetAwaiter().GetResult()
      $bytes = $r.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
      $sw.Stop()
      if (-not $r.IsSuccessStatusCode) {
        throw "probe request failed: HTTP $([int]$r.StatusCode) for $url"
      }
      $samples.Add($sw.Elapsed.TotalMilliseconds)
      $r.Dispose()
      if ($bytes.Length -eq 0) { throw "probe received an empty body for $url" }
    }
  } finally {
    $client.Dispose()
    $handler.Dispose()
  }

  $sorted = $samples.ToArray()
  [Array]::Sort($sorted)
  $sum = 0.0
  foreach ($v in $sorted) { $sum += $v }
  [pscustomobject]@{
    requests    = $Requests
    meanMs      = [math]::Round($sum / $sorted.Count, 4)
    p50Ms       = [math]::Round((Get-Percentile $sorted 50), 4)
    p95Ms       = [math]::Round((Get-Percentile $sorted 95), 4)
    p99Ms       = [math]::Round((Get-Percentile $sorted 99), 4)
    minMs       = [math]::Round($sorted[0], 4)
    maxMs       = [math]::Round($sorted[$sorted.Count - 1], 4)
    perSecond   = [math]::Round(1000.0 / ($sum / $sorted.Count), 1)
    samples     = $sorted
  }
}

<#
  Serve the fixture tree with the REFERENCE implementation.

  `serveWebDocument` is imported from the read-only `_upstream` checkout at the pinned
  commit, so this lane measures the pinned reference rather than a re-implementation
  of it. The checkout is never written to. If the pinned source cannot be loaded, the
  lane reports that instead of substituting an approximation.
#>
function Start-ReferenceStaticServer {
  param(
    [Parameter(Mandatory)][string]$FixtureRoot,
    [Parameter(Mandatory)][string]$AppJs
  )

  if (-not (Test-Path $AppJs)) {
    throw "reference web-document.ts not found at $AppJs; the _upstream checkout is required for the reference lane"
  }

  $script = @'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

const [root, appJs] = process.argv.slice(2)
const module_ = await import(pathToFileURL(appJs).href)
const serveWebDocument = module_.serveWebDocument

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const request = new Request(url, { method: req.method })
  const response = await serveWebDocument(request, root)
  res.writeHead(response.status, Object.fromEntries(response.headers))
  const body = response.body === null ? null : Buffer.from(await response.arrayBuffer())
  res.end(body)
})
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(String(server.address().port) + '\n')
})
'@

  $tmp = Join-Path $env:TEMP ("dsh-bench-ref-" + [guid]::NewGuid().ToString('n') + '.mjs')
  Set-Content -NoNewline -Path $tmp -Value $script -Encoding utf8

  # Windows PowerShell 5.1 has no ProcessStartInfo.ArgumentList, so arguments are
  # passed through the single Arguments string. Both values are quoted explicitly
  # because a fixture path may contain spaces.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'node'
  $psi.Arguments = '"{0}" "{1}" "{2}"' -f $tmp, $FixtureRoot, $AppJs
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $proc = [System.Diagnostics.Process]::Start($psi)

  try {
    $portLine = $proc.StandardOutput.ReadLine()
    if (-not $portLine) {
      $err = $proc.StandardError.ReadToEnd()
      throw "reference static server failed to start: $err"
    }
  } catch {
    # The temporary module is removed here as well as by Stop-BenchmarkServer,
    # because a startup failure never reaches that path and would otherwise leak
    # one script per failed run into the temp directory.
    try { if (-not $proc.HasExited) { $proc.Kill() } } catch { }
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    throw
  }
  return [pscustomobject]@{ Process = $proc; Port = [int]$portLine; ScriptPath = $tmp }
}

<#
  The Rust side is measured through the gateway crate's own harness, which binds a
  real loopback listener on an ephemeral port and serves the fixture tree. This is the
  same code path the desktop shell uses, without launching the desktop.

  The harness is a Rust integration test named `benchmark_harness`, gated behind the
  `benchmark-harness` feature so an ordinary `cargo test` never runs a load generator.
  It prints `BENCHMARK_PORT=<port>` on stdout and serves until it receives SIGINT.
#>
function Start-RustStaticServer {
  param([Parameter(Mandatory)][string]$FixtureRoot)

  Write-Host 'Building the gateway benchmark harness (release, focused crate only)...' -ForegroundColor DarkGray
  # cargo writes progress to stderr, which Windows PowerShell surfaces as an error
  # record under a strict preference. Capture both streams as text and judge only the
  # exit code, so a successful build cannot be misread as a failure.
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $buildOutput = & cargo build `
      --manifest-path (Join-Path $tauriRoot 'Cargo.toml') `
      -p dsh-gateway `
      --release `
      --features benchmark-harness `
      --bin gateway-benchmark 2>&1 | ForEach-Object { $_.ToString() }
    $buildExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($buildExit -ne 0) {
    throw "gateway benchmark harness build failed:`n$($buildOutput -join "`n")"
  }

  $exe = Join-Path $tauriRoot 'target\release\gateway-benchmark.exe'
  if (-not (Test-Path $exe)) {
    throw "gateway benchmark harness binary not found at $exe"
  }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = '"{0}"' -f $FixtureRoot
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $proc = [System.Diagnostics.Process]::Start($psi)

  $portLine = $proc.StandardOutput.ReadLine()
  if (-not $portLine -or -not $portLine.StartsWith('BENCHMARK_PORT=')) {
    $err = $proc.StandardError.ReadToEnd()
    try { $proc.Kill() } catch { }
    throw "gateway benchmark harness did not report a port; stderr: $err"
  }
  # The harness performs the real launch-token exchange and reports the signed
  # cookie. Sending it keeps the measured requests on the authenticated route the
  # product serves, instead of a bypass the product never uses.
  $cookieLine = $proc.StandardOutput.ReadLine()
  if (-not $cookieLine -or -not $cookieLine.StartsWith('BENCHMARK_COOKIE=')) {
    $err = $proc.StandardError.ReadToEnd()
    try { $proc.Kill() } catch { }
    throw "gateway benchmark harness did not report a browser cookie; stderr: $err"
  }
  return [pscustomobject]@{
    Process = $proc
    Port    = [int]$portLine.Substring('BENCHMARK_PORT='.Length)
    Cookie  = $cookieLine.Substring('BENCHMARK_COOKIE='.Length)
  }
}

function Stop-BenchmarkServer($Server) {
  if ($null -eq $Server) { return }
  try { if (-not $Server.Process.HasExited) { $Server.Process.Kill() } } catch { }
  try { $Server.Process.WaitForExit(5000) | Out-Null } catch { }
  if ($Server.PSObject.Properties.Name -contains 'ScriptPath') {
    Remove-Item $Server.ScriptPath -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-StaticComparison {
  param([Parameter(Mandatory)][string]$FixtureRoot, [Parameter(Mandatory)]$Fingerprint)

  Write-Section 'LANE 9 - Static handler latency (no desktop launch)'

  $appJs = Join-Path $upstream 'apps\desktop\src\web-document.ts'
  $routes = @(
    @{ Name = 'index';   Path = '/';                Note = 'boot-injection path' }
    @{ Name = 'bigAsset'; Path = '/assets/big.js';  Note = 'bulk-read path' }
  )

  $results = @{}
  foreach ($side in @('reference', 'port')) {
    $server = $null
    try {
      if ($side -eq 'reference') {
        Write-Host 'Starting the pinned reference serveWebDocument...' -ForegroundColor DarkGray
        $server = Start-ReferenceStaticServer -FixtureRoot $FixtureRoot -AppJs $appJs
      } else {
        $server = Start-RustStaticServer -FixtureRoot $FixtureRoot
      }
      $baseUrl = "http://127.0.0.1:$($server.Port)"
      Write-Host ("  {0} listening on {1}" -f $side, $baseUrl) -ForegroundColor DarkGray

      # The reference lane runs the bare `serveWebDocument` function, which has no
      # authentication of its own; the port lane runs the real gateway, which does.
      # Both measurements are therefore of the static handler as each product
      # actually serves it.
      $cookie = if ($server.PSObject.Properties.Name -contains 'Cookie') { $server.Cookie } else { $null }

      foreach ($route in $routes) {
        $perRepetition = @()
        for ($rep = 1; $rep -le $Repetitions; $rep++) {
          $probe = Invoke-LatencyProbe -BaseUrl $baseUrl -Path $route.Path `
            -Requests $Requests -Warmup $Warmup -Cookie $cookie
          $perRepetition += $probe
          Write-Host ("    {0,-9} {1,-15} rep {2}/{3}  p50={4,7:N3}ms  p95={5,7:N3}ms  {6,8:N0} req/s" -f `
            $side, $route.Name, $rep, $Repetitions, $probe.p50Ms, $probe.p95Ms, $probe.perSecond)
        }
        $medians = $perRepetition | ForEach-Object { $_.p50Ms } | Sort-Object
        $p95s = $perRepetition | ForEach-Object { $_.p95Ms } | Sort-Object
        $rates = $perRepetition | ForEach-Object { $_.perSecond } | Sort-Object
        $results["$side/$($route.Name)"] = [pscustomobject]@{
          side             = $side
          route            = $route.Name
          note             = $route.Note
          medianOfP50Ms    = [math]::Round((Get-Percentile ([double[]]$medians) 50), 4)
          medianOfP95Ms    = [math]::Round((Get-Percentile ([double[]]$p95s) 50), 4)
          medianReqPerSec  = [math]::Round((Get-Percentile ([double[]]$rates) 50), 1)
          perRepetition    = $perRepetition
        }
      }
    } finally {
      Stop-BenchmarkServer $server
    }
  }

  Write-Section 'LANE 9 results - median of per-repetition medians'

  Write-Host ''
  Write-Host ('{0,-10} {1,-11} {2,12} {3,12} {4,12}' -f 'side', 'route', 'p50 ms', 'p95 ms', 'req/s') -ForegroundColor Yellow
  Write-Host ('-' * 60) -ForegroundColor DarkGray
  foreach ($key in @('port/index', 'reference/index', 'port/bigAsset', 'reference/bigAsset')) {
    if (-not $results.ContainsKey($key)) { continue }
    $r = $results[$key]
    Write-Host ('{0,-10} {1,-11} {2,12:N4} {3,12:N4} {4,12:N1}' -f `
      $r.side, $r.route, $r.medianOfP50Ms, $r.medianOfP95Ms, $r.medianReqPerSec)
  }

  Write-Host ''
  Write-Host @'
Scope limit: this is evidence about the static HTTP handler only. It says nothing
about startup to first usable UI, whole-tree memory, or UI latency, and it must not
be quoted as a product-performance claim. Lanes 1-8 in -Mode plan cover those and
each needs an approved isolated launch.
'@ -ForegroundColor DarkYellow

  New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
  $payload = [pscustomobject]@{
    lane        = 'static-handler'
    fingerprint = $Fingerprint
    results     = $results.Values
  }
  $jsonPath = Join-Path $OutputDir 'lane9-static.json'
  $payload | ConvertTo-Json -Depth 8 | Set-Content -Path $jsonPath -Encoding utf8
  Write-Host ''
  Write-Host "Raw samples written to $jsonPath" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

Write-Section 'DeepSeek Harness - reference vs port benchmark harness'
Write-Host "Mode: $Mode" -ForegroundColor Gray
Write-Host "Repository: $repoRoot" -ForegroundColor Gray
Write-Host ''
Write-Host 'This script never launches the desktop application and never starts a' -ForegroundColor Gray
Write-Host 'replacement GUI server. Lanes that need a launch are planned, not run.' -ForegroundColor Gray

$fingerprint = Get-MachineFingerprint

if ($Mode -eq 'plan' -or $Mode -eq 'all') {
  Show-Plan
  Write-Host ''
  Show-Fingerprint $fingerprint
}

if ($Mode -eq 'static' -or $Mode -eq 'all') {
  if (-not (Test-Path $upstream)) {
    throw "the read-only _upstream checkout is required for the reference lane and was not found at $upstream"
  }
  $fixtureRoot = Join-Path $OutputDir 'fixture'
  Write-Host ''
  Write-Host "Generating fixture tree ($FixtureBytes bytes per big asset)..." -ForegroundColor DarkGray
  New-FixtureTree -Root $fixtureRoot -AssetBytes $FixtureBytes | Out-Null
  $fixtureHash = (Get-FileHash (Join-Path $fixtureRoot 'assets\big.js') -Algorithm SHA256).Hash
  Write-Host "  fixture: $fixtureRoot" -ForegroundColor DarkGray
  Write-Host "  big.js sha256: $fixtureHash" -ForegroundColor DarkGray
  $fingerprint | Add-Member -NotePropertyName fixtureSha256 -NotePropertyValue $fixtureHash -Force

  Invoke-StaticComparison -FixtureRoot $fixtureRoot -Fingerprint $fingerprint
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
