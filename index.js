/**
 * The Antigravity route: stream a conversation through the locally installed
 * Antigravity CLI (`agy`).
 *
 * `agy` owns its own agent loop (tools, terminal sandbox, approvals), so this
 * is a text-generation route: the conversation is rendered as prompt text, the
 * model's answer comes back, and Antigravity's own tool use is not reported as
 * harness tool calls. Harness tools stay with the harness.
 *
 * Unlike `codex exec --json`, `agy --output-format stream-json` emits real
 * token deltas (`step_update.text_delta`), so an answer streams incrementally;
 * it exposes no reasoning deltas, reporting thinking only as a token count.
 * @module dsh-llm-antigravity
 */
import { spawn } from 'node:child_process';
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm';
import { Config, resolveCommand, resolveEffort, resolvedPrintTimeout } from './config.js';
import { ModelCatalog, contextWindowFor } from './catalog.js';
import { TEXT_AGENT_NAME, defaultConfigDir, ensureTextAgent } from './agent.js';

/** Plugin identity used in diagnostics. */
export const name = 'dsh-llm-antigravity';
/** Services this plugin needs before it activates. */
export const inject = ['llm'];
/** Config schema, re-exported so a composition can validate it. */
export { Config };

/**
 * Usage/flag failures that mean the empty `--print=` form was rejected, which a
 * retry with the prompt as an argument can still satisfy. Matched only when the
 * invocation produced nothing.
 */
const PROMPT_MODE_FAILURE = /empty prompt|flag needs an argument|flag provided but not defined|usage of agy|usage: agy|unknown flag/iu;

/** A failure the argv-prompt retry may resolve; never surfaces to the harness. */
class PromptModeError extends Error {}

/** The Antigravity route adapter. */
class AntigravityAdapter extends LlmAdapter {
  /**
   * @param config - this activation's resolved config.
   * @param command - the resolved `agy` executable.
   * @param agent - Antigravity agent to select, or an empty string for the CLI default.
   */
  constructor(config, command, agent) {
    super();
    this.config = config;
    this.command = command;
    this.agent = agent;
    this.catalog = new ModelCatalog(config, command);
    this.warnedEffort = false;
  }

  /** {@inheritDoc} */
  providerInfo(provider) {
    return { id: provider, name: 'Antigravity (local)' };
  }

  /** The exact model id a request with no explicit model resolves to. */
  defaultModel() {
    if (this.config.model !== '') return this.config.model;
    return this.catalog.known()[0]?.id ?? '';
  }

  /** {@inheritDoc} */
  async listModels(provider) {
    // A cold catalog means the picker is opening for the first time, so pay for
    // one discovery; a warm one refreshes in the background instead of making
    // the model list wait on the network.
    let entries = this.catalog.known();
    if (entries.length === 0) entries = await this.catalog.refresh();
    else void this.catalog.refreshIfStale();
    return entries.map((entry) => ({
      provider,
      id: entry.id,
      name: entry.name,
      description: 'via the local Antigravity CLI',
      inputModalities: ['text'],
    }));
  }

  /** {@inheritDoc} */
  async resolveModel(provider, model) {
    const entry = this.catalog.find(model);
    return {
      provider,
      id: model,
      name: entry?.name ?? model,
      context: { contextWindow: contextWindowFor(model, this.config) },
      inputModalities: ['text'],
    };
  }

  /** {@inheritDoc} */
  async *stream(options) {
    const requested = options.model === '' ? this.defaultModel() : options.model;
    if (requested === '') {
      throw new LlmError(
        `${name}: no model resolved; set \`model\`, list one in \`models\`, or let \`agy models\` discovery succeed`,
        'INVALID_REQUEST',
      );
    }
    const { effort, overridden } = resolveEffort(this.config, options.reasoningEffort, requested);
    if (overridden !== '' && !this.warnedEffort) {
      this.warnedEffort = true;
      process.stderr.write(
        `${name}: model ${JSON.stringify(requested)} pins its own reasoning level, so the requested effort ${JSON.stringify(overridden)} was not forwarded (--model with a -low/-medium/-high id conflicts with --effort)\n`,
      );
    }
    const attempt = { produced: false };
    try {
      yield* this.run(options, requested, effort, true, attempt);
    } catch (error) {
      if (attempt.produced || options.signal?.aborted === true || !(error instanceof PromptModeError)) throw error;
      process.stderr.write(
        `${name}: this agy rejected the empty --print flag form (${error.message.slice(0, 200)}); retrying with the prompt as an argument\n`,
      );
      yield* this.run(options, requested, effort, false, attempt);
    }
  }

  /**
   * Run one turn through `agy`.
   * @param options - the assembled harness request.
   * @param model - exact model id.
   * @param effort - reasoning effort to forward, or an empty string.
   * @param stdinPrompt - send the prompt as one NDJSON `user` message on stdin
   *   instead of as the `--print` argument; this keeps a long conversation off
   *   the command line and its `ARG_MAX` limit.
   * @param attempt - shared record of whether any chunk was emitted.
   * @yields harness stream chunks.
   */
  async *run(options, model, effort, stdinPrompt, attempt) {
    const cwd = this.config.cwd === '' ? process.cwd() : this.config.cwd;
    const prompt = buildPrompt(options);
    const child = spawn(this.command, this.args(model, effort, stdinPrompt, prompt), {
      cwd,
      env: this.childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // A failed spawn (missing or non-executable command) arrives as an `error`
    // event, never as a rejected promise; capture it so the failure becomes an
    // LlmError instead of crashing the process on an unhandled 'error' event.
    let spawnFailure;
    const spawned = new Promise((resolve) => {
      child.once('spawn', () => resolve(true));
      child.once('error', (error) => {
        spawnFailure = error;
        resolve(false);
      });
    });
    const abort = () => {
      child.stdin.destroy();
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
    };
    if (options.signal !== undefined) {
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    }
    const timedOut = { value: false };
    const timer = setTimeout(() => {
      timedOut.value = true;
      abort();
    }, this.config.timeoutMs);
    const stderrChunks = [];
    child.stderr.on('data', (chunk) => {
      if (stderrChunks.length < 32) stderrChunks.push(chunk);
    });
    child.stdin.on('error', () => {
      // A child that exits before reading stdin reports EPIPE here; its own
      // exit status is the diagnostic that matters.
    });
    child.stdin.end(
      stdinPrompt ? `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n` : undefined,
      'utf8',
    );

    let textIndex;
    let textSeen = false;
    let result;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, totalTokens: 0 };
    let usageSeen = false;

    /** Record one usage object, keeping the last complete report of the turn. */
    const absorbUsage = (raw) => {
      if (raw === undefined || raw === null || typeof raw !== 'object') return;
      const cached = numberOr(raw.cache_read_tokens, 0);
      const input = numberOr(raw.input_tokens, 0);
      const output = numberOr(raw.output_tokens, 0);
      const thinking = numberOr(raw.thinking_tokens, 0);
      // agy's input_tokens is the whole prompt including cache hits, while the
      // harness counts billed input and cache reads as disjoint fields.
      usage.inputTokens = Math.max(0, input - cached);
      usage.outputTokens = output;
      usage.cacheReadTokens = cached;
      usage.reasoningTokens = thinking;
      usage.totalTokens = numberOr(raw.total_tokens, input + output);
      usageSeen = usageSeen || input > 0 || output > 0 || cached > 0;
    };

    try {
      if (!(await spawned)) {
        const code = spawnFailure?.code === 'ENOENT' ? 'MISSING_CREDENTIAL' : 'TRANSPORT';
        throw new LlmError(
          `${name}: cannot run ${JSON.stringify(this.command)} (${spawnFailure?.code ?? 'spawn failed'}: ${spawnFailure?.message ?? 'unknown'})`,
          code,
          spawnFailure === undefined ? undefined : { cause: spawnFailure },
        );
      }
      for await (const line of readLines(child.stdout)) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          process.stderr.write(`${name}: ignoring non-JSON line from agy: ${trimmed.slice(0, 200)}\n`);
          continue;
        }
        if (event.event === 'step_update') {
          const step = event.step_update ?? {};
          if (typeof step.text_delta === 'string' && step.text_delta !== '') {
            if (textIndex === undefined) {
              textIndex = 0;
              attempt.produced = true;
              yield { type: 'block-start', index: textIndex, blockType: 'text' };
            }
            textSeen = true;
            yield { type: 'text-delta', index: textIndex, text: step.text_delta };
          }
          if (step.usage !== undefined) absorbUsage(step.usage);
        } else if (event.event === 'result') {
          result = event.result ?? {};
          absorbUsage(result.usage);
        }
      }
      const exit = await waitForExit(child);
      const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
      if (options.signal?.aborted === true) throw new LlmError(`${name}: request aborted`, 'ABORTED');
      const failureText = (typeof result?.error === 'string' && result.error !== '' ? result.error : stderrText).trim();
      const failed = result?.status === 'ERROR' || exit.code !== 0;
      if (failed) {
        const detail = failureText === '' ? 'no diagnostic' : failureText.slice(0, 500);
        if (stdinPrompt && !attempt.produced && PROMPT_MODE_FAILURE.test(detail)) {
          throw new PromptModeError(detail);
        }
        const label = result?.status === 'ERROR'
          ? `agy reported: ${detail}`
          : `agy exited ${exit.code ?? exit.signal}: ${detail}`;
        throw new LlmError(`${name}: ${label}`, classifyFailure(failureText, timedOut.value));
      }
      // A model that answers without streaming (or a run cut off by the CLI's
      // own print timeout) still carries the whole answer on the result event.
      if (!textSeen && typeof result?.response === 'string' && result.response.trim() !== '') {
        textIndex = 0;
        attempt.produced = true;
        textSeen = true;
        yield { type: 'block-start', index: textIndex, blockType: 'text' };
        yield { type: 'text-delta', index: textIndex, text: result.response };
      }
      const denied = Array.isArray(result?.denied_actions) ? result.denied_actions : [];
      if (denied.length > 0) {
        const warn = options.onWarning ?? ((message) => process.stderr.write(`${message}\n`));
        warn(
          `${name}: Antigravity refused ${denied.length} tool action(s) nobody could approve in print mode: ${JSON.stringify(denied).slice(0, 300)}${this.config.skipPermissions ? '' : ' — set `skipPermissions: true` only if the CLI may act with its own tools'}`,
        );
      }
      if (!textSeen && denied.length > 0) {
        // The documented agy failure mode: the agent spent its turn trying to
        // run a tool, the print-mode approval was auto-denied, and it never wrote
        // an answer. Saying "no assistant message" here would hide the fix.
        const actions = denied
          .map((entry) => (typeof entry?.display_name === 'string' ? entry.display_name : entry?.action))
          .filter((value) => typeof value === 'string' && value !== '')
          .join(', ');
        throw new LlmError(
          `${name}: Antigravity tried to use its own tools (${actions === '' ? 'unknown' : actions}), the print-mode approval was auto-denied, and it produced no answer text. Keep \`textOnly: true\` so the model answers without tools, or set \`skipPermissions: true\` to let it act outside the harness sandbox.`,
          'INVALID_REQUEST',
        );
      }
      if (!textSeen) {
        throw new LlmError(
          `${name}: agy produced no assistant message${failureText === '' ? '' : ` (${failureText.slice(0, 300)})`}`,
          EMPTY_RESPONSE_CODE,
        );
      }
      if (usageSeen) {
        yield {
          type: 'usage',
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            ...(usage.cacheReadTokens > 0 ? { cacheReadTokens: usage.cacheReadTokens } : {}),
            ...(usage.reasoningTokens > 0 ? { reasoningTokens: usage.reasoningTokens } : {}),
            ...(usage.totalTokens > 0 ? { totalTokens: usage.totalTokens } : {}),
          },
        };
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }

  /**
   * Environment for the spawned CLI: the harness environment plus an explicit
   * proxy when one is configured. `agy` is a Go binary, so it reads
   * `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` and ignores the macOS system proxy.
   * @returns the child environment.
   */
  childEnv() {
    if (this.config.proxy === '') return process.env;
    return {
      ...process.env,
      HTTP_PROXY: this.config.proxy,
      HTTPS_PROXY: this.config.proxy,
      http_proxy: this.config.proxy,
      https_proxy: this.config.proxy,
      NO_PROXY: this.config.noProxy,
      no_proxy: this.config.noProxy,
    };
  }

  /**
   * Build the `agy` argv for one turn.
   * @param model - exact model id.
   * @param effort - reasoning effort to forward, or an empty string.
   * @param stdinPrompt - whether the prompt is sent on stdin.
   * @param prompt - rendered prompt text, used only in argument mode.
   * @returns the argument vector.
   */
  args(model, effort, stdinPrompt, prompt) {
    const args = ['--output-format', 'stream-json'];
    if (stdinPrompt) args.push('--input-format', 'stream-json');
    args.push('--model', model);
    if (effort !== '') args.push('--effort', effort);
    if (this.agent !== '') args.push('--agent', this.agent);
    if (this.config.mode !== '') args.push('--mode', this.config.mode);
    const printTimeout = resolvedPrintTimeout(this.config);
    if (printTimeout !== '') args.push('--print-timeout', printTimeout);
    if (this.config.sandbox) args.push('--sandbox');
    if (this.config.skipPermissions) args.push('--dangerously-skip-permissions');
    if (this.config.disableSlashCommands) args.push('--disable-slash-commands');
    for (const dir of this.config.addDirs) args.push('--add-dir', dir);
    args.push(...this.config.args);
    // `--print` takes its prompt as a value, so an empty one is spelled `--print=`.
    args.push(stdinPrompt ? '--print=' : `--print=${prompt}`);
    return args;
  }
}

/**
 * Choose the Antigravity agent for this activation.
 *
 * An explicit `agent` always wins. Otherwise `textOnly` selects (and, when
 * allowed, creates) the built-in tool-less agent, so a task-shaped prompt is
 * answered in text instead of dying on an unanswerable approval prompt.
 * @param config - resolved plugin config.
 * @returns the agent name to pass to `--agent`, or an empty string for none.
 */
function resolveAgent(config) {
  if (config.agent !== '') return config.agent;
  if (!config.textOnly) return '';
  if (!config.provisionAgent) {
    process.stderr.write(
      `${name}: textOnly is on but provisionAgent is off; pass \`agent: ${TEXT_AGENT_NAME}\` yourself or turn off textOnly\n`,
    );
    return '';
  }
  const dir = config.geminiConfigDir === '' ? defaultConfigDir() : config.geminiConfigDir;
  try {
    const { path, created } = ensureTextAgent(dir, TEXT_AGENT_NAME);
    if (created) process.stderr.write(`${name}: created the tool-less Antigravity agent ${path}\n`);
    return TEXT_AGENT_NAME;
  } catch (error) {
    process.stderr.write(
      `${name}: cannot provision the tool-less agent under ${dir} (${error instanceof Error ? error.message : String(error)}); falling back to the CLI default agent, where a denied tool call can end a turn with no text\n`,
    );
    return '';
  }
}

/** Register the Antigravity route. */
export function apply(ctx, rawConfig) {
  const config = Config(rawConfig ?? {});
  const command = resolveCommand(config.command);
  if (command === '') {
    process.stderr.write(
      `${name}: no Antigravity CLI found; set \`command\` or $AGY_COMMAND, or install the Antigravity CLI. The route registers but every call fails until then.\n`,
    );
  }
  const agent = resolveAgent(config);
  const adapter = new AntigravityAdapter(config, command, agent);
  const registration = ctx.inject(['llm'], (pluginCtx) => pluginCtx.llm.registerAdapter([config.provider], adapter));
  process.stderr.write(
    `${name}: route ${config.provider} ready (transport=cli${command === '' ? '' : `, command=${command}`}, agent=${agent === '' ? 'default' : agent}, discover=${config.discover})\n`,
  );
  return () => registration();
}

/**
 * Classify an Antigravity failure into a harness error code.
 * @param detail - the CLI's own error text plus stderr.
 * @param isTimeout - whether the harness itself killed the run.
 * @returns the harness error code.
 */
function classifyFailure(detail, isTimeout) {
  if (isTimeout) return 'TIMEOUT';
  const text = detail.toLowerCase();
  if (/not signed in|not authenticated|unauthorized|authentication|please sign in|401|403|credential/.test(text)) return 'AUTH';
  if (/quota|credit|resource.?exhausted|rate limit|429/.test(text)) return QUOTA_EXCEEDED_CODE;
  if (/context|too long|maximum.{0,20}tokens/.test(text)) return CONTEXT_WINDOW_EXCEEDED_CODE;
  // A truncated connection (EOF, reset, DNS, proxy timeout) is a transport
  // failure, not a bad request; `agy` reports these as `i/o timeout` or `EOF`
  // when the proxy it depends on is unreachable.
  if (/timed out|timeout|deadline|unavailable|connection|network|eof|refused|reset|50[234]/.test(text)) return 'TRANSPORT';
  return 'INVALID_REQUEST';
}

/**
 * Read a finite number from an untrusted field.
 * @param value - candidate.
 * @param fallback - value used when the field is not a finite number.
 * @returns the number.
 */
function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Render the harness conversation as the single prompt `agy` receives.
 * @param options - the assembled harness request.
 * @returns prompt text.
 */
function buildPrompt(options) {
  const system = typeof options.system === 'string' ? options.system.trim() : '';
  const conversation = renderConversation(options.messages ?? []);
  if (system === '') return conversation;
  return [system, '', 'Continue the conversation below and answer the final message.', '', conversation].join('\n');
}

/**
 * Render every message but the last as labelled history and the last as the
 * instruction to answer.
 * @param messages - ordered conversation messages.
 * @returns rendered conversation text.
 */
function renderConversation(messages) {
  const rendered = messages.map(renderMessage).filter((entry) => entry !== undefined);
  if (rendered.length === 0) return '';
  if (rendered.length === 1) return rendered[0].text;
  const history = rendered.slice(0, -1).map((entry) => `### ${entry.role}\n${entry.text}`);
  const last = rendered[rendered.length - 1];
  return ['Conversation so far:', ...history, '', `### ${last.role} (answer this)`, last.text].join('\n');
}

/**
 * Render one message as a label and body. Tool calls and results travel as text
 * because the CLI path never executes harness tools.
 * @param message - harness message.
 * @returns the rendered entry, or undefined for an empty message.
 */
function renderMessage(message) {
  const parts = [];
  for (const block of message.content ?? []) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'image') parts.push(`[image attachment ${block.attachment?.id ?? 'unknown'} omitted: this route sends text only]`);
    else if (block.type === 'file') parts.push(`[file attachment ${block.attachment?.name ?? 'unknown'}]`);
    else if (block.type === 'tool-call') parts.push(`[tool call ${block.name} ${block.arguments}]`);
    else if (block.type === 'tool-result') {
      const text = (block.content ?? []).map((inner) => (inner.type === 'text' ? inner.text : '')).join('');
      parts.push(`[tool result${block.isError === true ? ' (error)' : ''}: ${text}]`);
    }
  }
  const body = parts.join('\n').trim();
  if (body === '') return undefined;
  return { role: message.role === 'assistant' ? 'Assistant' : message.role === 'system' ? 'System' : 'User', text: body };
}

/**
 * Yield one line at a time from a byte stream.
 * @param stream - readable byte stream.
 * @yields decoded lines without their terminator.
 */
async function* readLines(stream) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf('\n');
    while (boundary !== -1) {
      yield buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      boundary = buffer.indexOf('\n');
    }
  }
  if (buffer !== '') yield buffer;
}

/**
 * Wait for a child process to settle.
 * @param child - the spawned child.
 * @returns its exit code and signal.
 */
function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}
