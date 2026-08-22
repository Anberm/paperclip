import { describe, expect, it } from "vitest";
import {
  parseCommandCodeJsonl,
  isCommandCodeUnknownSessionError,
} from "./parse.js";
import { parseCommandCodeModelsOutput } from "./models.js";

const SIMPLE_SUCCESS_STREAM = [
  '{"type":"event","event":{"type":"run_start","sessionId":"abc-123"}}',
  '{"type":"event","event":{"type":"turn_start","turnNumber":1}}',
  '{"type":"event","event":{"type":"text_delta","delta":"Hello"}}',
  '{"type":"event","event":{"type":"run_end","result":{"finalText":"Hello","stopReason":"end_turn","turnCount":1,"usage":{"inputTokens":100,"outputTokens":20,"cacheReadTokens":30,"cacheWriteTokens":0}}}}',
  '{"type":"result","subtype":"success","sessionId":"abc-123","stopReason":"end_turn","usage":{"inputTokens":100,"outputTokens":20,"cacheReadTokens":30,"cacheWriteTokens":0},"durationMs":1000,"finalText":"Hello"}',
].join("\n");

describe("parseCommandCodeJsonl", () => {
  it("extracts session id, usage, and summary from a successful stream", () => {
    const parsed = parseCommandCodeJsonl(SIMPLE_SUCCESS_STREAM);
    expect(parsed.sessionId).toBe("abc-123");
    expect(parsed.usage.inputTokens).toBe(100);
    expect(parsed.usage.outputTokens).toBe(20);
    expect(parsed.usage.cachedInputTokens).toBe(30);
    expect(parsed.subtype).toBe("success");
    expect(parsed.errorMessage).toBeNull();
    // text_delta "Hello" + result finalText "Hello" (deduped by joining)
    expect(parsed.summary).toContain("Hello");
  });

  it("extracts error message from an error result frame", () => {
    const stream = [
      '{"type":"result","subtype":"error","usage":{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0},"durationMs":14,"finalText":"","error":"Error: No session \\"00000000-0000-0000-0000-000000000000\\" found to resume."}',
    ].join("\n");
    const parsed = parseCommandCodeJsonl(stream);
    expect(parsed.subtype).toBe("error");
    expect(parsed.errorMessage).toContain("No session");
    expect(parsed.sessionId).toBeNull();
  });

  it("accumulates usage across turn_end frames", () => {
    const stream = [
      '{"type":"event","event":{"type":"turn_end","turnNumber":1,"usage":{"inputTokens":100,"outputTokens":10,"cacheReadTokens":5,"cacheWriteTokens":0}}}',
      '{"type":"event","event":{"type":"turn_end","turnNumber":2,"usage":{"inputTokens":200,"outputTokens":20,"cacheReadTokens":15,"cacheWriteTokens":0}}}',
      '{"type":"result","subtype":"success","sessionId":"s1","usage":{"inputTokens":300,"outputTokens":30,"cacheReadTokens":20,"cacheWriteTokens":0},"durationMs":1,"finalText":"ok"}',
    ].join("\n");
    const parsed = parseCommandCodeJsonl(stream);
    // The result frame carries the authoritative totals; turn_end frames are
    // incremental and the result line overrides them.
    expect(parsed.usage.inputTokens).toBe(300);
    expect(parsed.usage.outputTokens).toBe(30);
    expect(parsed.usage.cachedInputTokens).toBe(20);
  });

  it("treats unknown event types as forward-compatible", () => {
    const stream = [
      '{"type":"event","event":{"type":"some_future_event","foo":"bar"}}',
      '{"type":"result","subtype":"success","sessionId":"s1","usage":{"inputTokens":1,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0},"durationMs":1,"finalText":"ok"}',
    ].join("\n");
    const parsed = parseCommandCodeJsonl(stream);
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.summary).toContain("ok");
  });
});

describe("isCommandCodeUnknownSessionError", () => {
  it("matches the resume-not-found error", () => {
    const stdout = '{"type":"result","subtype":"error","error":"Error: No session \\"abc\\" found to resume."}';
    expect(isCommandCodeUnknownSessionError(stdout, "")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    const stdout = '{"type":"result","subtype":"error","error":"Error: Model not found."}';
    expect(isCommandCodeUnknownSessionError(stdout, "")).toBe(false);
  });
});

describe("parseCommandCodeModelsOutput", () => {
  it("parses provider/model rows from `cmd --list-models` output", () => {
    const output = [
      "Available models  ·  58 models",
      "",
      "Open Source",
      "",
      "deepseek/deepseek-v4-pro               hybrid-attention long-context reasoning",
      "deepseek/deepseek-v4-flash             fast hybrid-attention reasoning (default)",
      "",
      "Anthropic",
      "",
      "claude-sonnet-5                        best combo of speed & intelligence (recommended)",
      "claude-opus-5                          most intelligent Opus for agents and coding",
      "",
      "OpenAI",
      "",
      "gpt-5.5                                latest frontier model for general complex work",
    ].join("\n");
    const models = parseCommandCodeModelsOutput(output);
    expect(models).toEqual([
      { id: "deepseek/deepseek-v4-pro", label: "deepseek/deepseek-v4-pro" },
      { id: "deepseek/deepseek-v4-flash", label: "deepseek/deepseek-v4-flash" },
    ]);
  });

  it("skips short-name rows without a provider prefix", () => {
    const output = [
      "claude-sonnet-5                        best combo",
      "deepseek/deepseek-v4-flash             fast",
    ].join("\n");
    const models = parseCommandCodeModelsOutput(output);
    expect(models).toEqual([
      { id: "deepseek/deepseek-v4-flash", label: "deepseek/deepseek-v4-flash" },
    ]);
  });

  it("dedupes models preserving input order", () => {
    const output = [
      "deepseek/deepseek-v4-flash             fast",
      "deepseek/deepseek-v4-flash             fast",
      "anthropic/claude-sonnet-5              good",
    ].join("\n");
    const models = parseCommandCodeModelsOutput(output);
    expect(models.map((m) => m.id)).toEqual([
      "deepseek/deepseek-v4-flash",
      "anthropic/claude-sonnet-5",
    ]);
  });
});
