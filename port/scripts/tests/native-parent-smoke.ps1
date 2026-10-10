#Requires -Version 5.1
<#
Live Windows smoke on THIS PowerShell process only, not a product benchmark.
Run with process-local policy: powershell.exe -NoProfile -ExecutionPolicy Bypass -File <this script>
No command lines, credentials, environment blocks, or product processes are collected.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$module = Join-Path $PSScriptRoot '..\lib\process-tree.psm1'
Import-Module $module -Force -DisableNameChecking -ErrorAction Stop
if (-not (Initialize-ProcessTreeNativeReader)) {
    throw ('Native parent reader unavailable: ' + (Get-ProcessTreeNativeReaderError))
}

$selfProcess = Get-Process -Id $PID -ErrorAction Stop
try {
    $creationTicks = $selfProcess.StartTime.ToUniversalTime().Ticks
    $acceptedParent = [DshProcessTreeNative]::ParentProcessId($PID, $creationTicks)
    if ($acceptedParent -le 0) {
        throw 'Native parent reader rejected this process exact creation identity.'
    }
    foreach ($wrongTicks in @([long]0, [long]($creationTicks + 1))) {
        $rejectedParent = [DshProcessTreeNative]::ParentProcessId($PID, $wrongTicks)
        if ($rejectedParent -ne -1) {
            throw 'Native parent reader accepted a mismatched creation identity.'
        }
    }
    Write-Output 'PASS: 3 own-tool native creation-identity assertions; not product-performance evidence.'
} finally {
    $selfProcess.Dispose()
}
