/**
 * The tool-less "text route" agent.
 *
 * `agy` is a complete agent: on a task-shaped prompt it reaches for its own
 * tools, and in print mode nobody can answer the approval prompt, so the tool
 * call is auto-denied and the turn can end with no assistant text at all. A
 * custom agent that is told to answer from the conversation alone keeps this
 * route a text-generation route, which is what the harness expects from a model
 * provider.
 *
 * Antigravity discovers custom agents under the global customization root
 * (`~/.gemini/config/agents/<name>/agent.md`), so one file serves every
 * workspace. The file is created only when it is missing: an agent the user
 * wrote themselves is never overwritten.
 * @module dsh-llm-antigravity/agent
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Agent name this plugin provisions and selects by default. */
export const TEXT_AGENT_NAME = 'dsh-text';
/** Environment variable that relocates Antigravity's global configuration root. */
export const CONFIG_DIR_ENV = 'GEMINI_CONFIG_DIR';

/**
 * Default global customization root.
 * @returns `~/.gemini/config`, or `$GEMINI_CONFIG_DIR` when set.
 */
export function defaultConfigDir() {
  const fromEnv = process.env[CONFIG_DIR_ENV];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return join(homedir(), '.gemini', 'config');
}

/**
 * Markdown for the built-in text-only agent.
 * @param name - agent name written into the frontmatter.
 * @returns the agent file body.
 */
export function textAgentMarkdown(name = TEXT_AGENT_NAME) {
  return `---
name: ${name}
description: Text-only answering agent for API-style routes. Answers from the conversation alone and never uses tools.
excludeDefaultComponents: true
---

You are a text-generation model behind an API. You receive a conversation and
produce the next assistant message.

Answer directly from the conversation text you were given. Do not use any tools,
do not read or write files, do not run commands, and do not ask for permission to
do any of those things. If a request would need work on the machine, explain in
plain text what the user should do instead of attempting it.
`;
}

/**
 * Ensure the text-only agent exists.
 * @param dir - the Antigravity configuration root (`~/.gemini/config`).
 * @param name - agent name.
 * @returns the agent file path, and whether this call created it.
 * @throws when the directory cannot be created or the file cannot be written.
 */
export function ensureTextAgent(dir, name = TEXT_AGENT_NAME) {
  const path = join(dir, 'agents', name, 'agent.md');
  if (existsSync(path)) return { path, created: false };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, textAgentMarkdown(name), 'utf8');
  return { path, created: true };
}
