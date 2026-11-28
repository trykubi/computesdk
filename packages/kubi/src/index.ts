/**
 * Kubi Provider - Factory-based Implementation
 *
 * A Kubi sandbox is a disposable Kubi screen: a Linux desktop (Debian, 4 vCPU, 8 GB, 50 GB disk) in its own
 * VM, reached through Kubi's REST API (https://docs.trykubi.com). Commands, files and ports work like any
 * sandbox's; the desktop itself (screenshots, mouse, keyboard, live view) is Kubi's own API on the same key.
 */

import { defineProvider, escapeShellArg } from '@computesdk/provider';

import type {
  CommandResult,
  CreateInstanceOptions,
  FileEntry,
  InstanceInfo,
  ProcessHandle,
  ProcessStatus,
  RunCommandOptions,
  StartProcessOptions,
} from '@computesdk/provider';

export interface KubiConfig {
  /** Kubi API key - if not provided, will fallback to KUBI_API_KEY environment variable */
  apiKey?: string;
  /** API base URL - defaults to KUBI_API_URL or https://api.trykubi.com */
  baseUrl?: string;
  /** Sandbox lifetime in milliseconds: the screen is deleted this long after it is created. Default 5 minutes. */
  timeout?: number;
}

/** A Kubi screen as the API returns it. */
export interface KubiScreen {
  id: string;
  name: string;
  kind: 'persistent' | 'disposable';
  state: string;
  labels: Record<string, string>;
  ends_at: string | null;
  created_at: string;
  [key: string]: unknown;
}

/** The native instance: the screen as last read, and the connection to use for it. */
export interface KubiSandbox {
  screen: KubiScreen;
  apiKey: string;
  baseUrl: string;
  timeout: number;
}

interface KubiExec {
  id: string;
  status: string;
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_next?: number;
  stderr_next?: number;
  output_dropped?: boolean;
}

/** Kubi's error body, `{"error": {code, message, retryable, retry_after, ...}}`. */
export class KubiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(`Kubi ${status} ${code}: ${message}`);
    this.name = 'KubiError';
  }
}

const DEFAULT_TIMEOUT_MS = 300_000;
const MIN_LIFETIME_S = 60;
const MAX_LIFETIME_S = 2_592_000;
const WAIT_S = 25; // Kubi's longest long poll
const PAGE_BYTES = 1 << 20; // the most output of one stream one exec read returns

const apiKeyOf = (config: KubiConfig) =>
  config.apiKey || (typeof process !== 'undefined' && process.env?.KUBI_API_KEY) || '';
const baseUrlOf = (config: KubiConfig) =>
  (config.baseUrl || (typeof process !== 'undefined' && process.env?.KUBI_API_URL) || 'https://api.trykubi.com').replace(/\/+$/, '');

function connection(config: KubiConfig) {
  const apiKey = apiKeyOf(config);
  if (!apiKey) {
    throw new Error(
      'Missing Kubi API key.\n\n' +
        'Create one at https://console.trykubi.com (API keys), with read, exec and power (and network for getUrl).\n' +
        'Then pass it: kubi({ apiKey: "kubi_..." })\n' +
        'Or set KUBI_API_KEY in your environment.',
    );
  }
  return { apiKey, baseUrl: baseUrlOf(config) };
}

async function call<T>(
  conn: { apiKey: string; baseUrl: string },
  method: string,
  path: string,
  init: { body?: unknown; raw?: BodyInit; query?: Record<string, string | number | undefined>; key?: string } = {},
): Promise<T> {
  const url = new URL(`${conn.baseUrl}/v1${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { Authorization: `Bearer ${conn.apiKey}`, 'User-Agent': 'computesdk-kubi' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.raw !== undefined) headers['Content-Type'] = 'application/octet-stream';
  // Kubi keeps an Idempotency-Key, so a create or delete resent after a lost reply never runs twice.
  if (init.key) headers['Idempotency-Key'] = init.key;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers,
      body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
    });
    if (res.ok) {
      const type = res.headers.get('content-type') ?? '';
      return (type.includes('json') ? await res.json() : await res.text()) as T;
    }
    const err = ((await res.json().catch(() => ({}))) as { error?: Record<string, any> }).error ?? {};
    const retryAfter = Number(err.retry_after ?? res.headers.get('retry-after')) || 1;
    const error = new KubiError(res.status, err.code ?? 'HTTP_ERROR', err.message ?? res.statusText, retryAfter);
    // Sent again only when Kubi marks it retryable (never a 504), or NO_CAPACITY: nothing was made and no key was
    // stored, so the same Idempotency-Key is safe. Either way only GETs and keyed calls, so nothing runs twice.
    const again = err.retryable === true || err.code === 'NO_CAPACITY';
    if (again && res.status !== 504 && attempt < 5 && (init.key || method === 'GET')) {
      await new Promise((r) => setTimeout(r, Math.min(30, retryAfter) * 1000));
      continue;
    }
    throw error;
  }
}

const isNotFound = (e: unknown) => e instanceof KubiError && e.status === 404;

/** The lifetime Kubi takes, in seconds, from a ComputeSDK timeout in milliseconds. */
export function lifetimeSeconds(timeoutMs: number): number {
  return Math.min(MAX_LIFETIME_S, Math.max(MIN_LIFETIME_S, Math.ceil(timeoutMs / 1000)));
}

async function waitRunning(conn: { apiKey: string; baseUrl: string }, screenId: string, operationId?: string): Promise<KubiScreen> {
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    if (operationId) {
      const op = await call<{ status: string; error?: { code?: string; message?: string } | null }>(
        conn, 'GET', `/operations/${operationId}`, { query: { wait_s: WAIT_S } },
      );
      if (op.status === 'failed') throw new Error(`Kubi could not create the screen: ${op.error?.code ?? ''} ${op.error?.message ?? ''}`.trim());
    }
    const screen = await call<KubiScreen>(conn, 'GET', `/screens/${screenId}`);
    if (screen.state === 'running') return screen;
    if (['failed', 'deleting', 'deleted'].includes(screen.state)) throw new Error(`Kubi screen ${screenId} is ${screen.state}`);
    if (Date.now() > deadline) throw new Error(`Kubi screen ${screenId} did not start within 5 minutes`);
    if (!operationId) await new Promise((r) => setTimeout(r, 2000));
  }
}

/** Reads a stream's output from `from` to its end, a page at a time. */
async function readRest(
  sandbox: KubiSandbox, exec: KubiExec, stream: 'stdout' | 'stderr', from: number,
): Promise<string> {
  let text = '';
  let offset = from;
  const other = stream === 'stdout' ? 'stderr' : 'stdout';
  while (offset < exec[`${stream}_bytes`]) {
    const page = await call<KubiExec>(sandbox, 'GET', `/screens/${sandbox.screen.id}/exec/${exec.id}`, {
      query: { wait_s: 0, max_bytes: PAGE_BYTES, [`${stream}_from`]: offset, [`${other}_from`]: 2 ** 40 },
    });
    const next = page[`${stream}_next`] ?? offset;
    if (next <= offset) break;
    text += page[stream];
    offset = next;
  }
  return text;
}

async function runCommand(sandbox: KubiSandbox, command: string, options?: RunCommandOptions): Promise<CommandResult> {
  const started = Date.now();
  // The sandbox's create-time envs first, then the call's own, so the call wins.
  const callEnv = Object.entries(options?.env ?? {}).map(([k, v]) => `export ${k}=${quote(v)}; `).join('');
  let full = `[ -f ${ENV_FILE} ] && . ${ENV_FILE}; ${callEnv}${command}`;
  if (options?.background) full = `nohup sh -c ${quote(full)} > /dev/null 2>&1 &`;
  let exec = await call<KubiExec>(sandbox, 'POST', `/screens/${sandbox.screen.id}/exec`, {
    key: `computesdk-exec-${crypto.randomUUID()}`,
    body: {
      command: full,
      ...(options?.cwd && { cwd: options.cwd }),
      timeout_s: options?.timeout ? Math.min(86_400, Math.max(1, Math.ceil(options.timeout / 1000))) : 0,
      wait_s: WAIT_S,
      max_bytes: PAGE_BYTES,
    },
  });
  let stdout = exec.stdout;
  let stderr = exec.stderr;
  let outFrom = exec.stdout_next ?? stdout.length;
  let errFrom = exec.stderr_next ?? stderr.length;
  while (exec.status === 'running') {
    exec = await call<KubiExec>(sandbox, 'GET', `/screens/${sandbox.screen.id}/exec/${exec.id}`, {
      query: { wait_s: WAIT_S, until: 'exit', max_bytes: PAGE_BYTES, stdout_from: outFrom, stderr_from: errFrom },
    });
    stdout += exec.stdout;
    stderr += exec.stderr;
    outFrom = exec.stdout_next ?? outFrom;
    errFrom = exec.stderr_next ?? errFrom;
  }
  if (exec.status === 'lost') throw new Error('The Kubi screen restarted during the command; its exit status is unknown');
  stdout += await readRest(sandbox, exec, 'stdout', outFrom);
  stderr += await readRest(sandbox, exec, 'stderr', errFrom);
  if (options?.onStdout && stdout) options.onStdout(stdout);
  if (options?.onStderr && stderr) options.onStderr(stderr);
  const exitCode = exec.exit_code ?? (exec.status === 'timed_out' ? 124 : 137);
  return { stdout, stderr, exitCode, durationMs: Date.now() - started };
}

const ENV_FILE = '/home/user/.config/computesdk/env.sh';

/** A background command: Kubi exec, its output read by offset as it arrives, ended with exec kill. */
async function startProcess(sandbox: KubiSandbox, command: string, options: StartProcessOptions = {}): Promise<ProcessHandle> {
  if (options.stdin) throw new Error('Kubi processes take no stdin');
  const started = Date.now();
  const callEnv = Object.entries(options.env ?? {}).map(([k, v]) => `export ${k}=${quote(v)}; `).join('');
  const base = `/screens/${sandbox.screen.id}/exec`;
  const first = await call<KubiExec>(sandbox, 'POST', base, {
    key: `computesdk-exec-${crypto.randomUUID()}`,
    body: { command: `[ -f ${ENV_FILE} ] && . ${ENV_FILE}; ${callEnv}${command}`, ...(options.cwd && { cwd: options.cwd }), timeout_s: 0, wait_s: 0, max_bytes: PAGE_BYTES },
  });
  let last = first;
  let stdout = first.stdout;
  let stderr = first.stderr;
  let outFrom = first.stdout_next ?? stdout.length;
  let errFrom = first.stderr_next ?? stderr.length;
  if (stdout) options.onStdout?.(stdout);
  if (stderr) options.onStderr?.(stderr);
  const ended = (e: KubiExec) => e.status !== 'running';
  const poll = async (waitS: number) => {
    const e = await call<KubiExec>(sandbox, 'GET', `${base}/${first.id}`, {
      query: { wait_s: waitS, until: 'output', max_bytes: PAGE_BYTES, stdout_from: outFrom, stderr_from: errFrom },
    });
    if (e.stdout) { stdout += e.stdout; options.onStdout?.(e.stdout); }
    if (e.stderr) { stderr += e.stderr; options.onStderr?.(e.stderr); }
    outFrom = e.stdout_next ?? outFrom;
    errFrom = e.stderr_next ?? errFrom;
    last = e;
    return e;
  };
  const exitCode = (e: KubiExec) => e.exit_code ?? (e.status === 'running' ? null : e.status === 'timed_out' ? 124 : 137);
  let done: Promise<KubiExec> | undefined;
  const untilExit = () => (done ??= (async () => {
    let e = last;
    while (!ended(e) || outFrom < e.stdout_bytes || errFrom < e.stderr_bytes) e = await poll(ended(e) ? 0 : WAIT_S);
    options.onExit?.({ exitCode: exitCode(e), signal: e.signal ?? null });
    return e;
  })());
  // Output is pushed to onStdout/onStderr as it arrives, as with providers that stream.
  if (options.onStdout || options.onStderr || options.onExit) void untilExit().catch(() => {});
  return {
    pid: null,
    jobId: first.id,
    write: async () => { throw new Error('Kubi processes take no stdin'); },
    closeStdin: async () => { throw new Error('Kubi processes take no stdin'); },
    status: async (): Promise<ProcessStatus> => {
      if (!done) await poll(0);
      return { status: ended(last) ? 'exited' : 'running', exitCode: exitCode(last), signal: last.signal ?? null, stdout, stderr, truncated: !!last.output_dropped };
    },
    wait: async (opts?: { timeout?: number }) => {
      const e = await (opts?.timeout
        ? Promise.race([untilExit(), new Promise<never>((_, no) => setTimeout(() => no(new Error(`process ${first.id} still running after ${opts.timeout} ms`)), opts.timeout))])
        : untilExit());
      return { stdout, stderr, exitCode: exitCode(e) ?? 0, durationMs: Date.now() - started, signal: e.signal ?? null };
    },
    kill: async (signal?: string) => {
      try {
        await call(sandbox, 'POST', `${base}/${first.id}/kill`, { body: { signal: (signal ?? 'TERM').replace(/^SIG/, '') } });
      } catch (e) {
        if (!(e instanceof KubiError && (e.status === 404 || e.status === 409))) throw e;
      }
    },
  };
}
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const toSandbox = (screen: KubiScreen, conn: { apiKey: string; baseUrl: string }, timeout: number): KubiSandbox => ({
  screen, ...conn, timeout,
});

/** A Kubi template: a saved disk that new screens start from. */
export interface KubiTemplate {
  id: string;
  name: string;
  state: string;
  source_screen_id?: string | null;
  size_bytes?: number | null;
  created_at: string;
  [key: string]: unknown;
}

/** Waits for an operation (stop, start, template save) to finish. */
async function waitOperation(conn: { apiKey: string; baseUrl: string }, operationId: string, what: string): Promise<void> {
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const op = await call<{ status: string; error?: { code?: string; message?: string } | null }>(
      conn, 'GET', `/operations/${operationId}`, { query: { wait_s: WAIT_S } },
    );
    if (op.status === 'failed') throw new Error(`Kubi could not ${what}: ${op.error?.code ?? ''} ${op.error?.message ?? ''}`.trim());
    if (['succeeded', 'done', 'completed'].includes(op.status)) return;
    if (Date.now() > deadline) throw new Error(`Kubi did not ${what} within 15 minutes`);
  }
}

const toSnapshot = (t: KubiTemplate) => ({
  id: t.id,
  provider: 'kubi',
  createdAt: new Date(t.created_at),
  metadata: { name: t.name, state: t.state, sourceScreenId: t.source_screen_id ?? undefined, sizeBytes: t.size_bytes ?? undefined },
});

export const kubi = defineProvider<KubiSandbox, KubiConfig>({
  name: 'kubi',
  // One size: 4 vCPU, 8 GiB, a 50 GB disk.
  sizes: (_config, profile) =>
    profile.vcpus === 4 && profile.memoryMiB === 8192
      ? { status: 'supported', nativeOptions: {}, resolved: { vcpus: 4, memoryMiB: 8192, diskMiB: 47_683 } }
      : { status: 'unsupported', reason: 'Kubi has one size: 4 vCPU, 8 GiB, a 50 GB disk.' },
  methods: {
    instances: {
      create: async (config: KubiConfig, options?: CreateInstanceOptions) => {
        const conn = connection(config);
        const timeout = options?.timeout ?? config.timeout ?? DEFAULT_TIMEOUT_MS;
        const labels: Record<string, string> = {};
        for (const [k, v] of Object.entries(options?.metadata ?? {})) {
          if (/^[A-Za-z0-9_./-]{1,63}$/.test(k) && v !== undefined && v !== null) labels[k] = String(v).slice(0, 255);
        }
        const name = options?.name?.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '').slice(0, 63);
        const op = await call<{ id: string; screen_id: string }>(conn, 'POST', '/screens', {
          key: `computesdk-${crypto.randomUUID()}`,
          body: {
            kind: 'disposable',
            ends_in_s: lifetimeSeconds(timeout),
            ...(name && { name }),
            ...((options?.snapshotId ?? options?.templateId) && { template_id: options?.snapshotId ?? options?.templateId }),
            ...(Object.keys(labels).length && { labels }),
          },
        });
        let screen: KubiScreen;
        try {
          screen = await waitRunning(conn, op.screen_id, op.id);
        } catch (e) {
          // It would end at its end time anyway; deleting it now stops the charge.
          await call(conn, 'DELETE', `/screens/${op.screen_id}`, { key: `computesdk-destroy-${op.screen_id}` }).catch(() => {});
          throw e;
        }
        const sandbox = toSandbox(screen, conn, timeout);
        if (options?.envs && Object.keys(options.envs).length) {
          // Kubi has no per-screen environment for commands: the variables go into a file each command sources.
          const lines = Object.entries(options.envs).map(([k, v]) => `export ${k}=${quote(v)}\n`).join('');
          await call(conn, 'PUT', `/screens/${screen.id}/files`, { query: { path: ENV_FILE, mode: '0600' }, raw: lines });
        }
        return { instance: sandbox, instanceId: screen.id };
      },

      getById: async (config: KubiConfig, instanceId: string) => {
        const conn = connection(config);
        try {
          const screen = await call<KubiScreen>(conn, 'GET', `/screens/${instanceId}`);
          return { instance: toSandbox(screen, conn, config.timeout ?? DEFAULT_TIMEOUT_MS), instanceId };
        } catch (e) {
          if (isNotFound(e)) return null;
          throw e;
        }
      },

      list: async (config: KubiConfig) => {
        const conn = connection(config);
        const out: { instance: KubiSandbox; instanceId: string }[] = [];
        let after: string | undefined;
        do {
          const page = await call<{ data: KubiScreen[]; next: string | null }>(conn, 'GET', '/screens', {
            query: { kind: 'disposable', limit: 100, after },
          });
          for (const screen of page.data) out.push({ instance: toSandbox(screen, conn, config.timeout ?? DEFAULT_TIMEOUT_MS), instanceId: screen.id });
          after = page.next ?? undefined;
        } while (after);
        return out;
      },

      destroy: async (config: KubiConfig, instanceId: string) => {
        const conn = connection(config);
        try {
          await call(conn, 'DELETE', `/screens/${instanceId}`, { key: `computesdk-destroy-${instanceId}` });
        } catch (e) {
          if (!isNotFound(e)) throw e;
        }
      },

      runCommand: (sandbox: KubiSandbox, command: string, options?: RunCommandOptions) => runCommand(sandbox, command, options),

      startProcess: (sandbox: KubiSandbox, command: string, options: StartProcessOptions) => startProcess(sandbox, command, options),

      getInfo: async (sandbox: KubiSandbox): Promise<InstanceInfo> => {
        const screen = await call<KubiScreen>(sandbox, 'GET', `/screens/${sandbox.screen.id}`).catch((e) => {
          if (isNotFound(e)) return { ...sandbox.screen, state: 'deleted' };
          throw e;
        });
        const status = ['running', 'provisioning', 'starting', 'restarting', 'waiting'].includes(screen.state)
          ? 'running'
          : ['stopping', 'stopped'].includes(screen.state) ? 'stopped' : 'error';
        return {
          id: screen.id,
          provider: 'kubi',
          status,
          createdAt: new Date(screen.created_at),
          timeout: sandbox.timeout,
          metadata: { name: screen.name, kind: screen.kind, labels: screen.labels, endsAt: screen.ends_at },
        };
      },

      getUrl: async (sandbox: KubiSandbox, options: { port: number; protocol?: string }): Promise<string> => {
        // `link` access: the URL alone reaches the port (HTTP and WebSocket), like other providers' preview URLs.
        const port = await call<{ url: string }>(sandbox, 'PUT', `/screens/${sandbox.screen.id}/ports/${options.port}`, {
          body: { access: 'link' },
        });
        const url = port.url.replace(/\/+$/, '');
        // The port relay serves HTTPS and WSS only.
        return options.protocol === 'wss' || options.protocol === 'ws' ? url.replace(/^https:/, 'wss:') : url;
      },

      getInstance: (sandbox: KubiSandbox): KubiSandbox => sandbox,

      // Stop and start: the disk survives, running processes do not.
      pause: async (sandbox: KubiSandbox): Promise<void> => {
        const op = await call<{ id: string }>(sandbox, 'POST', `/screens/${sandbox.screen.id}/stop`, {
          key: `computesdk-stop-${crypto.randomUUID()}`,
        });
        await waitOperation(sandbox, op.id, 'stop the screen');
      },
      resume: async (sandbox: KubiSandbox): Promise<void> => {
        const op = await call<{ id: string }>(sandbox, 'POST', `/screens/${sandbox.screen.id}/start`, {
          key: `computesdk-start-${crypto.randomUUID()}`,
        });
        await waitOperation(sandbox, op.id, 'start the screen');
        sandbox.screen = await waitRunning(sandbox, sandbox.screen.id);
      },
      pauseCapabilities: { memory: false },

      filesystem: {
        readFile: async (sandbox: KubiSandbox, path: string): Promise<string> =>
          call<string>(sandbox, 'GET', `/screens/${sandbox.screen.id}/files`, { query: { path } }),

        writeFile: async (sandbox: KubiSandbox, path: string, content: string): Promise<void> => {
          await call(sandbox, 'PUT', `/screens/${sandbox.screen.id}/files`, { query: { path }, raw: content });
        },

        mkdir: async (sandbox: KubiSandbox, path: string): Promise<void> => {
          const r = await runCommand(sandbox, `mkdir -p "${escapeShellArg(path)}"`);
          if (r.exitCode !== 0) throw new Error(`mkdir ${path} failed: ${r.stderr}`);
        },

        readdir: async (sandbox: KubiSandbox, path: string): Promise<FileEntry[]> => {
          const out: FileEntry[] = [];
          let after: string | undefined;
          do {
            const page = await call<{ data: { name: string; type: string; size_bytes?: number; modified_at?: string }[]; next: string | null }>(
              sandbox, 'GET', `/screens/${sandbox.screen.id}/dir`, { query: { path, limit: 100, after } },
            );
            for (const e of page.data)
              out.push({
                name: e.name,
                type: e.type === 'dir' ? 'directory' : 'file',
                size: e.size_bytes,
                modified: e.modified_at ? new Date(e.modified_at) : undefined,
              });
            after = page.next ?? undefined;
          } while (after);
          return out;
        },

        exists: async (sandbox: KubiSandbox, path: string): Promise<boolean> =>
          (await runCommand(sandbox, `test -e "${escapeShellArg(path)}"`)).exitCode === 0,

        remove: async (sandbox: KubiSandbox, path: string): Promise<void> => {
          const r = await runCommand(sandbox, `rm -rf "${escapeShellArg(path)}"`);
          if (r.exitCode !== 0) throw new Error(`rm ${path} failed: ${r.stderr}`);
        },
      },
    },

    // A snapshot is a Kubi template: the screen's disk, saved; new screens start from it with snapshotId.
    snapshot: {
      capabilities: { scope: 'rootfs', memory: false, destroysSource: false },
      create: async (config: KubiConfig, sandboxId: string, options?: { name?: string }) => {
        const conn = connection(config);
        const name = (options?.name ?? `snapshot-${Date.now()}`).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '').slice(0, 63) || `snapshot-${Date.now()}`;
        const op = await call<{ id: string; template_id: string }>(conn, 'POST', '/templates', {
          key: `computesdk-snapshot-${crypto.randomUUID()}`,
          body: { screen_id: sandboxId, name },
        });
        await waitOperation(conn, op.id, 'save the snapshot');
        return toSnapshot(await call<KubiTemplate>(conn, 'GET', `/templates/${op.template_id}`));
      },
      list: async (config: KubiConfig) => (await listTemplates(config)).map(toSnapshot),
      delete: async (config: KubiConfig, snapshotId: string) => deleteTemplate(config, snapshotId),
    },

    template: {
      create: async () => {
        throw new Error('Kubi saves a template from a running screen: use snapshot.create(sandboxId), then create({ templateId })');
      },
      list: async (config: KubiConfig) => listTemplates(config),
      delete: async (config: KubiConfig, templateId: string) => deleteTemplate(config, templateId),
    },
  },
});

async function listTemplates(config: KubiConfig): Promise<KubiTemplate[]> {
  const conn = connection(config);
  const out: KubiTemplate[] = [];
  let after: string | undefined;
  do {
    const page = await call<{ data: KubiTemplate[]; next: string | null }>(conn, 'GET', '/templates', { query: { limit: 100, after } });
    out.push(...page.data);
    after = page.next ?? undefined;
  } while (after);
  return out;
}

async function deleteTemplate(config: KubiConfig, templateId: string): Promise<void> {
  try {
    await call(connection(config), 'DELETE', `/templates/${templateId}`, { key: `computesdk-template-delete-${templateId}` });
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
}
