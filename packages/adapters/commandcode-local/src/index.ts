import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "commandcode_local";
export const label = "Command Code";

// npm global install is the canonical way to install the Command Code CLI.
// The package exposes several bin aliases (cmd, command-code, cmdc).
export const SANDBOX_INSTALL_COMMAND = "npm install -g command-code";

export const DEFAULT_COMMANDCODE_LOCAL_MODEL = "deepseek/deepseek-v4-flash";

// Representative model list. The full set depends on the authenticated account
// and configured providers; run `cmd --list-models` on the target machine to
// discover the complete list. `cmd --model` also accepts the short name after
// the last "/", but Paperclip stores the full provider/model id.
export const models: Array<{ id: string; label: string }> = [
  { id: DEFAULT_COMMANDCODE_LOCAL_MODEL, label: DEFAULT_COMMANDCODE_LOCAL_MODEL },
  { id: "deepseek/deepseek-v4-pro", label: "deepseek/deepseek-v4-pro" },
  { id: "anthropic/claude-sonnet-5", label: "anthropic/claude-sonnet-5" },
  { id: "anthropic/claude-sonnet-4-6", label: "anthropic/claude-sonnet-4-6" },
  { id: "anthropic/claude-opus-5", label: "anthropic/claude-opus-5" },
  { id: "openai/gpt-5.5", label: "openai/gpt-5.5" },
  { id: "openai/gpt-5.4-mini", label: "openai/gpt-5.4-mini" },
  { id: "google/gemini-3.7-flash", label: "google/gemini-3.7-flash" },
  { id: "qwen/qwen3.8-max", label: "qwen/qwen3.8-max" },
];

export const DEFAULT_COMMANDCODE_CHEAP_MODEL = "deepseek/deepseek-v4-flash";

// The "cheap" budget profile (used for recovery retries and other low-cost lanes).
// Defaults to Command Code's known flash model, but is overridable so a deployment
// routing through a gateway that does not serve that model can point the budget lane
// at a gateway-served model instead. PAPERCLIP_COMMANDCODE_CHEAP_MODEL takes priority;
// PAPERCLIP_COMMANDCODE_SMALL_MODEL is reused as a sensible fallback so a single
// setting covers both budget lanes.
//
// This module is shared client/server code (the UI imports it for
// DEFAULT_COMMANDCODE_LOCAL_MODEL etc.), so it must not touch the global `process`
// unguarded: in the browser (Vite dev middleware serves it untransformed)
// a bare `process.env` throws ReferenceError at module load and takes the whole
// app down. Guard with `typeof process` and fall back to an empty env.
export function buildCommandCodeModelProfiles(
  env: NodeJS.ProcessEnv = typeof process === "undefined" ? {} : process.env,
): AdapterModelProfileDefinition[] {
  const override =
    (env.PAPERCLIP_COMMANDCODE_CHEAP_MODEL ?? env.PAPERCLIP_COMMANDCODE_SMALL_MODEL)?.trim();
  return [
    {
      key: "cheap",
      label: "Cheap",
      description: "Budget lane model for recovery retries and other low-cost tasks.",
      adapterConfig: override
        ? { model: override }
        : { model: DEFAULT_COMMANDCODE_CHEAP_MODEL },
      source: "adapter_default",
    },
  ];
}

export const modelProfiles: AdapterModelProfileDefinition[] = buildCommandCodeModelProfiles();

export const agentConfigurationDoc = `# commandcode_local agent configuration

Adapter: commandcode_local

Use when:
- You want Paperclip to run Command Code (cmd) locally as the agent runtime
- You want headless runs with structured NDJSON output (--output-format json)
- You want Command Code session resume across heartbeats via --resume <sessionId>

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- The Command Code CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- model (string, required): Command Code model id in provider/model format (for example deepseek/deepseek-v4-flash). Run \`cmd --list-models\` to see available models.
- effort (string, optional): reasoning effort level passed as --effort (for example low|medium|high)
- dangerouslySkipPermissions (boolean, optional): pass --yolo to allow file writes and shell commands without prompts; defaults to true for unattended Paperclip runs
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "cmd"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Command Code supports multiple providers and models. Run \`cmd --list-models\` to list available options in provider/model format.
- Paperclip requires an explicit \`model\` value for \`commandcode_local\` agents.
- Runs are executed with: cmd -p --output-format json ...
- Sessions are resumed with --resume when the stored session cwd matches the current cwd.
- When \`dangerouslySkipPermissions\` is enabled, Paperclip passes --yolo so headless runs do not stall on permission prompts.
- Skills are injected into the Command Code personal skills directory (~/.commandcode/skills) without touching the agent's working directory.
- Command Code's native context compaction handles long sessions; session resume is supported across heartbeats.
`;

export const COMMANDCODE_UNKNOWN_SESSION_PATTERN = /no session .* found to resume/i;
