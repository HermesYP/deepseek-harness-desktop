# Read-only integrity and process preflight for native qualification fixtures.
#
# WHY THIS MODULE EXISTS
#   The DSH Windows sandbox applies a standing `Mandatory Label\Low Mandatory
#   Level` (OI)(CI)(NW) label to the workspace tree. An executable created inside
#   the workspace inherits Low, and Windows starts it with a Low-integrity token
#   (S-1-16-4096). A no-write-up label blocks writes to higher-integrity objects;
#   it does not establish no-read-up. Named-pipe access also depends on its DACL
#   and label. Low execution produced the "EPERM, errno -4048 / process census too
#   small / connect EPERM" class of failures recorded in outputs/scan-2026-10-10.
#
#   The preflight here observes, and never repairs:
#
#     * parent  -- the current process token's integrity SID, via a native token
#                  query (GetTokenInformation / TokenIntegrityLevel);
#     * exe     -- the candidate image's mandatory label, via a native
#                  GetNamedSecurityInfo(LABEL_SECURITY_INFORMATION) read;
#     * child   -- the integrity SID of a process this module itself started,
#                  read from its token, which is the authoritative answer because
#                  it is what the kernel will actually enforce.
#
#   It NEVER relabels, resets, normalises or deletes: no `icacls
#   /setintegritylevel`, no ACL write, no `SetSecurityInfo`. A candidate whose
#   visibility cannot be established is refused (`unknown-visibility`), not
#   assumed healthy.
#
#   The "trusted plain copy" helper exists because the cheap, durable fix for the
#   whole class is to run the suites from a copy created OUTSIDE the labelled
#   workspace: files created in an unlabelled directory inherit Medium, so the
#   copy is Medium even though the source is Low. The helper copies real bytes
#   (never hardlinks or junctions), verifies each copy's SHA-256 against its
#   source, proves the destination is not a reparse point, and refuses a
#   destination whose observed label is below the parent's.
#
# Pure ASCII; Windows PowerShell 5.1 and 7 compatible. Windows only.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Native argument quoting is centralised; this module never joins arguments itself.
# Loaded without `-Force`: a forced nested re-import unloads the top-level instance
# and hides its commands from the caller (observed under Windows PowerShell 5.1).
if (-not (Get-Command -Name 'ConvertTo-DshNativeArgumentList' -ErrorAction SilentlyContinue)) {
    Import-Module (Join-Path $PSScriptRoot 'native-quoting.psm1') -Global -ErrorAction Stop
}

$script:CrossProcessOpen = 0x1000      # PROCESS_QUERY_LIMITED_INFORMATION
$script:TokenQuery = 0x0008            # TOKEN_QUERY
$script:TokenIntegrityLevel = 25       # TOKEN_INFORMATION_CLASS.TokenIntegrityLevel
$script:LabelSecurityInformation = 0x10
$script:SeFileObject = 1

if (-not ('DshIntegrityNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DshIntegrityNative
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int infoLength, out int returned);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr text);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern uint GetNamedSecurityInfo(string name, int objectType, uint securityInfo,
        out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetAce(IntPtr acl, int index, out IntPtr ace);

    private static string ToSidString(IntPtr sid)
    {
        IntPtr text;
        if (!ConvertSidToStringSid(sid, out text))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "ConvertSidToStringSid failed");
        try { return Marshal.PtrToStringUni(text); }
        finally { LocalFree(text); }
    }

    public static string TokenIntegritySid(int pid)
    {
        IntPtr process = OpenProcess(0x1000u, false, pid);
        if (process == IntPtr.Zero)
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "OpenProcess failed");
        try
        {
            IntPtr token;
            if (!OpenProcessToken(process, 0x0008u, out token))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "OpenProcessToken failed");
            try
            {
                int length;
                GetTokenInformation(token, 25, IntPtr.Zero, 0, out length);
                if (length <= 0)
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "GetTokenInformation size query failed");
                IntPtr buffer = Marshal.AllocHGlobal(length);
                try
                {
                    int returned;
                    if (!GetTokenInformation(token, 25, buffer, length, out returned))
                        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "GetTokenInformation failed");
                    IntPtr sid = Marshal.ReadIntPtr(buffer);
                    return ToSidString(sid);
                }
                finally { Marshal.FreeHGlobal(buffer); }
            }
            finally { CloseHandle(token); }
        }
        finally { CloseHandle(process); }
    }

    public static string FileLabelSid(string path)
    {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint status = GetNamedSecurityInfo(path, 1, 0x10u, out owner, out group, out dacl, out sacl, out descriptor);
        if (status != 0)
            throw new System.ComponentModel.Win32Exception((int)status, "GetNamedSecurityInfo(LABEL_SECURITY_INFORMATION) failed");
        try
        {
            if (sacl == IntPtr.Zero) return null;
            // A SACL can hold audit ACEs as well as the mandatory-label ACE, and the
            // first ACE is not necessarily the label. Reading the first ACE blindly
            // misreported objects that carry an audit ACE (observed on C:\), so the
            // ACE type is checked: SYSTEM_MANDATORY_LABEL_ACE == 0x11.
            ushort aceCount = (ushort)Marshal.ReadInt16(sacl, 4);
            for (int index = 0; index < aceCount; index++)
            {
                IntPtr ace;
                if (!GetAce(sacl, index, out ace))
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "GetAce failed");
                // AceType is the LOW byte of the first WORD: the high byte carries
                // AceFlags, and an INHERITED_ACE (0x10) label is still a label. Reading
                // the WORD and comparing to 0x11 skipped every inherited label and made
                // an explicitly Low file read as "absent".
                ushort aceType = (ushort)(Marshal.ReadInt16(ace, 0) & 0xFF);
                if (aceType != 0x11) continue;
                IntPtr sid = new IntPtr(ace.ToInt64() + 8);
                return ToSidString(sid);
            }
            return null;
        }
        finally { LocalFree(descriptor); }
    }
}
'@ -ErrorAction Stop
}

function Get-DshIntegrityFromSid {
    <#
    .SYNOPSIS
      Translate a mandatory-label SID into an integrity level, or a known-absent
      observation. Never guesses: an unreadable SID is `Known = $false`.
    #>
    param([AllowNull()][AllowEmptyString()][string]$Sid)

    if ([string]::IsNullOrWhiteSpace($Sid)) {
        return [pscustomobject]@{ Sid = $null; Rid = $null; Level = 'absent'; Known = $false }
    }
    if ($Sid -notmatch '^S-1-16-(?<rid>\d+)$') {
        return [pscustomobject]@{ Sid = $Sid; Rid = $null; Level = 'unrecognised'; Known = $false }
    }
    $rid = [int]$Matches.rid
    $level = switch ($rid) {
        0 { 'untrusted' }
        default {
            if ($rid -ge 0x5000) { 'protected' }
            elseif ($rid -ge 0x4000) { 'system' }
            elseif ($rid -ge 0x3000) { 'high' }
            elseif ($rid -ge 0x2000) { 'medium' }
            elseif ($rid -ge 0x1000) { 'low' }
            else { 'untrusted' }
        }
    }
    return [pscustomobject]@{ Sid = $Sid; Rid = $rid; Level = $level; Known = $true }
}

function Get-DshProcessIntegrity {
    <#
    .SYNOPSIS
      The integrity level of a live process token, read with a native API.
    .DESCRIPTION
      Refuses to answer when the query fails: `Known = $false` with the Win32
      reason. A Low token cannot open a higher-integrity process at all, so an
      unknown answer here is exactly the signal that visibility is broken.
    #>
    param([int]$ProcessId = $PID)

    if ($ProcessId -le 0) { throw 'A positive process id is required.' }
    if ($env:OS -ne 'Windows_NT') {
        return [pscustomobject]@{ ProcessId = $ProcessId; Sid = $null; Rid = $null; Level = 'not-windows'; Known = $false; Reason = 'not Windows' }
    }
    try {
        $sid = [DshIntegrityNative]::TokenIntegritySid($ProcessId)
        $integrity = Get-DshIntegrityFromSid -Sid $sid
        return [pscustomobject]@{ ProcessId = $ProcessId; Sid = $integrity.Sid; Rid = $integrity.Rid;
            Level = $integrity.Level; Known = $integrity.Known; Reason = '' }
    } catch {
        return [pscustomobject]@{ ProcessId = $ProcessId; Sid = $null; Rid = $null;
            Level = 'unknown'; Known = $false; Reason = $_.Exception.Message }
    }
}

function Get-DshFileIntegrityLabel {
    <#
    .SYNOPSIS
      Read the mandatory label of a file OR directory without changing it.
    .DESCRIPTION
      The label lives in the object's SACL. Reading it needs no privilege here
      because the mandatory-label ACE is readable, but a hardened host may return
      ERROR_PRIVILEGE_NOT_HELD; that is reported as `Known = $false` and the
      caller refuses rather than assuming.

      A directory is accepted because a fresh DIRECTORY's label is the evidence
      that a fixture root was created outside a labelled tree (its children then
      inherit it), which is exactly what the copy helper must prove.
    #>
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { throw "No file to label-read: $Path" }
    if ($env:OS -ne 'Windows_NT') {
        return [pscustomobject]@{ Path = $Path; Sid = $null; Rid = $null; Level = 'not-windows'; Known = $false; Reason = 'not Windows' }
    }
    try {
        $sid = [DshIntegrityNative]::FileLabelSid($Path)   # $null == no explicit label (inherits effective)
        if ([string]::IsNullOrWhiteSpace($sid)) {
            return [pscustomobject]@{ Path = $Path; Sid = $null; Rid = $null; Level = 'absent'; Known = $true; Reason = 'no explicit label' }
        }
        $integrity = Get-DshIntegrityFromSid -Sid $sid
        return [pscustomobject]@{ Path = $Path; Sid = $integrity.Sid; Rid = $integrity.Rid;
            Level = $integrity.Level; Known = $integrity.Known; Reason = '' }
    } catch {
        return [pscustomobject]@{ Path = $Path; Sid = $null; Rid = $null;
            Level = 'unknown'; Known = $false; Reason = $_.Exception.Message }
    }
}

function Get-DshEffectiveIntegrity {
    <#
    .SYNOPSIS
      What is ENFORCED for a path, plus what its new children will inherit.
    .DESCRIPTION
      Windows mandatory integrity does not walk ancestors at access time: an object
      with no explicit label is treated as Medium, whatever its parent says. What
      the parent decides is the label a NEW child inherits at creation.

      So this reports both facts and never conflates them:
        * `Enforced`  - the object's own label, or `medium` when it has none;
        * `Level`     - the same value, kept as the primary name for callers;
        * `LevelSource`/`Source` - `explicit`, or the nearest labelled ancestor for
          the inheritance question, or `unlabelled`;
        * `InheritedLabel` - the nearest labelled ancestor's level, if any.
      A file created before a directory was labelled therefore reads `medium`
      enforced with a `low` inherited label for new siblings, which is exactly the
      distinction that made an earlier version of this reader misleading.
    #>
    param([Parameter(Mandatory)][string]$Path)

    $own = Get-DshFileIntegrityLabel -Path $Path
    if (-not $own.Known) {
        return [pscustomobject]@{ Path = $Path; Level = 'unknown'; Enforced = 'unknown'; Known = $false
            Source = 'own-read-failed'; LevelSource = 'own-read-failed'; InheritedLabel = $null; Reason = $own.Reason }
    }

    $inherited = $null
    $inheritedFrom = $null
    $walk = $Path
    while ($true) {
        $parent = Split-Path -Parent $walk
        if (-not $parent -or $parent -eq $walk) { break }
        $walk = $parent
        if (-not (Test-Path -LiteralPath $walk)) { break }
        $ancestor = Get-DshFileIntegrityLabel -Path $walk
        if (-not $ancestor.Known) { break }
        if ($ancestor.Level -ne 'absent') { $inherited = $ancestor.Level; $inheritedFrom = $walk; break }
    }

    $enforced = if ($own.Level -eq 'absent') { 'medium' } else { $own.Level }
    $levelSource = if ($own.Level -ne 'absent') { 'explicit' } elseif ($inheritedFrom) { $inheritedFrom } else { 'unlabelled' }
    return [pscustomobject]@{
        Path = $Path
        Level = $enforced
        Enforced = $enforced
        Known = $true
        Source = $levelSource
        LevelSource = $levelSource
        InheritedLabel = $inherited
        InheritedFrom = $inheritedFrom
        Reason = if ($own.Level -eq 'absent' -and $inherited) { "no explicit label; new children would inherit $inherited" } else { '' }
    }
}

function Assert-DshNoLinkedAncestors {
    <#
    .SYNOPSIS
      Refuse a path that traverses a reparse point at or above it.
    #>
    param([Parameter(Mandatory)][string]$Path)

    $walk = $Path
    while ($walk) {
        if (Test-Path -LiteralPath $walk -ErrorAction SilentlyContinue) {
            $item = Get-Item -LiteralPath $walk -Force -ErrorAction Stop
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Qualification path traverses a reparse point: $walk"
            }
        }
        $parent = Split-Path -Parent $walk
        if (-not $parent -or $parent -eq $walk) { break }
        $walk = $parent
    }
}

function Get-DshQualificationBase {
    # Short and outside the workspace: `%LOCALAPPDATA%\DSH-Qualification`.
    # Keeping it short keeps every fixture path well under MAX_PATH.
    $local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    if ([string]::IsNullOrWhiteSpace($local)) { throw 'LocalApplicationData could not be resolved.' }
    return (Join-Path $local 'DSH-Qualification')
}

function New-DshQualificationRoot {
    <#
    .SYNOPSIS
      Create a fresh, short, uniquely named qualification root OUTSIDE the
      workspace, with a bounded path length.
    .DESCRIPTION
      Deliberately not under the repository: a directory created inside the
      labelled workspace would give every copy created in it the Low label, which
      is the hazard this module exists to detect. An existing root is never
      reused or cleared.
    #>
    param(
        [Parameter(Mandatory)][ValidatePattern('^[a-z0-9][a-z0-9-]{0,24}$')][string]$Prefix,
        [int]$MaxPathLength = 180
    )

    $base = Get-DshQualificationBase
    $leaf = '{0}-{1}' -f $Prefix, ([guid]::NewGuid().ToString('N').Substring(0, 8))
    $root = Join-Path $base $leaf
    if ($root.Length -gt $MaxPathLength) {
        throw "Qualification root would be $($root.Length) characters, over the $MaxPathLength bound. Choose a shorter prefix or base."
    }
    Assert-DshNoLinkedAncestors $base
    if (Test-Path -LiteralPath $root) { throw "Qualification root already exists; preserved unmodified: $root" }
    $null = New-Item -ItemType Directory -Path $base -Force -ErrorAction Stop
    $null = New-Item -ItemType Directory -Path $root -ErrorAction Stop
    Write-Host "QUALIFICATION_ROOT=$root; outside workspace; retained"
    return $root
}

function Copy-DshTrustedPlainCopy {
    <#
    .SYNOPSIS
      Copy real bytes into an owned qualification root and prove the copy is not
      downgraded.
    .DESCRIPTION
      Never a hardlink, junction or symbolic link: the copy must be a new file so
      it inherits the destination directory's label. Each file is hashed before
      and after, and a destination whose observed label sits below the parent's
      integrity is refused, because that means the destination is itself inside a
      labelled tree and the whole point of the copy was lost.
    #>
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][string]$DestinationRoot,
        [Parameter(Mandatory)][string[]]$RelativePaths,
        [Parameter(Mandatory)][string]$ParentIntegrity,
        [int]$MaxPathLength = 240
    )

    if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) { throw "Copy source is absent: $SourceRoot" }
    if (-not (Test-Path -LiteralPath $DestinationRoot -PathType Container)) { throw "Copy destination is absent: $DestinationRoot" }
    Assert-DshNoLinkedAncestors $DestinationRoot

    $copied = @()
    foreach ($relative in $RelativePaths) {
        $source = Join-Path $SourceRoot $relative
        if (-not (Test-Path -LiteralPath $source)) { throw "Copy source member is absent: $source" }
        $sourceItem = Get-Item -LiteralPath $source -Force
        if (($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Copy source member is a reparse point, which cannot be proven to ship: $source"
        }
        $destination = Join-Path $DestinationRoot $relative
        if ($destination.Length -gt $MaxPathLength) {
            throw "Copied path would be $($destination.Length) characters, over the $MaxPathLength bound: $relative"
        }
        $parent = Split-Path -Parent $destination
        if (-not (Test-Path -LiteralPath $parent)) { $null = New-Item -ItemType Directory -Path $parent -Force -ErrorAction Stop }

        if ($sourceItem.PSIsContainer) {
            # Directory members are copied file by file so every leaf is verifiable.
            $files = @(Get-ChildItem -LiteralPath $source -Recurse -Force -File -ErrorAction Stop)
            foreach ($file in $files) {
                if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                    throw "Copy source tree holds a reparse point: $($file.FullName)"
                }
                $suffix = $file.FullName.Substring($source.Length).TrimStart('\')
                $target = Join-Path $destination $suffix
                if ($target.Length -gt $MaxPathLength) { throw "Copied path over bound: $target" }
                $targetParent = Split-Path -Parent $target
                if (-not (Test-Path -LiteralPath $targetParent)) { $null = New-Item -ItemType Directory -Path $targetParent -Force -ErrorAction Stop }
                $null = Copy-Item -LiteralPath $file.FullName -Destination $target -Force -ErrorAction Stop
                $before = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
                $after = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
                if ($before -ne $after) { throw "Copied bytes differ from source: $target" }
                $copied += $target
            }
        } else {
            $null = Copy-Item -LiteralPath $source -Destination $destination -Force -ErrorAction Stop
            $before = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
            $after = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
            if ($before -ne $after) { throw "Copied bytes differ from source: $destination" }
            $copied += $destination
        }
    }
    if ($copied.Count -eq 0) { throw 'The trusted plain copy produced no files; refusing to report a copy.' }

    $label = Get-DshFileIntegrityLabel -Path $copied[0]
    if (-not $label.Known) {
        throw "Copied file label could not be read ($($label.Reason)); refusing unknown visibility for $($copied[0])"
    }
    if ($label.Level -eq 'low' -and $ParentIntegrity -notin @('low', 'untrusted')) {
        throw "Copied file landed at Low integrity ($($copied[0])) while the parent is $ParentIntegrity; the destination is inside a labelled tree and is not a trusted plain copy."
    }
    Write-Host "QUALIFICATION_COPY=files=$($copied.Count) first=$($copied[0]) label=$($label.Level) parent=$ParentIntegrity"
    return [pscustomobject]@{ Root = $DestinationRoot; Files = $copied; FirstLabel = $label.Level; Count = $copied.Count }
}

function Get-DshPinnedQualificationNode {
    <#
    .SYNOPSIS
      Resolve ONE explicitly pinned Node interpreter and attest it by version,
      byte hash and process token before it is used for anything.
    .DESCRIPTION
      The pin is the source-controlled `port/installer/node-runtime.json` version
      plus the image digest. The image digest is taken from the packaged payload
      interpreter (`runtime-payload/dsh/node/node.exe`) so the candidate must be
      byte-identical to the interpreter the installer ships; the archive digest
      in the pin is checked too, so a stale pin is named rather than tolerated.

      Every candidate is refused unless ALL of these hold:
        * the file exists and is not a reparse point;
        * its SHA-256 equals the packaged payload interpreter's SHA-256;
        * `--version` prints exactly `v<pinned version>`;
        * its process token integrity can be read (unknown visibility refuses).

      Nothing is downloaded, installed, relabelled or replaced.
    #>
    param(
        [Parameter(Mandatory)][string]$PortRoot,
        [string[]]$CandidatePaths = @(),
        [string]$ExpectedVersion,
        [string]$ExpectedImageSha256,
        [int]$VersionProbeSeconds = 60
    )

    $pinPath = Join-Path $PortRoot 'installer\node-runtime.json'
    $recordPath = Join-Path $PortRoot 'installer\runtime-payload.json'
    if (-not (Test-Path -LiteralPath $pinPath)) { throw "Pinned Node manifest is absent: $pinPath" }
    $pin = Get-Content -LiteralPath $pinPath -Raw | ConvertFrom-Json
    # An explicit target choice: the pin declares per-target digests, so the host
    # architecture must name one rather than defaulting to whatever is on PATH.
    $targetName = if ($env:PROCESSOR_ARCHITECTURE -in @('ARM64', 'arm64')) { 'win-arm64' } else { 'win-x64' }
    $pinTarget = $pin.targets.$targetName
    if ($null -eq $pinTarget) { throw "The pinned Node manifest has no entry for $targetName." }
    $version = if ($ExpectedVersion) { $ExpectedVersion } else { $pin.nodeVersion }
    if ($pin.nodeVersion -ne $version) {
        throw "Pinned Node version mismatch: manifest says $($pin.nodeVersion), the caller asked for $version."
    }
    $archiveSha = $pinTarget.sha256

    if (Test-Path -LiteralPath $recordPath) {
        $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
        if ($record.node.version -ne $version) {
            throw "Packaged runtime descriptor pins Node $($record.node.version), not $version."
        }
        if ($record.node.sha256 -ne $archiveSha) {
            throw "Packaged runtime descriptor archive digest $($record.node.sha256) differs from the pin $archiveSha."
        }
    } else {
        throw "Packaged runtime descriptor is absent, so the pin cannot be cross-checked: $recordPath"
    }

    $payloadNode = Join-Path $PortRoot 'runtime-payload\dsh\node\node.exe'
    $imageSha = $ExpectedImageSha256
    if (-not $imageSha) {
        if (-not (Test-Path -LiteralPath $payloadNode -PathType Leaf)) {
            throw "The packaged payload interpreter is absent, so no image digest can be attested: $payloadNode"
        }
        $imageSha = (Get-FileHash -LiteralPath $payloadNode -Algorithm SHA256).Hash.ToLowerInvariant()
    }

    $candidates = @()
    $candidates += $CandidatePaths
    $local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    if ($local -and (Test-Path -LiteralPath $local)) {
        $candidates += @(Get-ChildItem -LiteralPath $local -Directory -Filter 'eperm-bin-*' -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName 'pinnednode.exe' })
    }
    $candidates += $payloadNode
    $candidates = @($candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -Unique)
    if ($candidates.Count -eq 0) { throw 'No pinned Node candidate exists on this host; refusing to substitute a system interpreter.' }

    $rejections = @()
    foreach ($candidate in $candidates) {
        $full = (Resolve-Path -LiteralPath $candidate).Path
        try {
            $item = Get-Item -LiteralPath $full -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'candidate is a reparse point' }
            $hash = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($hash -ne $imageSha) { throw "image digest $hash differs from the packaged interpreter $imageSha" }
            $label = Get-DshFileIntegrityLabel -Path $full
            $probe = Invoke-DshNativeChecked -FilePath $full -Arguments @('--version') -WorkingDirectory (Split-Path -Parent $full) -TimeoutSeconds $VersionProbeSeconds -PassThruOutput
            if ($probe.ExitCode -ne 0) { throw "version probe exited $($probe.ExitCode): $($probe.StandardError.Trim())" }
            $observed = $probe.StandardOutput.Trim()
            if ($observed -ne "v$version") { throw "version probe printed '$observed', expected 'v$version'" }
            $rejections += [pscustomobject]@{ Path = $full; Rejected = $false; Reason = '' }
            Write-Host "PINNED_NODE=$full version=$version sha256=$hash label=$($label.Level) archiveSha256=$archiveSha"
            return [pscustomobject]@{
                Path = $full; Version = $version; ImageSha256 = $hash; ArchiveSha256 = $archiveSha
                Target = $targetName; LabelLevel = $label.Level; LabelKnown = $label.Known
                Source = if ($full -eq $payloadNode) { 'payload' } else { 'external-copy' }
                QuotingMode = (Get-DshNativeQuotingMode)
            }
        } catch {
            $rejections += [pscustomobject]@{ Path = $full; Rejected = $true; Reason = $_.Exception.Message }
            Write-Host "PINNED_NODE_REJECTED=$full reason=$($_.Exception.Message)"
        }
    }
    $why = ($rejections | Where-Object { $_.Rejected } | ForEach-Object { "$($_.Path): $($_.Reason)" }) -join '; '
    throw "No candidate interpreter satisfies the pinned version $version and hash attestation. Rejections: $why"
}

function Test-DshChildPreflight {
    <#
    .SYNOPSIS
      Prove the pinned interpreter can actually do the four things every native
      fixture depends on, using a process this function owns.
    .DESCRIPTION
      Four probes, all inside the caller's owned root (never the repo root, never
      `%TEMP%`):

        * process-owned write  -- the child creates a file and the parent reads it;
        * process-sentinel     -- the child writes a temp file and renames it, so a
                                  half-written sentinel can never be mistaken for one;
        * named pipe           -- the parent owns a pipe server and the child
                                  connects, which is the exact operation a Low
                                  client cannot perform against a Medium server;
        * watchdog             -- a deliberately hanging child is bounded, stopped
                                  by the exact PID this function started, and the
                                  parent's visibility is re-checked afterwards.

      Every failure is reported as a specific reason. No image-name kill, no
      descendant kill, no `Stop-Process -Name`.
    #>
    param(
        [Parameter(Mandatory)][string]$NodePath,
        [Parameter(Mandatory)][string]$OwnedRoot,
        [int]$PipeSeconds = 20,
        [int]$WatchdogSeconds = 10
    )

    if (-not (Test-Path -LiteralPath $OwnedRoot -PathType Container)) { throw "Owned root is absent: $OwnedRoot" }
    Assert-DshNoLinkedAncestors $OwnedRoot
    $root = (Resolve-Path -LiteralPath $OwnedRoot).Path
    $parentIntegrity = Get-DshProcessIntegrity -ProcessId $PID
    if (-not $parentIntegrity.Known) { throw "Parent integrity is unknown ($($parentIntegrity.Reason)); refusing to run native fixtures under unknown visibility." }

    # --- probe 1+2+3: one child performs the write, the sentinel and the pipe.
    $pipeName = 'dsh-preflight-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
    $pipePath = '\\.\pipe\' + $pipeName
    # InOut, not In: libuv (Node) opens a named-pipe client with read AND write
    # access, so an In-only server rejects that open with ACCESS_DENIED and the
    # child would appear to "never connect" for a reason that has nothing to do
    # with integrity.
    $server = New-Object System.IO.Pipes.NamedPipeServerStream($pipeName,
        [System.IO.Pipes.PipeDirection]::InOut, 1,
        [System.IO.Pipes.PipeTransmissionMode]::Byte,
        [System.IO.Pipes.PipeOptions]::Asynchronous)
    $childScript = @'
const fs = require('fs');
const net = require('net');
const root = process.argv[2];
fs.writeFileSync(root + '\\write-probe.txt', 'write-ok');
fs.writeFileSync(root + '\\sentinel.tmp', 'sentinel-ok');
fs.renameSync(root + '\\sentinel.tmp', root + '\\sentinel.txt');
// The parent closes its end as soon as it has read the payload, so a read error
// AFTER a successful connect/write is the parent finishing, not a failure. Only a
// failure to connect is reported as an error.
let connected = false;
const socket = net.connect(process.env.DSH_PREFLIGHT_PIPE, () => {
  connected = true;
  socket.end('pipe-ok', () => process.exit(0));
});
socket.on('error', error => {
  if (!connected) { process.stderr.write('pipe-error:' + error.message); process.exit(3); }
  process.exit(0);
});
'@
    $probePath = Join-Path $root 'child-preflight.cjs'
    Set-Content -LiteralPath $probePath -Value $childScript -Encoding Ascii

    $previousPipe = $env:DSH_PREFLIGHT_PIPE
    $child = $null
    try {
        $env:DSH_PREFLIGHT_PIPE = $pipePath
        $argumentLine = ConvertTo-DshNativeArgumentList -Arguments @($probePath, $root)
        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $NodePath
        $startInfo.Arguments = $argumentLine
        $startInfo.WorkingDirectory = $root
        $startInfo.UseShellExecute = $false
        # Only stderr is redirected: the probe writes nothing to stdout, and an
        # unread redirected pipe is itself a hang risk.
        $startInfo.RedirectStandardError = $true
        $child = New-Object System.Diagnostics.Process
        $child.StartInfo = $startInfo
        $null = $child.Start()
    } finally {
        $env:DSH_PREFLIGHT_PIPE = $previousPipe
    }

    $childIntegrity = Get-DshProcessIntegrity -ProcessId $child.Id
    if (-not $childIntegrity.Known) {
        try { if (-not $child.HasExited) { $child.Kill() } } catch { }
        throw "Child integrity is unknown ($($childIntegrity.Reason)); refusing unknown visibility instead of assuming the child is trustworthy."
    }
    if ($childIntegrity.Level -eq 'low' -and $parentIntegrity.Level -eq 'medium') {
        try { if (-not $child.HasExited) { $child.Kill() } } catch { }
        throw "INTERPRETER_IMAGE_IS_LOW_INTEGRITY: the child of $NodePath runs at Low ($($childIntegrity.Sid)) while this parent is Medium. A Low child cannot write up to the qualification root or open a Medium-owned pipe, which is the documented EPERM cause. Run from a trusted plain copy outside the labelled workspace, or choose an interpreter whose image is not Low. No relabel was attempted."
    }

    $connected = $false
    try {
        $wait = $server.WaitForConnectionAsync()
        if (-not $wait.Wait($PipeSeconds * 1000)) {
            throw "the child never connected to the owned named pipe within ${PipeSeconds}s"
        }
        $connected = $true
        # Bounded read: a connected client that never sends must not hang the run
        # (ReadTimeout is unsupported on an asynchronous pipe, so the read is
        # awaited with an explicit bound instead).
        $buffer = New-Object byte[] 64
        $readTask = $server.ReadAsync($buffer, 0, $buffer.Length)
        if (-not $readTask.Wait($PipeSeconds * 1000)) {
            throw "the child connected but sent no payload within ${PipeSeconds}s"
        }
        $read = $readTask.Result
        $pipeText = [System.Text.Encoding]::ASCII.GetString($buffer, 0, $read)
        if ($pipeText -ne 'pipe-ok') { throw "the owned named pipe carried '$pipeText', not 'pipe-ok'" }
    } catch {
        # Preserve the child's own diagnosis: without it a pipe failure reads as an
        # integrity problem even when the child failed for an unrelated reason.
        $childReason = ''
        try {
            if (-not $child.HasExited) { $child.Kill(); $null = $child.WaitForExit(10000) }
            $childReason = $child.StandardError.ReadToEnd()
        } catch { }
        throw "Named-pipe preflight failed: $($_.Exception.Message)$(if ($childReason) { " (child stderr: $($childReason.Trim()))" })"
    } finally {
        if ($connected) { $server.Disconnect() }
        $server.Dispose()
    }

    if (-not $child.WaitForExit(30000)) {
        try { if (-not $child.HasExited) { $child.Kill() } } catch { }
        throw 'The write/sentinel/pipe child did not exit within 30s.'
    }
    $stderr = $child.StandardError.ReadToEnd()
    if ($child.ExitCode -ne 0) { throw "The write/sentinel/pipe child exited $($child.ExitCode): $stderr" }

    $writeProbe = Join-Path $root 'write-probe.txt'
    $sentinel = Join-Path $root 'sentinel.txt'
    if (-not (Test-Path -LiteralPath $writeProbe)) { throw 'Process-owned write probe did not produce its file.' }
    if ((Get-Content -LiteralPath $writeProbe -Raw).Trim() -ne 'write-ok') { throw 'Process-owned write probe wrote unexpected content.' }
    if (Test-Path -LiteralPath (Join-Path $root 'sentinel.tmp')) { throw 'Process-sentinel temp file survived; the rename did not complete.' }
    if (-not (Test-Path -LiteralPath $sentinel)) { throw 'Process-sentinel final file is absent.' }

    # --- probe 4: watchdog. A hanging child is observed, bounded and stopped by
    # the exact PID started here; then visibility is re-proved.
    $hanging = $null
    $watchdogStopped = $false
    try {
        $hangLine = ConvertTo-DshNativeArgumentList -Arguments @('-e', 'setInterval(() => {}, 1000)')
        $hangInfo = New-Object System.Diagnostics.ProcessStartInfo
        $hangInfo.FileName = $NodePath
        $hangInfo.Arguments = $hangLine
        $hangInfo.WorkingDirectory = $root
        $hangInfo.UseShellExecute = $false
        $hanging = New-Object System.Diagnostics.Process
        $hanging.StartInfo = $hangInfo
        $null = $hanging.Start()
        $hangIdentity = Get-DshProcessIntegrity -ProcessId $hanging.Id
        if (-not $hangIdentity.Known) { throw "Watchdog child integrity is unknown: $($hangIdentity.Reason)" }
        if ($hanging.WaitForExit($WatchdogSeconds * 1000)) {
            throw 'The watchdog child exited on its own; the watchdog probe proves nothing.'
        }
        $hanging.Kill()
        if (-not $hanging.WaitForExit(10000)) { throw 'The watchdog child survived a direct-Kill of its own PID.' }
        $watchdogStopped = $true
    } finally {
        if ($null -ne $hanging) {
            try { if (-not $hanging.HasExited) { $hanging.Kill() } } catch { }
            $hanging.Dispose()
        }
    }
    $afterVisibility = Get-DshProcessIntegrity -ProcessId $PID
    if (-not $afterVisibility.Known) { throw 'Visibility was lost after the watchdog probe.' }

    $record = [pscustomobject]@{
        NodePath = $NodePath
        ParentIntegrity = $parentIntegrity
        ChildIntegrity = $childIntegrity
        Pipe = 'pipe-ok'
        Write = 'write-ok'
        Sentinel = 'sentinel-ok'
        WatchdogStopped = $watchdogStopped
        Root = $root
    }
    Write-Host "CHILD_PREFLIGHT=ok parent=$($parentIntegrity.Level) child=$($childIntegrity.Level) pipe=ok write=ok sentinel=ok watchdog=stopped"
    return $record
}

function Assert-DshQualificationPreflight {
    <#
    .SYNOPSIS
      The one entry point the suites and the launcher call: resolve the pinned
      interpreter, prove its integrity and run the four child probes.
    #>
    param(
        [Parameter(Mandatory)][string]$PortRoot,
        [string]$OwnedRoot,
        [string[]]$CandidatePaths = @()
    )

    $parent = Get-DshProcessIntegrity -ProcessId $PID
    if (-not $parent.Known) {
        throw "REFUSED_UNKNOWN_VISIBILITY: this process's own integrity could not be read ($($parent.Reason)). Native qualification is refused rather than assumed."
    }
    $node = Get-DshPinnedQualificationNode -PortRoot $PortRoot -CandidatePaths $CandidatePaths
    if ($node.LabelKnown -and $node.LabelLevel -eq 'low' -and $parent.Level -eq 'medium') {
        throw "INTERPRETER_IMAGE_IS_LOW_INTEGRITY: $($node.Path) carries Low ($($node.LabelLevel)) while this parent is Medium. No relabel was attempted; select an interpreter outside the labelled workspace."
    }
    $root = if ($OwnedRoot) { $OwnedRoot } else { New-DshQualificationRoot -Prefix 'preflight' }
    $preflight = Test-DshChildPreflight -NodePath $node.Path -OwnedRoot $root
    return [pscustomobject]@{
        ParentIntegrity = $parent
        Node = $node
        Child = $preflight
        Root = $root
        Visibility = 'known'
    }
}

Export-ModuleMember -Function Get-DshIntegrityFromSid, Get-DshProcessIntegrity,
    Get-DshFileIntegrityLabel, Get-DshEffectiveIntegrity, New-DshQualificationRoot,
    Copy-DshTrustedPlainCopy, Get-DshPinnedQualificationNode, Test-DshChildPreflight,
    Assert-DshQualificationPreflight, Assert-DshNoLinkedAncestors
