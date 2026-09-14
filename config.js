/**
 * Config schema, defaults, and CLI discovery for the Antigravity route.
 * @module dsh-llm-antigravity/config
 */
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';

/** Default provider route name this plugin registers. */
export const DEFAULT_PROVIDER = 'antigravity-local';
/** Environment variable that overrides Antigravity CLI discovery. */
export const COMMAND_ENV = 'AGY_COMMAND';
/**
 * Known `agy` locations, tried in order after `$AGY_COMMAND` and `PATH`.
 * The installer script drops the binary in `~/.local/bin`; a Homebrew or
 * system-wide install may place it elsewhere, and `PATH` is consulted first
 * because a package-managed shim is usually the one the user means.
 */
export const COMMAND_CANDIDATES = [
  '/opt/homebrew/bin/agy',
  '/usr/local/bin/agy',
  join(process.env.HOME ?? '', '.local', 'bin', 'agy'),
  '/Applications/Antigravity.app/Contents/Resources/bin/agy',
];
/** Reasoning levels `agy --effort` accepts, in display order. */
export const REASONING_LEVELS = ['low', 'medium', 'high'];
/** How agy encodes one reasoning level inside a model id, e.g. `gemini-3.8-flash-high`. */
export const EFFORT_SUFFIX = /-(low|medium|high)$/u;

/**
 * Whether a path names an executable file.
 * @param path - candidate path.
 * @returns true when the path exists and is executable.
 */
function isExecutable(path) {
  if (path === '') return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the first executable `agy` on `PATH`.
 * @returns the absolute path, or undefined.
 */
function commandOnPath() {
  const entries = (process.env.PATH ?? '').split(':').filter((entry) => entry !== '');
  for (const entry of entries) {
    const candidate = join(entry, 'agy');
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve the Antigravity CLI to run, so the plugin works on a machine that
 * does not match the one it was written on. Order: the configured `command`,
 * then `$AGY_COMMAND`, then `PATH`, then the known install locations. A
 * configured value is returned as-is (even when missing), so an explicit
 * misconfiguration fails loudly at spawn instead of being silently replaced.
 * @param configured - the `command` config value.
 * @returns the command to run, or an empty string when none was found.
 */
export function resolveCommand(configured = '') {
  if (configured !== '') return configured;
  const fromEnv = process.env[COMMAND_ENV];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return commandOnPath() ?? COMMAND_CANDIDATES.find(isExecutable) ?? '';
}

/** Plugin config. */
export const Config = z.object({
  /** Route name shown to the model picker and selected by `GenerateOptions.provider`. */
  provider: z.string().default(DEFAULT_PROVIDER),
  /** `agy` executable to run; empty discovers it from `$AGY_COMMAND`, `PATH`, then known installs. */
  command: z.string().default(''),
  /** Extra argv appended before the prompt flag. */
  args: z.array(z.string()).default([]),
  /** Pin one model id; empty follows the catalog, then `models`, then the CLI's own default. */
  model: z.string().default(''),
  /**
   * Default reasoning effort. Models whose id already ends in `-low`/`-medium`/
   * `-high` pin their own level, and `--model <suffixed-id> --effort <level>`
   * is rejected by the CLI, so the flag is omitted for them.
   */
  effort: z.union([z.const(''), z.const('low'), z.const('medium'), z.const('high')]).default(''),
  /**
   * Antigravity agent name for the session. Empty selects the built-in
   * tool-less agent when `textOnly` is on, and the CLI's own default agent
   * otherwise.
   */
  agent: z.string().default(''),
  /**
   * Keep this route a text-generation route: select a custom agent that answers
   * from the conversation instead of reaching for Antigravity's own tools. With
   * tools enabled, a print-mode approval prompt cannot be answered, the call is
   * auto-denied, and the turn can end with no assistant text at all.
   */
  textOnly: z.boolean().default(true),
  /** Antigravity global configuration root; empty uses `$GEMINI_CONFIG_DIR` or `~/.gemini/config`. */
  geminiConfigDir: z.string().default(''),
  /** Create the built-in tool-less agent when it is missing, instead of skipping it. */
  provisionAgent: z.boolean().default(true),
  /**
   * Proxy URL for the spawned CLI, exported as `HTTP_PROXY`/`HTTPS_PROXY`.
   * `agy` is a Go binary and therefore ignores the macOS system proxy settings,
   * so a host that reaches Google only through Clash/Surge must set this.
   */
  proxy: z.string().default(''),
  /** Hosts that bypass `proxy`. */
  noProxy: z.string().default('localhost,127.0.0.1,::1'),
  /** Working root handed to the CLI; empty uses the harness process working directory. */
  cwd: z.string().default(''),
  /** Extra roots added with `--add-dir`, repeatable. */
  addDirs: z.array(z.string()).default([]),
  /** Run the CLI's own terminal sandbox (`--sandbox`). */
  sandbox: z.boolean().default(false),
  /**
   * Auto-approve every Antigravity tool request (`--dangerously-skip-permissions`).
   * Off by default: in print mode an approval prompt that nobody can answer is
   * denied, and the refusal is reported back as `denied_actions`.
   */
  skipPermissions: z.boolean().default(false),
  /** Keep slash-command and skill expansion out of print mode. */
  disableSlashCommands: z.boolean().default(true),
  /** Antigravity execution mode for the session; empty uses the CLI default. */
  mode: z.union([z.const(''), z.const('accept-edits'), z.const('plan')]).default(''),
  /** Wall-clock budget for one `agy` invocation, in milliseconds. */
  timeoutMs: z.natural().default(600000),
  /**
   * Value for `--print-timeout` (a Go duration such as `8m`). Empty derives a
   * budget slightly below {@link timeoutMs} so the CLI returns partial output
   * itself instead of being killed by the harness.
   */
  printTimeout: z.string().default(''),
  /** Model catalog cache written by discovery; empty uses the default cache path. */
  modelsCachePath: z.string().default(''),
  /** How long a discovered catalog stays fresh, in milliseconds. */
  modelsCacheTtlMs: z.natural().default(21600000),
  /** Run `agy models` to discover the catalog. */
  discover: z.boolean().default(true),
  /** Exact model ids advertised in addition to the discovered catalog. */
  models: z.array(z.string()).default([]),
  /** Per-model context-window overrides, keyed by exact model id. */
  contextWindows: z.dict(z.natural()).default({}),
  /** Capacity fallback for a model no hint or override covers. */
  defaultContextWindow: z.natural().default(200000),
});

/**
 * Resolve the `--effort` value for one call.
 *
 * A model id that already encodes a level (`...-high`) conflicts with the flag,
 * so the id wins and the flag is dropped; the caller reports the disagreement.
 * @param config - resolved plugin config.
 * @param requested - effort selected for this call, when the caller sent one.
 * @param model - exact model id for this call.
 * @returns the flag value, and the requested level the id overrode.
 */
export function resolveEffort(config, requested, model) {
  const effort = typeof requested === 'string' && requested !== '' ? requested : config.effort;
  if (effort === '') return { effort: '', overridden: '' };
  const suffix = EFFORT_SUFFIX.exec(model);
  if (suffix !== null) {
    return { effort: '', overridden: suffix[1] === effort ? '' : effort };
  }
  return REASONING_LEVELS.includes(effort) ? { effort, overridden: '' } : { effort: '', overridden: '' };
}

/**
 * The `--print-timeout` value for this config.
 * @param config - resolved plugin config.
 * @returns a Go duration string, or an empty string to leave the CLI default.
 */
export function resolvedPrintTimeout(config) {
  if (config.printTimeout !== '') return config.printTimeout;
  const seconds = Math.max(30, Math.floor((config.timeoutMs - 20000) / 1000));
  return `${seconds}s`;
}
