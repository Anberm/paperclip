import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  parseObject,
  ensurePathInEnv,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  ensureAdapterExecutionTargetDirectory,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  prepareAdapterExecutionTargetRuntime,
  overrideAdapterExecutionTargetRemoteCwd,
} from "@paperclipai/adapter-utils/execution-target";
import { parseCommandCodeJsonl } from "./parse.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

function normalizeEnv(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

const COMMANDCODE_AUTH_REQUIRED_RE =
  /(?:not\s+authenticated|auth(?:entication)?\s+required|please\s+login|login\s+to\s+continue|invalid\s+api\s*key|insufficient\s+credits)/i;

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "cmd");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const targetIsSandbox = target?.kind === "remote" && target.transport === "sandbox";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `commandcode-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "commandcode_environment_target",
      level: "info",
      message: `Probing inside environment: ${targetLabel}`,
    });
  }

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: false,
    });
    checks.push({
      code: "commandcode_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "commandcode_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  if (asBoolean(config.dangerouslySkipPermissions, true)) {
    checks.push({
      code: "commandcode_headless_permissions_enabled",
      level: "info",
      message: "Headless Command Code permissions are auto-approved (--yolo) for unattended runs.",
    });
  }
  let restoreWorkspace: (() => Promise<void>) | null = null;
  let preparedRuntimeWorkspaceLocalDir: string | null = null;
  try {
    let runtimeTarget: AdapterExecutionTarget | null = target ?? null;
    let runtimeCwd = cwd;
    if (targetIsRemote) {
      preparedRuntimeWorkspaceLocalDir = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-commandcode-envtest-${runId}-`));
      const preparedExecutionTargetRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target,
        adapterKey: "commandcode",
        workspaceLocalDir: preparedRuntimeWorkspaceLocalDir,
        workspaceRemoteDir: cwd,
        installCommand: SANDBOX_INSTALL_COMMAND,
        detectCommand: command,
        assets: [],
      });
      restoreWorkspace = async () => {
        await preparedExecutionTargetRuntime.restoreWorkspace().catch(() => {});
        if (preparedRuntimeWorkspaceLocalDir) {
          await fs.rm(preparedRuntimeWorkspaceLocalDir, { recursive: true, force: true }).catch(() => {});
        }
      };
      runtimeCwd = preparedExecutionTargetRuntime.workspaceRemoteDir ?? runtimeCwd;
      runtimeTarget = overrideAdapterExecutionTargetRemoteCwd(target ?? null, runtimeCwd) ?? null;
    }
    const runtimeEnv = normalizeEnv(ensurePathInEnv({ ...process.env, ...env }));

    const cwdInvalid = checks.some((check) => check.code === "commandcode_cwd_invalid");
    if (cwdInvalid) {
      checks.push({
        code: "commandcode_command_skipped",
        level: "warn",
        message: "Skipped command check because working directory validation failed.",
        detail: command,
      });
    } else {
      const installCheck = await maybeRunSandboxInstallCommand({
        runId,
        target,
        adapterKey: "commandcode",
        installCommand: SANDBOX_INSTALL_COMMAND,
        detectCommand: command,
        env,
      });
      if (installCheck) checks.push(installCheck);
      try {
        await ensureAdapterExecutionTargetCommandResolvable(command, runtimeTarget, runtimeCwd, runtimeEnv);
        checks.push({
          code: "commandcode_command_resolvable",
          level: "info",
          message: `Command is executable: ${command}`,
        });
      } catch (err) {
        checks.push({
          code: "commandcode_command_unresolvable",
          level: "error",
          message: err instanceof Error ? err.message : "Command is not executable",
          detail: command,
        });
      }
    }

    const canRunProbe =
      checks.every((check) => check.code !== "commandcode_cwd_invalid" && check.code !== "commandcode_command_unresolvable");

    const configuredModel = asString(config.model, "").trim();

    if (canRunProbe && configuredModel) {
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();
      const effort = asString(config.effort, "").trim();

      const args = ["-p", "--output-format", "json"];
      args.push("--model", configuredModel);
      if (effort) args.push("--effort", effort);
      args.push("--skip-onboarding");
      args.push("--yolo");
      if (extraArgs.length > 0) args.push(...extraArgs);

      const helloProbeTimeoutSec = Math.max(
        1,
        asNumber(config.helloProbeTimeoutSec, targetIsSandbox ? 90 : 60),
      );

      try {
        const probe = await runAdapterExecutionTargetProcess(
          runId,
          runtimeTarget,
          command,
          args,
          {
            cwd: runtimeCwd,
            env: runtimeEnv,
            timeoutSec: helloProbeTimeoutSec,
            graceSec: 5,
            stdin: "Respond with hello.",
            onLog: async () => {},
          },
        );

        const parsed = parseCommandCodeJsonl(probe.stdout);
        const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
        const authEvidence = `${parsed.errorMessage ?? ""}\n${probe.stdout}\n${probe.stderr}`.trim();

        if (probe.timedOut) {
          checks.push({
            code: "commandcode_hello_probe_timed_out",
            level: "warn",
            message: "Command Code hello probe timed out.",
            hint: "Retry the probe. If this persists, run Command Code manually in this working directory.",
          });
        } else if ((probe.exitCode ?? 1) === 0 && !parsed.errorMessage) {
          const summary = parsed.summary?.trim() ?? "";
          const hasHello = /\bhello\b/i.test(summary);
          checks.push({
            code: hasHello ? "commandcode_hello_probe_passed" : "commandcode_hello_probe_unexpected_output",
            level: hasHello ? "info" : "warn",
            message: hasHello
              ? "Command Code hello probe succeeded."
              : "Command Code probe ran but did not return `hello` as expected.",
            ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
            ...(hasHello
              ? {}
              : {
                  hint: "Run `cmd -p --output-format json` manually and prompt `Respond with hello` to inspect output.",
                }),
          });
        } else if (COMMANDCODE_AUTH_REQUIRED_RE.test(authEvidence)) {
          checks.push({
            code: "commandcode_hello_probe_auth_required",
            level: "warn",
            message: "Command Code is installed, but authentication is not ready.",
            ...(detail ? { detail } : {}),
            hint: "Run `cmd login` or set provider credentials, then retry the probe.",
          });
        } else {
          checks.push({
            code: "commandcode_hello_probe_failed",
            level: "error",
            message: "Command Code hello probe failed.",
            ...(detail ? { detail } : {}),
            hint: "Run `cmd -p --output-format json` manually in this working directory to debug.",
          });
        }
      } catch (err) {
        checks.push({
          code: "commandcode_hello_probe_failed",
          level: "error",
          message: "Command Code hello probe failed.",
          detail: err instanceof Error ? err.message : String(err),
          hint: "Run `cmd -p --output-format json` manually in this working directory to debug.",
        });
      }
    } else if (canRunProbe && !configuredModel) {
      checks.push({
        code: "commandcode_model_not_configured",
        level: "warn",
        message: "No model configured; skipped hello probe.",
        hint: "Set `adapterConfig.model` to a provider/model id (e.g. deepseek/deepseek-v4-flash).",
      });
    }
  } finally {
    await restoreWorkspace?.();
    if (!restoreWorkspace && preparedRuntimeWorkspaceLocalDir) {
      await fs.rm(preparedRuntimeWorkspaceLocalDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
