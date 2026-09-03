import { spawn } from "node:child_process";

/**
 * Windows-only named-pipe DACL enforcement.
 *
 * This module is dynamically imported only on win32 (see acl.ts). It applies a
 * "current user + SYSTEM only, no inherited/Everyone/Anonymous ACEs" DACL to a
 * LIVE named pipe server handle and verifies the result by reading the DACL
 * back, then returns the ACE list as raw evidence. It also supports a
 * read-only mode that captures the current DACL without modifying it.
 *
 * WHY POWERSHELL P/Invoke:
 *
 * 1. Node (`node:net` / `node:fs`) exposes NO API to set a DACL on a named
 *    pipe, and Node 24 removed the public `dlopen` that could call raw Win32
 *    exports. There is no dependency-free in-process path.
 * 2. The `icacls` command-line tool CANNOT address a named pipe on this
 *    machine: `icacls \\.\pipe\...` fails with error 87 ("invalid parameter")
 *    for both reading and granting, so the icacls strategy from the WP4 brief
 *    does not work here and must not be claimed to have worked.
 * 3. Windows ships PowerShell 5.1+ on every supported desktop SKU, and its
 *    `Add-Type` P/Invoke path was verified on this machine (Node 24, Windows
 *    10.0.26300): `SetSecurityInfo(SE_KERNEL_OBJECT, DACL|PROTECTED_DACL)`
 *    replaces the pipe DACL with exactly the ACEs we added and the read-back
 *    confirms Everyone (S-1-1-0) and ANONYMOUS LOGON (S-1-5-7) are gone.
 *
 * The script is delivered via `-EncodedCommand` (UTF-16LE base64) so no temp
 * script file is written and the same flow works when the package is bundled
 * inside `app.asar`. The pipe path and the desired mode are passed through
 * dedicated environment variables; there is no shell interpolation. If
 * `powershell.exe` is unavailable or the script fails, the caller surfaces a
 * truthful `WINDOWS_ACL_FAILED`.
 */

/** Env var that carries the pipe path to the helper process. */
const PIPE_PATH_ENV = "SWPANEL_PIPE_PATH" as const;
/** Env var that selects `set` (apply + read back) or `read` (evidence only). */
const PIPE_ACL_MODE_ENV = "SWPANEL_PIPE_ACL_MODE" as const;

/** SE_KERNEL_OBJECT: the object type passed to Get/SetSecurityInfo. */
const SE_KERNEL_OBJECT = 6;
/**
 * DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION. The
 * PROTECTED flag strips inherited ACEs so the resulting DACL is exactly the
 * ACE list we add.
 */
const DACL_SECURITY_INFORMATION = 0x80000004;
/**
 * Read-back bits for GetSecurityInfo:
 * DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION |
 * OWNER_SECURITY_INFORMATION. OWNER is included so the owner SID is captured
 * too, and the PROTECTED flag makes the read-back mirror the applied DACL even
 * when inheritance is present.
 */
const DACL_READ_SECURITY_INFORMATION = 0x80000005;
/** READ_CONTROL | WRITE_DAC: needed to install the DACL on the live pipe. */
const PIPE_HANDLE_ACCESS = 0x60000;
/** READ_CONTROL alone: the least privilege a read-only evidence capture needs. */
const PIPE_READ_ONLY_ACCESS = 0x00020000;
/** FILE_ALL_ACCESS: what the per-user and SYSTEM ACEs are granted. */
const FILE_ALL_ACCESS = 0x001f01ff;
/** SYSTEM well-known SID. */
const SYSTEM_SID = "S-1-5-18" as const;

/** One ACE entry captured from the pipe DACL (evidence). */
export interface PipeDaclAce {
  sid: string;
  mask: number;
}

export interface ApplyPipeDaclOptions {
  /** Current-user account name (used only for the evidence record). */
  ownerAccount: string;
}

export interface PipeDaclOutcome {
  /** Current-user account name (evidence record; derived from the environment). */
  ownerAccount: string;
  /** SID of the current user, taken from the process token via WindowsIdentity. */
  ownerSid: string;
  /** ACE list read back from the pipe DACL after applying (or read-only). */
  aces: readonly PipeDaclAce[];
}

/**
 * PowerShell script (kept as a template literal so the entire implementation
 * ships as a single module). In `set` mode it builds an ACL of exactly
 * `currentUser + SYSTEM` with {@link FILE_ALL_ACCESS}, replaces the pipe DACL
 * via `SetSecurityInfo(SE_KERNEL_OBJECT, DACL|PROTECTED_DACL)` and reads the
 * result back. In `read` mode it only reads the DACL back. Both modes emit
 * `PIPE_ACL_RESULT <json>` as one line on stdout; any error is a non-zero exit
 * with a message on stderr.
 */
const PIPE_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class SwpanelPipeAcl {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern SafeFileHandle CreateFile(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern int GetSecurityInfo(IntPtr handle, int ObjectType, uint SecurityInfo, out IntPtr pSidOwner, out IntPtr pSidGroup, out IntPtr pDacl, out IntPtr pSacl, out IntPtr pSecurityDescriptor);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern int SetSecurityInfo(IntPtr handle, int ObjectType, uint SecurityInfo, IntPtr psidOwner, IntPtr psidGroup, IntPtr pDacl, IntPtr pSacl);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool ConvertSidToStringSid(IntPtr pSid, out IntPtr pStringSid);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool ConvertStringSidToSid(string StringSid, out IntPtr pSid);
  [DllImport("advapi32.dll")]
  public static extern int GetLengthSid(IntPtr pSid);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr LocalAlloc(uint uFlags, uint uBytes);
  [DllImport("kernel32.dll")]
  public static extern IntPtr LocalFree(IntPtr hMem);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern int InitializeAcl(IntPtr pAcl, uint nAclLength, uint dwAclRevision);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern int AddAccessAllowedAce(IntPtr pAcl, uint dwAceRevision, uint AccessMask, IntPtr pSid);
  public static int BuildAcl(string sidA, string sidB, uint mask, out IntPtr pAcl) {
    pAcl = IntPtr.Zero;
    IntPtr sidA_ptr, sidB_ptr;
    if (!ConvertStringSidToSid(sidA, out sidA_ptr)) return 1300;
    if (!ConvertStringSidToSid(sidB, out sidB_ptr)) return 1310;
    uint aclLen = (uint)(8 + 8 + GetLengthSid(sidA_ptr) + 8 + GetLengthSid(sidB_ptr));
    IntPtr acl = LocalAlloc(0x40, aclLen);
    if (acl == IntPtr.Zero) return 1301;
    if (InitializeAcl(acl, aclLen, 2) == 0) { LocalFree(acl); return 1302; }
    if (AddAccessAllowedAce(acl, 2, mask, sidA_ptr) == 0) { LocalFree(acl); return 1303; }
    if (AddAccessAllowedAce(acl, 2, mask, sidB_ptr) == 0) { LocalFree(acl); return 1304; }
    pAcl = acl;
    return 0;
  }
}
'@

$pipe = $env:SWPANEL_PIPE_PATH
if ([string]::IsNullOrEmpty($pipe)) { Write-Error "SWPANEL_PIPE_PATH is not set"; exit 1 }
$mode = $env:SWPANEL_PIPE_ACL_MODE
if ([string]::IsNullOrEmpty($mode)) { $mode = 'set' }
$desiredAccess = ${PIPE_HANDLE_ACCESS}
if ($mode -eq 'read') { $desiredAccess = ${PIPE_READ_ONLY_ACCESS} }

$handle = [SwpanelPipeAcl]::CreateFile($pipe, $desiredAccess, 0, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
if ($handle.IsInvalid) {
  Write-Error ("CreateFileW failed with error " + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
  exit 2
}

$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value

if ($mode -eq 'set') {
  $acl = [IntPtr]::Zero
  $rc = [SwpanelPipeAcl]::BuildAcl($userSid, "${SYSTEM_SID}", ${FILE_ALL_ACCESS}, [ref]$acl)
  if ($rc -ne 0) { $handle.Dispose(); Write-Error ("BuildAcl failed with rc " + $rc); exit 3 }
  $setRc = [SwpanelPipeAcl]::SetSecurityInfo($handle.DangerousGetHandle(), ${SE_KERNEL_OBJECT}, [uint32]${DACL_SECURITY_INFORMATION}, [IntPtr]::Zero, [IntPtr]::Zero, $acl, [IntPtr]::Zero)
  [SwpanelPipeAcl]::LocalFree($acl) | Out-Null
  if ($setRc -ne 0) { $handle.Dispose(); Write-Error ("SetSecurityInfo failed with error " + $setRc); exit 4 }
}

# Read the DACL back for verification and evidence.
$owner = [IntPtr]::Zero; $group = [IntPtr]::Zero; $dacl = [IntPtr]::Zero; $sacl = [IntPtr]::Zero; $sd = [IntPtr]::Zero
$getRc = [SwpanelPipeAcl]::GetSecurityInfo($handle.DangerousGetHandle(), ${SE_KERNEL_OBJECT}, [uint32]${DACL_READ_SECURITY_INFORMATION}, [ref]$owner, [ref]$group, [ref]$dacl, [ref]$sacl, [ref]$sd)
if ($getRc -ne 0) { $handle.Dispose(); Write-Error ("GetSecurityInfo failed with error " + $getRc); exit 5 }
$aceCount = [System.Runtime.InteropServices.Marshal]::ReadInt16($dacl, 4)
$aces = New-Object System.Collections.ArrayList
$offset = 8
for ($i = 0; $i -lt $aceCount; $i++) {
  $aceSize = [System.Runtime.InteropServices.Marshal]::ReadInt16($dacl, $offset + 2)
  $mask = [System.Runtime.InteropServices.Marshal]::ReadInt32($dacl, $offset + 4)
  $sidPtr = [System.IntPtr]([long]$dacl + $offset + 8)
  $sidOut = [IntPtr]::Zero
  $sidString = ''
  if ([SwpanelPipeAcl]::ConvertSidToStringSid($sidPtr, [ref]$sidOut)) {
    $sidString = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($sidOut)
    [SwpanelPipeAcl]::LocalFree($sidOut) | Out-Null
  }
  $null = $aces.Add(@{ sid = $sidString; mask = $mask })
  $offset += $aceSize
}
[SwpanelPipeAcl]::LocalFree($sd) | Out-Null
$handle.Dispose()
$result = @{ ok = $true; aces = $aces; ownerSid = $userSid }
Write-Output ("PIPE_ACL_RESULT " + ($result | ConvertTo-Json -Compress))
`;

/** Parsed result line emitted by the PowerShell helper. */
interface PipeAclResult {
  ok: boolean;
  aces: { sid: string; mask: number }[];
  ownerSid: string;
}

function runPowerShellScript(pipePath: string, mode: "set" | "read"): Promise<PipeAclResult> {
  return new Promise((resolve, reject) => {
    // The script is delivered via -EncodedCommand (UTF-16LE base64) instead of
    // stdin: PowerShell's `-Command -` does not reliably compile Add-Type
    // blocks read from stdin. The command line stays far below the Windows
    // 32767-char limit and requires no temp file, so the same flow works when
    // the package is bundled inside app.asar.
    const encoded = Buffer.from(PIPE_ACL_SCRIPT, "utf16le").toString("base64");
    const child = spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      {
        env: { ...process.env, [PIPE_PATH_ENV]: pipePath, [PIPE_ACL_MODE_ENV]: mode },
        windowsHide: true
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      reject(new Error(`powershell.exe unavailable: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`pipe ACL helper failed (exit ${code}): ${stderr.trim()}`));
        return;
      }
      const marker = "PIPE_ACL_RESULT ";
      const markerIndex = stdout.indexOf(marker);
      if (markerIndex < 0) {
        reject(new Error(`pipe ACL helper produced no result marker: ${stdout.trim()}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.slice(markerIndex + marker.length).trim()) as PipeAclResult;
        if (parsed.ok !== true || !Array.isArray(parsed.aces) || typeof parsed.ownerSid !== "string") {
          reject(new Error("pipe ACL helper returned an unexpected result shape"));
          return;
        }
        resolve(parsed);
      } catch (error) {
        reject(new Error(`pipe ACL helper returned malformed JSON: ${String(error)}`));
      }
    });
  });
}

/**
 * Applies the per-user DACL to the live pipe and returns the resulting ACE
 * list. Throws on any failure (script error, SetSecurityInfo failure, missing
 * powershell) so the caller can report a truthful `WINDOWS_ACL_FAILED`.
 */
export async function applyPipeDacl(
  pipePath: string,
  options: ApplyPipeDaclOptions
): Promise<PipeDaclOutcome> {
  const result = await runPowerShellScript(pipePath, "set");
  return { ownerAccount: options.ownerAccount, ownerSid: result.ownerSid, aces: result.aces };
}

/**
 * Reads the current DACL of a live pipe WITHOUT modifying it. This is the
 * read-only raw-evidence capture; it opens the pipe with `READ_CONTROL` only.
 */
export async function readPipeDacl(
  pipePath: string,
  options: ApplyPipeDaclOptions
): Promise<PipeDaclOutcome> {
  const result = await runPowerShellScript(pipePath, "read");
  return { ownerAccount: options.ownerAccount, ownerSid: result.ownerSid, aces: result.aces };
}

/** The SYSTEM well-known SID used by the enforcement path. */
export const SYSTEM_SID_CONST = SYSTEM_SID;
