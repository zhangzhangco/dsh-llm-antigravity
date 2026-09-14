/**
 * Antigravity model catalog.
 *
 * `agy` has no on-disk model cache to read: `agy models` asks the backend and
 * prints `<id>\t<display name>` on stdout (the spinner goes to stderr), which
 * costs a network round trip of roughly ten seconds. This module runs that
 * command once per TTL, caches the parsed list under the user cache directory,
 * and keeps the previous list when a refresh fails, so the picker is never
 * blocked by an unreachable backend.
 * @module dsh-llm-antigravity/catalog
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** How long one `agy models` discovery may take. */
const DISCOVERY_TIMEOUT_MS = 60000;

/**
 * Default catalog cache file.
 * @returns `$XDG_CACHE_HOME`-aware path for the discovered model list.
 */
export function defaultModelsCachePath() {
  const base = process.env.XDG_CACHE_HOME !== undefined && process.env.XDG_CACHE_HOME !== ''
    ? process.env.XDG_CACHE_HOME
    : join(homedir(), '.cache');
  return join(base, 'dsh-llm-antigravity', 'models.json');
}

/**
 * Parse the stdout of `agy models`.
 *
 * Lines are `<model-id>\t<display name>`. Anything without a tab is either the
 * sign-in notice or a diagnostic; those are reported through `note` instead of
 * becoming bogus model ids.
 * @param text - raw stdout.
 * @returns parsed entries in CLI order, plus the first unrecognized line.
 */
export function parseModelList(text) {
  const models = [];
  const seen = new Set();
  let note = '';
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/\r$/u, '').trim();
    if (trimmed === '') continue;
    const tab = trimmed.indexOf('\t');
    if (tab === -1) {
      if (note === '') note = trimmed;
      continue;
    }
    const id = trimmed.slice(0, tab).trim();
    const name = trimmed.slice(tab + 1).trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: name === '' ? id : name });
  }
  return { models, note };
}

/**
 * Run `agy models` and parse its catalog.
 *
 * A missing binary, a non-zero exit, a timeout, and an unauthenticated backend
 * all resolve to an empty list with a diagnostic: discovery is advisory, and
 * the caller keeps whatever it already advertised.
 * @param command - the resolved `agy` executable.
 * @param timeoutMs - discovery budget.
 * @returns discovered models plus an error string when discovery failed.
 */
export function discoverModels(command, timeoutMs = DISCOVERY_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, ['models'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ models: [], error: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ models: [], error: `agy models timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 1_000_000) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      // The spinner and progress notices land here; keep only a bounded tail
      // for diagnostics so a chatty refresh cannot grow without limit.
      stderr = (stderr + chunk.toString('utf8')).slice(-2000);
    });
    child.once('error', (error) => finish({ models: [], error: error.message }));
    child.once('close', (code) => {
      const { models, note } = parseModelList(stdout);
      if (models.length === 0) {
        const detail = (note !== '' ? note : stderr.replace(/[\u2800-\u28ff]/gu, '').trim()).slice(0, 300);
        finish({ models: [], error: `agy models exited ${code} with no models${detail === '' ? '' : `: ${detail}`}` });
        return;
      }
      finish({ models, error: undefined });
    });
  });
}

/** Context capacity each model family is assumed to have when nothing overrides it. */
const CONTEXT_HINTS = [
  [/^gemini/u, 1000000],
  [/^claude/u, 200000],
  [/^gpt-oss/u, 131072],
];

/**
 * Context window for one exact model.
 *
 * `agy models` reports no capacity, so an explicit `contextWindows` entry wins,
 * then a family hint, then the configured default. The value drives the
 * harness token meter, not routing: an inexact window costs estimation
 * accuracy, never a rejected request.
 * @param model - exact model id.
 * @param config - resolved plugin config.
 * @returns assumed capacity in tokens.
 */
export function contextWindowFor(model, config) {
  const override = config.contextWindows[model];
  if (Number.isFinite(override) && override > 0) return override;
  for (const [pattern, window] of CONTEXT_HINTS) {
    if (pattern.test(model)) return window;
  }
  return config.defaultContextWindow;
}

/**
 * The discovered model catalog, backed by a disk cache with a TTL.
 */
export class ModelCatalog {
  /**
   * @param config - resolved plugin config.
   * @param command - the resolved `agy` executable, which may differ from `config.command`.
   */
  constructor(config, command) {
    this.config = config;
    this.command = command;
    this.path = config.modelsCachePath === '' ? defaultModelsCachePath() : config.modelsCachePath;
    this.discovered = [];
    this.discoveredAt = 0;
    this.loaded = false;
    this.pending = undefined;
  }

  /** Read the disk cache once, seeding entries from config. */
  load() {
    if (this.loaded) return;
    this.loaded = true;
    const cached = readCache(this.path);
    this.discovered = cached.models;
    this.discoveredAt = cached.fetchedAt;
  }

  /**
   * Every id to advertise: explicit config ids first, then the cache.
   * @returns ordered entries.
   */
  known() {
    this.load();
    const seen = new Set();
    const entries = [];
    const push = (id, name) => {
      if (id === '' || seen.has(id)) return;
      seen.add(id);
      entries.push({ id, name: name === undefined || name === '' ? id : name });
    };
    for (const id of this.config.models) push(id, undefined);
    if (this.config.model !== '') push(this.config.model, undefined);
    for (const entry of this.discovered) push(entry.id, entry.name);
    return entries;
  }

  /**
   * Display metadata for one id, when the catalog knows it.
   * @param model - exact model id.
   * @returns the entry, or undefined.
   */
  find(model) {
    this.load();
    return this.discovered.find((entry) => entry.id === model);
  }

  /**
   * Refresh when the cached list has aged past the TTL.
   * @returns the refresh promise, or undefined when the cache is still fresh.
   */
  refreshIfStale() {
    this.load();
    if (!this.config.discover) return undefined;
    if (Date.now() - this.discoveredAt < this.config.modelsCacheTtlMs) return undefined;
    return this.refresh();
  }

  /**
   * Discover the catalog and write it to the cache.
   *
   * Concurrent callers share one invocation. A failed refresh keeps the
   * previous list, so a backend blip cannot empty the picker.
   * @returns the current entries after the attempt.
   */
  async refresh() {
    this.load();
    if (!this.config.discover) return this.known();
    this.pending ??= (async () => {
      try {
        const { models, error } = await discoverModels(this.command);
        if (models.length > 0) {
          this.discovered = models;
          this.discoveredAt = Date.now();
          writeCache(this.path, models, this.discoveredAt);
        } else if (error !== undefined) {
          process.stderr.write(`dsh-llm-antigravity: ${error}\n`);
        }
      } finally {
        this.pending = undefined;
      }
    })();
    await this.pending;
    return this.known();
  }
}

/**
 * Read the catalog cache.
 * @param path - cache file path.
 * @returns the cached models and their fetch time; empty when missing or malformed.
 */
export function readCache(path) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const models = Array.isArray(raw?.models)
      ? raw.models
        .filter((entry) => typeof entry?.id === 'string' && entry.id !== '')
        .map((entry) => ({ id: entry.id, name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.id }))
      : [];
    const fetchedAt = Number.isFinite(raw?.fetchedAt) ? raw.fetchedAt : 0;
    return { models, fetchedAt };
  } catch {
    return { models: [], fetchedAt: 0 };
  }
}

/**
 * Write the catalog cache, ignoring an unwritable cache directory.
 * @param path - cache file path.
 * @param models - discovered entries.
 * @param fetchedAt - fetch timestamp.
 */
export function writeCache(path, models, fetchedAt) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ version: 1, fetchedAt, models }, undefined, 2)}\n`, 'utf8');
  } catch (error) {
    process.stderr.write(`dsh-llm-antigravity: cannot write model cache ${path}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
