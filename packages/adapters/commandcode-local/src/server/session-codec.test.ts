import { describe, expect, it } from "vitest";
import { sessionCodec } from "./index.js";

describe("commandcode-local sessionCodec", () => {
  it("serializes and deserializes session params round-trip", () => {
    const params = {
      sessionId: "abc-123",
      cwd: "/workspace",
      workspaceId: "ws-1",
    };
    const serialized = sessionCodec.serialize(params);
    expect(serialized).toEqual(params);
    const deserialized = sessionCodec.deserialize(serialized);
    expect(deserialized).toEqual(params);
  });

  it("accepts snake_case legacy shapes on deserialize", () => {
    const deserialized = sessionCodec.deserialize({
      session_id: "abc-123",
      workdir: "/workspace",
    });
    expect(deserialized).toEqual({
      sessionId: "abc-123",
      cwd: "/workspace",
    });
  });

  it("returns null for empty or missing session id", () => {
    expect(sessionCodec.serialize(null)).toBeNull();
    expect(sessionCodec.deserialize({})).toBeNull();
    expect(sessionCodec.deserialize("not-an-object")).toBeNull();
  });

  it("getDisplayId returns the session id", () => {
    expect(sessionCodec.getDisplayId?.({ sessionId: "abc-123" })).toBe("abc-123");
    expect(sessionCodec.getDisplayId?.(null)).toBeNull();
  });
});
