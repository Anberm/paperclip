import pc from "picocolors";

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

export function printCommandCodeStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    if (debug) console.log(pc.gray(line));
    return;
  }

  const type = asString(parsed.type);

  if (type === "result") {
    const subtype = asString(parsed.subtype, "success");
    const usage = readUsage(parsed.usage);
    const finalText = asString(parsed.finalText).trim();
    const error = errorText(parsed.error);
    if (error) {
      console.log(pc.red(`error: ${error}`));
      return;
    }
    if (finalText) console.log(pc.green(finalText));
    console.log(
      pc.blue(
        `result: ${subtype} (in=${usage.input} out=${usage.output} cached=${usage.cached} duration=${asString(parsed.durationMs, "")}ms)`,
      ),
    );
    return;
  }

  if (type !== "event") {
    if (debug) console.log(pc.gray(line));
    return;
  }

  const event = asRecord(parsed.event);
  if (!event) {
    if (debug) console.log(pc.gray(line));
    return;
  }

  const eventType = asString(event.type);

  if (eventType === "run_start") {
    const sessionId = asString(event.sessionId);
    if (sessionId) console.log(pc.blue(`session: ${sessionId}`));
    return;
  }

  if (eventType === "text_delta") {
    const delta = asString(event.delta).trim();
    if (delta) console.log(pc.green(delta));
    return;
  }

  if (eventType === "thinking_delta") {
    const delta = asString(event.delta).trim();
    if (delta && debug) console.log(pc.gray(`thinking: ${delta}`));
    return;
  }

  if (eventType === "thinking_end") {
    const text = asString(event.text).trim();
    if (text && debug) console.log(pc.gray(`thinking: ${text}`));
    return;
  }

  if (eventType === "message_update" || eventType === "message_end") {
    const content = event.content;
    if (!Array.isArray(content)) return;
    for (const entry of content) {
      const part = asRecord(entry);
      if (!part) continue;
      const partType = asString(part.type);
      if (partType === "text") {
        const text = asString(part.text).trim();
        if (text) console.log(pc.green(text));
      } else if (partType === "tool_use") {
        const toolName = asString(part.name, "tool");
        console.log(pc.yellow(`tool_call: ${toolName}`));
      }
    }
    return;
  }

  if (eventType === "tool_queued" || eventType === "tool_running") {
    const toolName = asString(event.toolName, "tool");
    const toolCallId = asString(event.toolCallId);
    console.log(pc.yellow(`tool_call: ${toolName}${toolCallId ? ` (${toolCallId})` : ""}`));
    return;
  }

  if (eventType === "tool_completed") {
    const toolName = asString(event.toolName, "tool");
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
    const prefix = `tool_result ${toolName}`;
    if (content) {
      console.log((isError ? pc.red : pc.gray)(`${prefix}: ${content}`));
    } else {
      console.log((isError ? pc.red : pc.gray)(`${prefix}`));
    }
    return;
  }

  if (eventType === "turn_start") {
    const turnNumber = asNumber(event.turnNumber);
    console.log(pc.blue(`turn started${turnNumber ? ` (${turnNumber})` : ""}`));
    return;
  }

  if (eventType === "turn_end") {
    const usage = readUsage(event.usage);
    console.log(
      pc.blue(`turn finished (in=${usage.input} out=${usage.output} cached=${usage.cached})`),
    );
    return;
  }

  if (eventType === "run_end") {
    const result = asRecord(event.result);
    const usage = readUsage(result?.usage);
    const finalText = asString(result?.finalText).trim();
    if (finalText) console.log(pc.green(finalText));
    console.log(pc.blue(`run finished (in=${usage.input} out=${usage.output} cached=${usage.cached})`));
    return;
  }

  if (eventType === "error") {
    const message = errorText(event.error ?? event.message);
    if (message) console.log(pc.red(`error: ${message}`));
    return;
  }

  if (debug) console.log(pc.gray(line));
}
