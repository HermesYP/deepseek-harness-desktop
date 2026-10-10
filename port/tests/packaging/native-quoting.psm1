# Centralised native-command argument quoting for packaging qualification.
#
# WHY THIS MODULE EXISTS
#   Windows PowerShell 5.1 does not quote array elements when it builds the
#   command line for a native executable: `& makensis $a $b` with a path holding
#   a space silently truncates the argument (findings P2 in the 2026-10-10 scan).
#   PowerShell 7 quotes correctly, so the failure is edition-dependent and easy to
#   miss on the machine where it is written.
#
#   Every native invocation in the packaging suites therefore goes through this
#   module. `ConvertTo-DshNativeArgument` implements the documented MSVCRT rules
#   (backslashes before a quote are doubled; the whole argument is quoted when it
#   contains whitespace or a quote), and `Invoke-DshNativeChecked` hands the
#   finished command line to `Start-Process -ArgumentList <string>`, which passes
#   it verbatim on both editions.
#
#   This is quoting only. It never bypasses exit-code checks and never retries a
#   destructive command. Pure ASCII, Windows PowerShell 5.1 and 7 compatible;
#   the MSVCRT fallback is used unconditionally so one edition cannot behave
#   differently from the other.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:QuoteChar = [char]0x22      # "
$script:Backslash = [char]0x5C      # \

function Get-DshNativeQuotingMode {
    # Reported so an evidence log names the edition and the rule actually used.
    if ($PSVersionTable.PSVersion.Major -ge 7) { return 'pwsh-array' }
    return 'msvcrt-fallback'
}

function ConvertTo-DshNativeArgument {
    <#
    .SYNOPSIS
      Quote one argument for a native Windows command line.
    .DESCRIPTION
      Applies the MSVCRT parse rules command-line-to-argv conversion expects, so
      the argument arrives as exactly one argv element on either PowerShell
      edition. An empty argument becomes `""` rather than vanishing.
    #>
    param([AllowEmptyString()][AllowNull()][string]$Argument)

    if ($null -eq $Argument) { return '""' }
    if ($Argument.Length -gt 0 -and $Argument -notmatch '[\s"]') { return $Argument }

    $builder = New-Object System.Text.StringBuilder
    $null = $builder.Append($script:QuoteChar)
    $pending = 0
    foreach ($character in $Argument.ToCharArray()) {
        if ($character -eq $script:Backslash) {
            $pending++
            continue
        }
        if ($character -eq $script:QuoteChar) {
            # Backslashes that precede a quote are doubled, then the quote is escaped.
            if ($pending -gt 0) { $null = $builder.Append([string]::new($script:Backslash, $pending * 2)) }
            $null = $builder.Append($script:Backslash)
            $null = $builder.Append($script:QuoteChar)
            $pending = 0
            continue
        }
        if ($pending -gt 0) {
            $null = $builder.Append([string]::new($script:Backslash, $pending))
            $pending = 0
        }
        $null = $builder.Append($character)
    }
    # Trailing backslashes are doubled so the closing quote is not escaped.
    if ($pending -gt 0) { $null = $builder.Append([string]::new($script:Backslash, $pending * 2)) }
    $null = $builder.Append($script:QuoteChar)
    return $builder.ToString()
}

function ConvertTo-DshNativeArgumentList {
    <#
    .SYNOPSIS
      Build one verbatim command line from an argument array.
    #>
    param([AllowEmptyCollection()][string[]]$Arguments = @())

    $parts = @()
    foreach ($argument in $Arguments) { $parts += ConvertTo-DshNativeArgument -Argument $argument }
    return ($parts -join ' ')
}

function Invoke-DshNativeChecked {
    <#
    .SYNOPSIS
      Run a native executable with a correctly quoted command line and judge it
      only by its exit code.
    .DESCRIPTION
      `$ErrorActionPreference = 'Stop'` must not turn a tool's stderr into a
      terminating error (finding F-38), so the preference is scoped down around
      the call and restored in a `finally` whatever happens.

      Returns an object with ExitCode, StandardOutput, StandardError, CommandLine
      and QuotingMode. It never throws for a nonzero exit: the caller decides,
      because a suite that must report SKIP and a suite that must report FAIL
      both need the exit code.
    #>
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [AllowEmptyCollection()][string[]]$Arguments = @(),
        [string]$WorkingDirectory,
        [int]$TimeoutSeconds = 0,
        [switch]$PassThruOutput
    )

    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        throw "Native executable is not present: $FilePath"
    }
    $commandLine = ConvertTo-DshNativeArgumentList -Arguments $Arguments
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = $commandLine
    $startInfo.UseShellExecute = $false
    if ($WorkingDirectory) {
        if (-not (Test-Path -LiteralPath $WorkingDirectory -PathType Container)) {
            throw "Working directory is not present: $WorkingDirectory"
        }
        $startInfo.WorkingDirectory = $WorkingDirectory
    }
    $startInfo.RedirectStandardOutput = [bool]$PassThruOutput
    $startInfo.RedirectStandardError = [bool]$PassThruOutput

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        if (-not $process.Start()) { throw "Could not start $FilePath" }
        $stdout = ''
        $stderr = ''
        if ($PassThruOutput) {
            # Read both streams concurrently before waiting, or a full pipe blocks.
            $outTask = $process.StandardOutput.ReadToEndAsync()
            $errTask = $process.StandardError.ReadToEndAsync()
        }
        if ($TimeoutSeconds -gt 0) {
            if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
                try { $process.Kill() } catch { }
                $null = $process.WaitForExit(10000)
                throw "Native command exceeded ${TimeoutSeconds}s and was stopped: $FilePath"
            }
        } else {
            $process.WaitForExit()
        }
        if ($PassThruOutput) {
            $stdout = $outTask.GetAwaiter().GetResult()
            $stderr = $errTask.GetAwaiter().GetResult()
        }
        return [pscustomobject]@{
            ExitCode      = $process.ExitCode
            StandardOutput = $stdout
            StandardError = $stderr
            CommandLine   = "$FilePath $commandLine"
            QuotingMode   = (Get-DshNativeQuotingMode)
        }
    } finally {
        $ErrorActionPreference = $previous
        if ($null -ne $process) { $process.Dispose() }
    }
}

Export-ModuleMember -Function Get-DshNativeQuotingMode, ConvertTo-DshNativeArgument,
    ConvertTo-DshNativeArgumentList, Invoke-DshNativeChecked
