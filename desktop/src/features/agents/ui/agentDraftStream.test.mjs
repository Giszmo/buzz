import assert from "node:assert/strict";
import test from "node:test";

import { selectAgentDraftStream } from "./agentDraftStream.ts";

const CHANNEL = "channel-1";

function message(text, overrides = {}) {
  return {
    id: `assistant:${overrides.turnId ?? "turn-1"}`,
    type: "message",
    renderClass: "message",
    role: "assistant",
    title: "Assistant",
    text,
    timestamp: "2026-09-21T10:00:00.000Z",
    channelId: CHANNEL,
    turnId: "turn-1",
    sessionId: "session-1",
    ...overrides,
  };
}

function thought(text, overrides = {}) {
  return {
    id: `thinking:${overrides.turnId ?? "turn-1"}`,
    type: "thought",
    renderClass: "thought",
    title: "Thinking",
    text,
    timestamp: "2026-09-21T09:59:00.000Z",
    channelId: CHANNEL,
    turnId: "turn-1",
    sessionId: "session-1",
    ...overrides,
  };
}

function lifecycle(overrides = {}) {
  return {
    id: "turn:turn-1",
    type: "lifecycle",
    renderClass: "status",
    title: "Turn started",
    text: "",
    timestamp: "2026-09-21T09:58:00.000Z",
    channelId: CHANNEL,
    turnId: "turn-1",
    sessionId: "session-1",
    ...overrides,
  };
}

test("returns the coalesced assistant text for the newest turn", () => {
  const draft = selectAgentDraftStream(
    [lifecycle(), thought("weighing options"), message("Half a sent")],
    CHANNEL,
  );
  assert.deepEqual(draft, {
    turnKey: "turn-1",
    text: "Half a sent",
    thought: "weighing options",
  });
});

test("ignores transcript items from other channels", () => {
  const draft = selectAgentDraftStream(
    [
      message("other channel reply", {
        channelId: "channel-2",
        turnId: "turn-9",
        timestamp: "2026-09-21T11:00:00.000Z",
      }),
      message("this channel reply"),
    ],
    CHANNEL,
  );
  assert.equal(draft?.text, "this channel reply");
  assert.equal(draft?.turnKey, "turn-1");
});

test("does not leak the previous turn's reply into a new turn", () => {
  // A new turn has started (its turn_started lifecycle row is newest) but no
  // chunk has arrived yet. Showing turn-1's finished text here would present
  // stale words as the reply being written right now.
  const draft = selectAgentDraftStream(
    [
      message("finished answer"),
      lifecycle({
        id: "turn:turn-2",
        turnId: "turn-2",
        timestamp: "2026-09-21T10:05:00.000Z",
      }),
    ],
    CHANNEL,
  );
  assert.equal(draft, null);
});

test("falls back to sessionId when the harness emits no turn id", () => {
  const draft = selectAgentDraftStream(
    [message("no turn id", { turnId: null })],
    CHANNEL,
  );
  assert.equal(draft?.turnKey, "session-1");
  assert.equal(draft?.text, "no turn id");
});

test("skips trailing items with no turn identity rather than hiding the draft", () => {
  const draft = selectAgentDraftStream(
    [
      message("still writing"),
      lifecycle({
        id: "parse-error",
        turnId: null,
        sessionId: null,
        timestamp: "2026-09-21T10:01:00.000Z",
      }),
    ],
    CHANNEL,
  );
  assert.equal(draft?.text, "still writing");
});

test("returns null when the turn has produced neither text nor reasoning", () => {
  assert.equal(selectAgentDraftStream([lifecycle()], CHANNEL), null);
  assert.equal(
    selectAgentDraftStream([message("   "), thought("  ")], CHANNEL),
    null,
  );
});

test("returns null for an empty transcript", () => {
  assert.equal(selectAgentDraftStream([], CHANNEL), null);
});

test("reports a thought-only turn with empty text", () => {
  const draft = selectAgentDraftStream([thought("still reasoning")], CHANNEL);
  assert.equal(draft?.text, "");
  assert.equal(draft?.thought, "still reasoning");
});
