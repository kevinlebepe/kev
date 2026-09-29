import { describe, expect, it } from 'vitest';
import {
  collectSystemReport,
  detectVirtualMachine,
  findRestrictedApps,
  listProcesses,
  looksLikeVm,
  parseProcessList,
  type SystemEnv,
} from '../src/system';

function env(over: Partial<SystemEnv> & { commands?: Record<string, string>; files?: Record<string, string> } = {}): SystemEnv {
  const { commands = {}, files = {}, ...rest } = over;
  return {
    platform: 'linux',
    osRelease: '6.1.0',
    appVersion: '0.1.0',
    run: async (command, args) => commands[[command, ...args].join(' ')] ?? '',
    readText: async (path) => files[path] ?? '',
    freeDiskMb: async () => 51_200,
    displayCount: () => 1,
    screenCaptureReady: () => true,
    ...rest,
  };
}

describe('virtual machine detection', () => {
  it('recognises the common hypervisors and cloud machines', () => {
    for (const hint of ['VMware Virtual Platform', 'VirtualBox', 'innotek GmbH', 'QEMU Standard PC', 'KVM', 'Microsoft Corporation Virtual Machine', 'Parallels Virtual Platform', 'VirtualMac2,1', 'Amazon EC2', 'Xen HVM domU', 'Google Compute Engine']) {
      expect(looksLikeVm([hint]), hint).toBe(true);
    }
  });

  it('does not flag ordinary computers', () => {
    for (const hint of ['MacBookAir10,1', 'Latitude 7420', 'Dell Inc.', 'LENOVO 20XW', 'Apple Inc.', 'HP EliteBook 840 G8', 'ThinkPad X1 Carbon']) {
      expect(looksLikeVm([hint]), hint).toBe(false);
    }
    expect(looksLikeVm([])).toBe(false);
  });

  it('asks macOS whether it is a guest', async () => {
    const yes = await detectVirtualMachine(env({ platform: 'darwin', commands: { 'sysctl -n kern.hv_vmm_present': '1\n', 'sysctl -n hw.model': 'MacBookAir10,1\n' } }));
    expect(yes.detected).toBe(true);
    const no = await detectVirtualMachine(env({ platform: 'darwin', commands: { 'sysctl -n kern.hv_vmm_present': '0\n', 'sysctl -n hw.model': 'MacBookAir10,1\n' } }));
    expect(no).toEqual({ detected: false, hints: ['MacBookAir10,1'] });
  });

  it('reads the manufacturer and model on Windows', async () => {
    const script = '$c = Get-CimInstance Win32_ComputerSystem; "$($c.Manufacturer) $($c.Model)"';
    const key = `powershell -NoProfile -NonInteractive -Command ${script}`;
    expect((await detectVirtualMachine(env({ platform: 'win32', commands: { [key]: 'VMware, Inc. VMware7,1\r\n' } }))).detected).toBe(true);
    expect((await detectVirtualMachine(env({ platform: 'win32', commands: { [key]: 'LENOVO 20XW\r\n' } }))).detected).toBe(false);
  });

  it('reads the hardware description and hypervisor flag on Linux', async () => {
    const guest = await detectVirtualMachine(env({ files: { '/proc/cpuinfo': 'processor : 0\nflags : fpu vme hypervisor lm\n' } }));
    expect(guest.detected).toBe(true);
    const named = await detectVirtualMachine(env({ files: { '/sys/class/dmi/id/product_name': 'VirtualBox\n' } }));
    expect(named.detected).toBe(true);
    const host = await detectVirtualMachine(env({ files: { '/proc/cpuinfo': 'flags : fpu vme vmx lm\n', '/sys/class/dmi/id/product_name': 'XPS 13\n' } }));
    expect(host.detected).toBe(false);
  });

  it('does not report a virtual machine when nothing can be read', async () => {
    expect(await detectVirtualMachine(env())).toEqual({ detected: false, hints: [] });
  });
});

describe('restricted programs', () => {
  it('finds remote control, screen sharing and recording programs', () => {
    expect(findRestrictedApps(['launchd', 'TeamViewer', 'AnyDesk.exe', 'zoom.us', 'Discord', 'obs64.exe', 'chrome'])).toEqual([
      'TeamViewer',
      'AnyDesk',
      'Zoom',
      'Discord',
      'OBS Studio',
    ]);
  });

  it('does not mistake ordinary programs for them', () => {
    expect(findRestrictedApps(['Safari', 'Finder', 'Code', 'node', 'chrome.exe', 'zoomit64.exe', 'observer', 'discordant', 'Teams'])).toEqual([]);
  });

  it('reports each program once', () => {
    expect(findRestrictedApps(['TeamViewer', 'TeamViewer_Service', 'teamviewer'])).toEqual(['TeamViewer']);
  });

  it('reads program names from ps and tasklist output', () => {
    expect(parseProcessList('darwin', '/sbin/launchd\n/Applications/zoom.us.app/Contents/MacOS/zoom.us\n  node  \n\n')).toEqual(['launchd', 'zoom.us', 'node']);
    expect(parseProcessList('win32', '"System Idle Process","0","Services","0","8 K"\r\n"AnyDesk.exe","4321","Console","1","50,000 K"\r\n')).toEqual(['System Idle Process', 'AnyDesk.exe']);
    expect(parseProcessList('linux', '')).toEqual([]);
  });

  it('lists processes with the right command for the system', async () => {
    const mac = await listProcesses(env({ platform: 'darwin', commands: { 'ps -A -o comm=': '/usr/bin/AnyDesk\n' } }));
    expect(mac).toEqual(['AnyDesk']);
    const win = await listProcesses(env({ platform: 'win32', commands: { 'tasklist /FO CSV /NH': '"TeamViewer.exe","1","Console","1","1 K"\n' } }));
    expect(win).toEqual(['TeamViewer.exe']);
  });
});

describe('system report', () => {
  it('gathers everything the device check needs', async () => {
    const report = await collectSystemReport(
      env({
        platform: 'darwin',
        osRelease: '14.5.0',
        displayCount: () => 2,
        commands: { 'sysctl -n kern.hv_vmm_present': '0', 'sysctl -n hw.model': 'MacBookAir10,1', 'ps -A -o comm=': '/usr/bin/AnyDesk\n/sbin/launchd\n' },
      }),
    );
    expect(report).toEqual({
      appVersion: '0.1.0',
      os: { platform: 'macos', version: '14.5.0' },
      displayCount: 2,
      freeStorageMb: 51_200,
      virtualMachine: { detected: false, hints: ['MacBookAir10,1'] },
      restrictedApps: ['AnyDesk'],
      screenCaptureReady: true,
    });
  });

  it('still reports when a check fails, rather than failing the whole report', async () => {
    const report = await collectSystemReport(env({ freeDiskMb: async () => { throw new Error('no disk info'); } }));
    expect(report.freeStorageMb).toBe(0);
    expect(report.restrictedApps).toEqual([]);
  });

  it('names the operating systems the server knows', async () => {
    expect((await collectSystemReport(env({ platform: 'win32' }))).os.platform).toBe('windows');
    expect((await collectSystemReport(env({ platform: 'linux' }))).os.platform).toBe('linux');
    expect((await collectSystemReport(env({ platform: 'freebsd' }))).os.platform).toBe('other');
  });
});
