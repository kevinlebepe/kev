// What the desktop application can find out about the computer that a browser
// cannot (spec section 10). Every check here is a best effort: a determined
// candidate on their own computer can defeat any of them, so they lower the
// chance of an honest mistake or a casual attempt, not a guarantee.

export interface SystemReport {
  appVersion: string;
  os: { platform: 'windows' | 'macos' | 'linux' | 'other'; version: string };
  displayCount: number;
  freeStorageMb: number;
  virtualMachine: { detected: boolean; hints: string[] };
  restrictedApps: string[];
  screenCaptureReady: boolean;
}

/** The parts of the computer this code talks to, so tests can stand in for them. */
export interface SystemEnv {
  platform: NodeJS.Platform;
  osRelease: string;
  appVersion: string;
  /** Runs a program and returns its output, or an empty string if it fails. */
  run(command: string, args: string[]): Promise<string>;
  /** Reads a text file, or returns an empty string if it cannot be read. */
  readText(path: string): Promise<string>;
  freeDiskMb(): Promise<number>;
  displayCount(): number;
  screenCaptureReady(): boolean;
}

const VM_PATTERN =
  /vmware|virtualbox|vbox|innotek|qemu|kvm|hyper-?v|\bxen\b|parallels|bochs|bhyve|virtualmac|virtual machine|amazon ec2|google compute|microsoft corporation virtual/i;

/** True if any of the hardware descriptions look like a virtual machine. */
export function looksLikeVm(hints: readonly string[]): boolean {
  return hints.some((h) => VM_PATTERN.test(h));
}

export async function detectVirtualMachine(env: SystemEnv): Promise<{ detected: boolean; hints: string[] }> {
  const hints: string[] = [];
  let detected = false;

  if (env.platform === 'darwin') {
    if ((await env.run('sysctl', ['-n', 'kern.hv_vmm_present'])).trim() === '1') detected = true;
    hints.push((await env.run('sysctl', ['-n', 'hw.model'])).trim());
  } else if (env.platform === 'win32') {
    const out = await env.run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$c = Get-CimInstance Win32_ComputerSystem; "$($c.Manufacturer) $($c.Model)"',
    ]);
    hints.push(out.trim());
  } else {
    for (const file of ['/sys/class/dmi/id/product_name', '/sys/class/dmi/id/sys_vendor']) hints.push((await env.readText(file)).trim());
    // Guests carry a "hypervisor" flag; a host running virtual machines does not.
    if (/^flags\s*:.*\bhypervisor\b/m.test(await env.readText('/proc/cpuinfo'))) detected = true;
  }

  const useful = hints.filter(Boolean);
  return { detected: detected || looksLikeVm(useful), hints: useful };
}

/** Screen sharing, remote control and recording programs. */
const RESTRICTED: { label: string; pattern: RegExp }[] = [
  { label: 'TeamViewer', pattern: /teamviewer/i },
  { label: 'AnyDesk', pattern: /anydesk/i },
  { label: 'RustDesk', pattern: /rustdesk/i },
  { label: 'Chrome Remote Desktop', pattern: /remoting_host|chromeremotedesktop/i },
  { label: 'VNC', pattern: /vnc(server|viewer)|tightvnc|x11vnc|realvnc/i },
  { label: 'Parsec', pattern: /^parsec/i },
  { label: 'Splashtop', pattern: /splashtop/i },
  { label: 'LogMeIn', pattern: /logmein/i },
  { label: 'Zoom', pattern: /^zoom(\.us)?(\.exe)?$/i },
  { label: 'Discord', pattern: /^discord(\.exe)?$/i },
  { label: 'Skype', pattern: /^skype(\.exe)?$/i },
  { label: 'OBS Studio', pattern: /^obs(64|32)?(\.exe)?$|obs-studio/i },
  { label: 'Camtasia', pattern: /camtasia/i },
];

export function findRestrictedApps(processNames: readonly string[]): string[] {
  return RESTRICTED.filter((r) => processNames.some((p) => r.pattern.test(p))).map((r) => r.label);
}

/** Program names from `ps` (macOS, Linux) or `tasklist /FO CSV` (Windows) output. */
export function parseProcessList(platform: NodeJS.Platform, output: string): string[] {
  const names = output
    .split(/\r?\n/)
    .map((line) => (platform === 'win32' ? (line.match(/^"([^"]+)"/)?.[1] ?? '') : (line.trim().split('/').pop() ?? '')))
    .filter(Boolean);
  return [...new Set(names)];
}

export async function listProcesses(env: SystemEnv): Promise<string[]> {
  const output =
    env.platform === 'win32' ? await env.run('tasklist', ['/FO', 'CSV', '/NH']) : await env.run('ps', ['-A', '-o', 'comm=']);
  return parseProcessList(env.platform, output);
}

export async function collectSystemReport(env: SystemEnv): Promise<SystemReport> {
  const [virtualMachine, processes, freeStorageMb] = await Promise.all([
    detectVirtualMachine(env),
    listProcesses(env),
    env.freeDiskMb().catch(() => 0),
  ]);
  return {
    appVersion: env.appVersion,
    os: {
      platform: env.platform === 'win32' ? 'windows' : env.platform === 'darwin' ? 'macos' : env.platform === 'linux' ? 'linux' : 'other',
      version: env.osRelease,
    },
    displayCount: env.displayCount(),
    freeStorageMb,
    virtualMachine,
    restrictedApps: findRestrictedApps(processes),
    screenCaptureReady: env.screenCaptureReady(),
  };
}
