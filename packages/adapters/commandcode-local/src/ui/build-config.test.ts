import { describe, expect, it } from "vitest";
import { buildCommandCodeLocalConfig } from "./build-config.js";

describe("buildCommandCodeLocalConfig", () => {
  it("maps create-config values to adapterConfig", () => {
    const ac = buildCommandCodeLocalConfig({
      cwd: "/workspace",
      instructionsFilePath: "/workspace/AGENTS.md",
      model: "deepseek/deepseek-v4-flash",
      thinkingEffort: "high",
      dangerouslySkipPermissions: true,
      envBindings: { FOO: { type: "plain", value: "bar" } },
      envVars: "BAZ=qux\n# comment\n",
      command: "cmd",
      extraArgs: "--verbose, --no-session",
    } as never);
    expect(ac.cwd).toBe("/workspace");
    expect(ac.instructionsFilePath).toBe("/workspace/AGENTS.md");
    expect(ac.model).toBe("deepseek/deepseek-v4-flash");
    expect(ac.effort).toBe("high");
    expect(ac.dangerouslySkipPermissions).toBe(true);
    expect(ac.timeoutSec).toBe(0);
    expect(ac.graceSec).toBe(20);
    expect(ac.env).toEqual({
      FOO: { type: "plain", value: "bar" },
      BAZ: { type: "plain", value: "qux" },
    });
    expect(ac.command).toBe("cmd");
    expect(ac.extraArgs).toEqual(["--verbose", "--no-session"]);
  });

  it("omits empty optional fields", () => {
    const ac = buildCommandCodeLocalConfig({
      cwd: "",
      instructionsFilePath: "",
      model: "",
      thinkingEffort: "",
      dangerouslySkipPermissions: false,
      envBindings: {},
      envVars: "",
      command: "",
      extraArgs: "",
    } as never);
    expect(ac.cwd).toBeUndefined();
    expect(ac.instructionsFilePath).toBeUndefined();
    expect(ac.model).toBeUndefined();
    expect(ac.effort).toBeUndefined();
    expect(ac.env).toBeUndefined();
    expect(ac.command).toBeUndefined();
    expect(ac.extraArgs).toBeUndefined();
    expect(ac.dangerouslySkipPermissions).toBe(false);
    expect(ac.timeoutSec).toBe(0);
    expect(ac.graceSec).toBe(20);
  });
});
