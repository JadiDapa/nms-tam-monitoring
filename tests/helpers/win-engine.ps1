# Windows helper for the shutdown tests.
# Node cannot receive SIGTERM on Windows (a "kill" is a hard TerminateProcess), so the supported graceful paths are
# Ctrl+C (SIGINT) and Ctrl+Break (SIGBREAK). Those are console events: this script starts the engine in its OWN hidden
# console, then attaches to that console and generates the event, exactly like pressing the keys in a terminal.
#
#   start    -Entry <file.ts> -Out <stdout file> -Err <stderr file> -WorkDir <dir>   -> prints the pid
#   shutdown -TargetPid <pid> -Event 0|1 -TimeoutSec <n>                             -> prints JSON {exited, exitCode, ms}
param(
  [Parameter(Mandatory = $true, Position = 0)] [string]$Command,
  [string]$Entry, [string]$Out, [string]$Err, [string]$WorkDir,
  [int]$TargetPid, [int]$Event = 0, [int]$TimeoutSec = 20
)

if ($Command -eq 'start') {
  # The "ignore Ctrl+C" flag is INHERITED by child processes. Shells that run background jobs (e.g. Git Bash) set it, which
  # would silently swallow our Ctrl+C later. Re-enable normal Ctrl+C handling so the engine behaves as in a real terminal.
  Add-Type -Namespace Win -Name Con -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
'@
  [void][Win.Con]::SetConsoleCtrlHandler([IntPtr]::Zero, $false)
  $p = Start-Process -FilePath 'node' -ArgumentList '--import', 'tsx', "`"$Entry`"" -WorkingDirectory $WorkDir `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput $Out -RedirectStandardError $Err
  $null = $p.Handle
  $p.Id
  exit 0
}

if ($Command -eq 'sendctrl') {
  # Runs in a throwaway process: Ctrl+Break is NOT blocked by SetConsoleCtrlHandler(NULL, true), so this process may die
  # from the very event it sends. That is fine, the caller does not depend on it.
  Add-Type -Namespace Win -Name Con2 -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint dwProcessId);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);
'@
  [void][Win.Con2]::FreeConsole()
  if (-not [Win.Con2]::AttachConsole([uint32]$TargetPid)) { exit 2 }
  [void][Win.Con2]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)
  [void][Win.Con2]::GenerateConsoleCtrlEvent([uint32]$Event, 0)
  Start-Sleep -Milliseconds 500
  [void][Win.Con2]::FreeConsole()
  exit 0
}

if ($Command -eq 'shutdown') {
  $proc = [System.Diagnostics.Process]::GetProcessById($TargetPid)
  $null = $proc.Handle                      # keep a handle so the exit code stays readable
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $sender = Start-Process -FilePath 'powershell' -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", 'sendctrl', '-TargetPid', $TargetPid, '-Event', $Event `
            -WindowStyle Hidden -PassThru
  $sender.WaitForExit(15000) | Out-Null
  $exited = $proc.WaitForExit($TimeoutSec * 1000)
  $code = if ($exited) { $proc.ExitCode } else { $null }
  if (-not $exited) { Stop-Process -Id $TargetPid -Force }
  (@{ exited = $exited; exitCode = $code; ms = $sw.ElapsedMilliseconds } | ConvertTo-Json -Compress)
  exit 0
}
