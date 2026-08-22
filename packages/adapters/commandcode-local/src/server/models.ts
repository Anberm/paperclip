import os from "node:os";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import {
  asString,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";

const MODELS_CACHE_TTL_MS = 60_000;
const MODELS_DISCOVERY_TIMEOUT_MS = 20_000;

function resolveCommandCodeCommand(input: unknown): string {
  const envOverride =
    typeof process.env.PAPERCLIP_COMMANDCODE_COMMAND === "string" &&
    process.env.PAPERCLIP_COMMANDCODE_COMMAND.trim().length > 0
      ? process.env.PAPERCLIP_COMMANDCODE_COMMAND.trim()
      : "cmd";
  return asString(input, envOverride);
}

const discoveryCache = new Map<string, { expiresAt: number; models: AdapterModel[] }>();

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

function sortModels(models: AdapterModel[]): AdapterModel[] {
  return [...models].sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
  );
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

/**
 * Parse `cmd --list-models` output.
 *
 * The table lists model rows whose first token is the model id. Rows show either
 * a full `provider/model` id (e.g. `deepseek/deepseek-v4-flash`) or a short name
 * without a provider prefix (e.g. `claude-sonnet-5` under the Anthropic section).
 * Short-name rows have no provider in the output, so we only keep rows with an
 * explicit `provider/model` form — those are the ids Paperclip stores and passes
 * back via `--model`.
 */
export function parseCommandCodeModelsOutput(stdout: string): AdapterModel[] {
  const parsed: AdapterModel[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const firstToken = line.split(/\s+/)[0]?.trim() ?? "";
    const slashIndex = firstToken.indexOf("/");
    if (slashIndex <= 0 || slashIndex === firstToken.length - 1) continue;
    const provider = firstToken.slice(0, slashIndex).trim();
    const model = firstToken.slice(slashIndex + 1).trim();
    if (!provider || !model) continue;
    parsed.push({ id: `${provider}/${model}`, label: `${provider}/${model}` });
  }
  return dedupeModels(parsed);
}

function normalizeEnv(input: unknown): Record<string, string> {
  const envInput = typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envInput)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

export async function discoverCommandCodeModels(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolveCommandCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  // Ensure HOME points to the actual running user's home directory (mirrors the
  // OpenCode adapter) so `cmd` finds auth credentials stored under the user home.
  let resolvedHome: string | undefined;
  try {
    resolvedHome = os.userInfo().homedir || undefined;
  } catch {
    // os.userInfo() throws when the current UID has no /etc/passwd entry.
  }
  const runtimeEnv = normalizeEnv(ensurePathInEnv({ ...process.env, ...env, ...(resolvedHome ? { HOME: resolvedHome } : {}) }));

  const result = await runChildProcess(
    `commandcode-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    ["--list-models"],
    {
      cwd,
      env: runtimeEnv,
      timeoutSec: MODELS_DISCOVERY_TIMEOUT_MS / 1000,
      graceSec: 3,
      onLog: async () => {},
    },
  );

  if (result.timedOut) {
    throw new Error(`\`${command} --list-models\` timed out after ${MODELS_DISCOVERY_TIMEOUT_MS / 1000}s.`);
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
    throw new Error(detail ? `\`${command} --list-models\` failed: ${detail}` : `\`${command} --list-models\` failed.`);
  }
  return sortModels(parseCommandCodeModelsOutput(result.stdout));
}

export async function discoverCommandCodeModelsCached(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolveCommandCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const key = `${command}\n${cwd}\n${Object.entries(env)
    .filter(([name]) => !/^PAPERCLIP_|^npm_|^NPM_|^PWD$|^OLDPWD$|^SHLVL$|^_$|^TERM_SESSION_ID$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}`;
  const now = Date.now();
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;

  const models = await discoverCommandCodeModels({ command, cwd, env });
  discoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models });
  return models;
}

export function requireCommandCodeModelId(input: unknown): string {
  const model = asString(input, "").trim();
  if (!model) {
    throw new Error("Command Code requires `adapterConfig.model` (provider/model id).");
  }
  return model;
}

export async function ensureCommandCodeModelConfiguredAndAvailable(input: {
  model?: unknown;
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
}): Promise<AdapterModel[]> {
  const model = requireCommandCodeModelId(input.model);

  // When the caller opts into PAPERCLIP_COMMANDCODE_ALLOW_ALL_MODELS, Command Code
  // accepts any model id at run time (e.g. gateway-routed models that never appear
  // in `cmd --list-models` output). Honour that by skipping the availability probe;
  // we still require a non-empty model id above.
  const env = normalizeEnv(input.env);
  const allowAll = (env.PAPERCLIP_COMMANDCODE_ALLOW_ALL_MODELS ?? process.env.PAPERCLIP_COMMANDCODE_ALLOW_ALL_MODELS)?.trim().toLowerCase();
  if (allowAll === "true" || allowAll === "1" || allowAll === "yes") {
    return [{ id: model, label: model }];
  }

  let models: AdapterModel[];
  try {
    models = await discoverCommandCodeModelsCached({
      command: input.command,
      cwd: input.cwd,
      env: input.env,
    });
  } catch (err) {
    // The availability probe is a best-effort pre-flight guard, not a gate. If
    // `cmd --list-models` itself cannot run, do NOT abort the run — the real
    // invocation is authoritative.
    console.warn(
      `[commandcode-local] Model availability probe could not run for "${model}" (${
        err instanceof Error ? err.message : String(err)
      }); proceeding with the configured model.`,
    );
    return [{ id: model, label: model }];
  }

  if (models.length === 0) {
    console.warn(
      `[commandcode-local] \`cmd --list-models\` returned no provider/model rows; proceeding with the configured model "${model}".`,
    );
    return [{ id: model, label: model }];
  }

  if (!models.some((entry) => entry.id === model)) {
    const sample = models.slice(0, 12).map((entry) => entry.id).join(", ");
    throw new Error(
      `Configured Command Code model is unavailable: ${model}. Available models: ${sample}${models.length > 12 ? ", ..." : ""}`,
    );
  }

  return models;
}

export async function listCommandCodeModels(): Promise<AdapterModel[]> {
  try {
    return await discoverCommandCodeModelsCached();
  } catch {
    return [];
  }
}

export function resetCommandCodeModelsCacheForTests() {
  discoveryCache.clear();
}
