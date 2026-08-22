import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readUsage(value: unknown): { input: number; output: number; cached: number } {
  const rec = asRecord(value);
  return {
    input: asNumber(rec?.inputTokens, 0),
    output: asNumber(rec?.outputTokens, 0),
    cached: asNumber(rec?.cacheReadTokens, 0),
  };
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return "";
  const msg = asString(rec.message);
  if (msg) return msg;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

function parseToolEvent(event: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const toolName = asString(event.toolName, "tool");
  const toolCallId = asString(event.toolCallId, toolName);
  const input = asRecord(event.input) ?? {};

  if (event.type === "tool_queued" || event.type === "tool_running") {
    return [
      {
        kind: "tool_call",
        ts,
        name: toolName,
        toolUseId: toolCallId,
        input,
      },
    ];
  }

  // tool_completed
  const result = event.result;
  let content = "";
  if (Array.isArray(result)) {
    const parts: string[] = [];
    for (const entry of result) {
      const part = asRecord(entry);
      if (!part) continue;
      const text = asString(part.text).trim();
      if (text) parts.push(text);
    }
    content = parts.join("\n");
  } else if (typeof result === "string") {
    content = result;
  }
  const isError = content.toLowerCase().includes("error") || Boolean(event.error);

  return [
    {
      kind: "tool_call",
      ts,
      name: toolName,
      toolUseId: toolCallId,
      input,
    },
    {
      kind: "tool_result",
      ts,
      toolUseId: toolCallId,
      content: content || `${toolName} completed`,
      isError,
    },
  ];
}

export function parseCommandCodeStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);

  if (type === "result") {
    const subtype = asString(parsed.subtype, "success");
    const usage = readUsage(parsed.usage);
    const finalText = asString(parsed.finalText).trim();
    const error = errorText(parsed.error);
    const isError = subtype === "error" || Boolean(error);
    const entries: TranscriptEntry[] = [
      {
        kind: "result",
        ts,
        text: finalText || subtype,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cachedTokens: usage.cached,
        costUsd: 0,
        subtype,
        isError,
        errors: error ? [error] : [],
      },
    ];
    const sessionId = asString(parsed.sessionId).trim();
    if (sessionId) {
      entries.unshift({
        kind: "init",
        ts,
        model: "",
        sessionId,
      });
    }
    return entries;
  }

  if (type !== "event") {
    return [{ kind: "stdout", ts, text: line }];
  }

  const event = asRecord(parsed.event);
  if (!event) return [{ kind: "stdout", ts, text: line }];

  const eventType = asString(event.type);

  if (eventType === "run_start") {
    const sessionId = asString(event.sessionId).trim();
    if (!sessionId) return [];
    return [{ kind: "init", ts, model: "", sessionId }];
  }

  if (eventType === "text_delta") {
    const delta = asString(event.delta).trim();
    if (!delta) return [];
    return [{ kind: "assistant", ts, text: delta }];
  }

  if (eventType === "thinking_delta") {
    const delta = asString(event.delta).trim();
    if (!delta) return [];
    return [{ kind: "thinking", ts, text: delta }];
  }

  if (eventType === "thinking_end") {
    const text = asString(event.text).trim();
    if (!text) return [];
    return [{ kind: "thinking", ts, text }];
  }

  if (eventType === "message_update" || eventType === "message_end") {
    const content = event.content;
    if (!Array.isArray(content)) return [];
    const entries: TranscriptEntry[] = [];
    for (const entry of content) {
      const part = asRecord(entry);
      if (!part) continue;
      const partType = asString(part.type);
      if (partType === "text") {
        const text = asString(part.text).trim();
        if (text) entries.push({ kind: "assistant", ts, text });
      } else if (partType === "thinking") {
        const text = asString(part.thinking).trim();
        if (text) entries.push({ kind: "thinking", ts, text });
      } else if (partType === "tool_use") {
        const toolName = asString(part.name, "tool");
        const input = asRecord(part.input) ?? {};
        entries.push({
          kind: "tool_call",
          ts,
          name: toolName,
          toolUseId: asString(part.id, toolName),
          input,
        });
      }
    }
    return entries;
  }

  if (eventType === "tool_queued" || eventType === "tool_running" || eventType === "tool_completed") {
    return parseToolEvent(event, ts);
  }

  if (eventType === "turn_start") {
    const turnNumber = asNumber(event.turnNumber);
    return [
      {
        kind: "system",
        ts,
        text: `turn started${turnNumber ? ` (${turnNumber})` : ""}`,
      },
    ];
  }

  if (eventType === "turn_end") {
    const usage = readUsage(event.usage);
    return [
      {
        kind: "result",
        ts,
        text: "turn finished",
        inputTokens: usage.input,
        outputTokens: usage.output,
        cachedTokens: usage.cached,
        costUsd: 0,
        subtype: "turn_end",
        isError: false,
        errors: [],
      },
    ];
  }

  if (eventType === "run_end") {
    const result = asRecord(event.result);
    const usage = readUsage(result?.usage);
    const finalText = asString(result?.finalText).trim();
    return [
      {
        kind: "result",
        ts,
        text: finalText || "run finished",
        inputTokens: usage.input,
        outputTokens: usage.output,
        cachedTokens: usage.cached,
        costUsd: 0,
        subtype: "run_end",
        isError: false,
        errors: [],
      },
    ];
  }

  if (eventType === "error") {
    const text = errorText(event.error ?? event.message);
    return [{ kind: "stderr", ts, text: text || line }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
