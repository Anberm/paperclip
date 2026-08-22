import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { COMMANDCODE_UNKNOWN_SESSION_PATTERN } from "../index.js";

interface ParsedUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface ParsedCommandCodeResult {
  sessionId: string | null;
  summary: string | null;
  usage: ParsedUsage;
  costUsd: number | null;
  errorMessage: string | null;
  subtype: string | null;
  toolErrors: string[];
}

function readUsage(value: unknown): ParsedUsage {
  const rec = parseObject(value);
  return {
    inputTokens: asNumber(rec.inputTokens, 0),
    cachedInputTokens: asNumber(rec.cacheReadTokens, 0),
    outputTokens: asNumber(rec.outputTokens, 0),
  };
}

function readResultText(rec: Record<string, unknown>): string {
  // The result line carries finalText; event frames carry partial content.
  const finalText = asString(rec.finalText, "").trim();
  if (finalText) return finalText;
  const content = rec.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const entry of content) {
      const part = parseObject(entry);
      if (asString(part.type, "") === "text") {
        const text = asString(part.text, "").trim();
        if (text) parts.push(text);
      }
    }
    return parts.join("\n").trim();
  }
  return "";
}

function readError(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  const rec = parseObject(value);
  if (!rec) return "";
  const message = asString(rec.message, "").trim();
  if (message) return message;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

/**
 * Parse Command Code's NDJSON headless stream (`cmd -p --output-format json`).
 *
 * The stream has two frame shapes:
 * - `{"type":"event","event":{AgentEvent}}` — one per event as the run progresses
 * - `{"type":"result", ...}` — always the final line, carrying sessionId, usage,
 *   finalText, stopReason, and (on error) the error message.
 *
 * Agent events observed in practice: run_start, turn_start, message_start,
 * model_request_start, model_trace, text_delta, message_update, message_end,
 * model_request_end, thinking_start/thinking_delta/thinking_end,
 * tool_queued/tool_running/tool_completed, turn_end, run_end.
 *
 * Treat unknown event types as forward-compatible and ignore them.
 */
export function parseCommandCodeJsonl(stdout: string): ParsedCommandCodeResult {
  let sessionId: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const toolErrors: string[] = [];
  let usage: ParsedUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  let costUsd: number | null = null;
  let subtype: string | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const frame = parseJson(line);
    if (!frame) continue;

    const type = asString(frame.type, "");

    if (type === "result") {
      subtype = asString(frame.subtype, "").trim() || null;
      const frameSessionId = asString(frame.sessionId, "").trim();
      if (frameSessionId) sessionId = frameSessionId;
      usage = readUsage(frame.usage);
      const finalText = readResultText(frame);
      if (finalText) messages.push(finalText);
      const error = readError(frame.error);
      if (error) errors.push(error);
      continue;
    }

    if (type !== "event") continue;

    const event = parseObject(frame.event);
    if (!event) continue;

    const eventType = asString(event.type, "");

    if (eventType === "run_start") {
      const runSessionId = asString(event.sessionId, "").trim();
      if (runSessionId) sessionId = runSessionId;
      continue;
    }

    if (eventType === "run_end") {
      const result = parseObject(event.result);
      usage = readUsage(result.usage);
      const finalText = readResultText(result);
      if (finalText) messages.push(finalText);
      continue;
    }

    if (eventType === "turn_end") {
      usage = readUsage(event.usage);
      continue;
    }

    if (eventType === "text_delta") {
      const delta = asString(event.delta, "");
      if (delta) messages.push(delta);
      continue;
    }

    if (eventType === "message_update" || eventType === "message_end") {
      const content = event.content;
      if (!Array.isArray(content)) continue;
      for (const entry of content) {
        const part = parseObject(entry);
        if (asString(part.type, "") !== "text") continue;
        const text = asString(part.text, "").trim();
        if (text) messages.push(text);
      }
      continue;
    }

    if (eventType === "tool_completed") {
      const result = event.result;
      if (!Array.isArray(result)) continue;
      for (const entry of result) {
        const part = parseObject(entry);
        if (asString(part.type, "") !== "text") continue;
        const text = asString(part.text, "").trim();
        if (text) toolErrors.push(text);
      }
      continue;
    }

    if (eventType === "error") {
      const text = readError(event.error ?? event.message);
      if (text) errors.push(text);
      continue;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n").trim() || null,
    usage,
    costUsd,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
    subtype,
    toolErrors,
  };
}

export function isCommandCodeUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return COMMANDCODE_UNKNOWN_SESSION_PATTERN.test(haystack);
}
