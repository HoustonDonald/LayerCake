<#
.SYNOPSIS
    Creates (or removes) a per-user LayerCake shortcut pointing at layercake.cmd.

.DESCRIPTION
    Writes LayerCake.lnk to the per-user Start Menu, and optionally to the
    Desktop. Per-user on purpose: the machine-wide Start Menu needs elevation,
    and a launcher for a localhost development tool has no business asking for
    admin rights.

    Idempotent. Re-running overwrites the shortcut in place, so this doubles as
    the repair path after the project directory moves.

    Runs under Windows PowerShell 5.1 and PowerShell 7. It calls no native
    executable anywhere, which sidesteps 5.1's habit of stripping embedded
    double quotes out of native command lines: everything here goes through
    .NET and COM, where arguments are passed as objects rather than as a
    re-parsed string.

.PARAMETER Desktop
    Also write the shortcut to the user's Desktop.

.PARAMETER Uninstall
    Remove the Start Menu shortcut, and the Desktop one if it exists.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\install-shortcut.ps1 -Desktop

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\install-shortcut.ps1 -Uninstall
#>

[CmdletBinding()]
param(
    [switch]$Desktop,
    [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ShortcutName = 'LayerCake.lnk'

# $PSScriptRoot is this file's directory, so the project root is its parent.
# Derived rather than assumed, so the script keeps working from any working
# directory and after the project is moved.
$projectRoot = Split-Path -Parent $PSScriptRoot
$target      = Join-Path $projectRoot 'layercake.cmd'

# GetFolderPath returns the per-user locations. 'Programs' is
# %APPDATA%\Microsoft\Windows\Start Menu\Programs, never the machine-wide
# %ProgramData% one, so nothing here needs elevation.
$startMenuDir = [Environment]::GetFolderPath('Programs')
$desktopDir   = [Environment]::GetFolderPath('DesktopDirectory')

$startMenuLink = Join-Path $startMenuDir $ShortcutName
$desktopLink   = Join-Path $desktopDir   $ShortcutName

function Remove-LayerCakeShortcut {
    param([string]$Path)

    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Force
        Write-Host "Removed: $Path"
    }
    else {
        Write-Host "Not present: $Path"
    }
}

if ($Uninstall) {
    # Both are removed regardless of -Desktop: uninstall should clean up
    # everything this script can create, not just what today's flags describe.
    Remove-LayerCakeShortcut -Path $startMenuLink
    Remove-LayerCakeShortcut -Path $desktopLink
    return
}

if (-not (Test-Path -LiteralPath $target)) {
    Write-Error "layercake.cmd not found at $target. Run this from the LayerCake checkout, or restore the file."
    return
}

function New-LayerCakeShortcut {
    param(
        [string]$Path,
        [string]$TargetPath,
        [string]$WorkingDirectory
    )

    $shell = New-Object -ComObject WScript.Shell
    try {
        # CreateShortcut opens an existing .lnk rather than failing, so Save()
        # overwrites in place. That is what makes a re-run idempotent.
        $link = $shell.CreateShortcut($Path)
        $link.TargetPath       = $TargetPath
        $link.WorkingDirectory = $WorkingDirectory
        $link.Description      = 'LayerCake: Claude Code configuration lineage explorer'
        # 7 = minimized. The console is a byproduct of running node, not
        # something the user came here to look at, so it starts out of the way.
        # The app window itself opens in front of it.
        $link.WindowStyle      = 7
        $link.Save()
    }
    finally {
        # COM objects are not garbage collected promptly on 5.1. Released in a
        # finally so a failed Save still lets go of the handle.
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
    }

    Write-Host "Wrote shortcut: $Path"
}

$parentDir = Split-Path -Parent $startMenuLink
if (-not (Test-Path -LiteralPath $parentDir)) {
    New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
}

New-LayerCakeShortcut -Path $startMenuLink -TargetPath $target -WorkingDirectory $projectRoot

if ($Desktop) {
    New-LayerCakeShortcut -Path $desktopLink -TargetPath $target -WorkingDirectory $projectRoot
}

Write-Host ''
Write-Host "Target:            $target"
Write-Host "Working directory: $projectRoot"
Write-Host 'Search the Start Menu for "LayerCake" to launch it.'
