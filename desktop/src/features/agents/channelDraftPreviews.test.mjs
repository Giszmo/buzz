import assert from "node:assert/strict";
import test from "node:test";

import {
  applyChannelDraftPreview,
  DRAFT_PREVIEW_TTL_MS,
  EMPTY_DRAFT_PREVIEW_STATE,
  parseChannelDraftPreview,
  pruneChannelDraftPreviews,
  selectChannelDraftStream,
} from "./channelDraftPreviews.ts";

const CHANNEL = "channel-1";
const AGENT = "ab".repeat(32);
const NOW_SECONDS = 1_800_000_000;

function previewEvent(overrides = {}) {
  const {
    channelId = CHANNEL,
    turnId = "turn-1",
    part = "reply",
    seq = 1,
    status = "writing",
    text = "forming",
    pubkey = AGENT,
    kind = 24201,
    createdAt = NOW_SECONDS,
  } = overrides;
  const tags = [
    ["h", channelId],
    ["turn", turnId],
    ["part", part],
    ["seq", String(seq)],
    ["status", status],
  ];
  return {
    id: `${turnId}:${part}:${seq}`,
    pubkey,
    created_at: createdAt,
    kind,
    tags,
    content: text,
    sig: "",
  };
}

function apply(state, event, nowMs = NOW_SECONDS * 1_000) {
  const frame = parseChannelDraftPreview(event);
  assert.ok(frame, "event should parse");
  return applyChannelDraftPreview(state, frame, nowMs);
}

test("parses a well-formed preview frame", () => {
  const frame = parseChannelDraftPreview(previewEvent({ seq: 4 }));
  assert.deepEqual(frame, {
    agentPubkey: AGENT,
    channelId: CHANNEL,
    turnId: "turn-1",
    part: "reply",
    seq: 4,
    text: "forming",
    done: false,
    timestampMs: NOW_SECONDS * 1_000,
  });
});

test("rejects other kinds and malformed frames", () => {
  assert.equal(parseChannelDraftPreview(previewEvent({ kind: 9 })), null);
  assert.equal(
    parseChannelDraftPreview(previewEvent({ part: "summary" })),
    null,
  );
  assert.equal(parseChannelDraftPreview(previewEvent({ seq: "x" })), null);

  const noTurn = previewEvent();
  noTurn.tags = noTurn.tags.filter((tag) => tag[0] !== "turn");
  assert.equal(parseChannelDraftPreview(noTurn), null);
});

test("a frame claiming to carry reasoning is not parsed", () => {
  // The harness never publishes one, but the kind is plaintext and anyone in
  // the channel can sign an event: the reader rejects the part outright
  // rather than rendering whatever a frame claims is reasoning.
  assert.equal(
    parseChannelDraftPreview(
      previewEvent({ part: "thought", text: "the deploy key is in env-carol" }),
    ),
    null,
  );

  const state = apply(
    EMPTY_DRAFT_PREVIEW_STATE,
    previewEvent({ text: "Hello" }),
  );

  assert.deepEqual(selectChannelDraftStream(state, CHANNEL, AGENT), {
    turnKey: "turn-1",
    text: "Hello",
  });
});

test("a later seq replaces the text, an older one is ignored", () => {
  let state = apply(
    EMPTY_DRAFT_PREVIEW_STATE,
    previewEvent({ seq: 2, text: "second" }),
  );
  state = apply(state, previewEvent({ seq: 3, text: "second third" }));
  assert.equal(
    selectChannelDraftStream(state, CHANNEL, AGENT).text,
    "second third",
  );

  const before = state;
  state = apply(state, previewEvent({ seq: 1, text: "first" }));
  assert.equal(state, before, "a replayed frame must not rewind the text");
});

test("a new turn replaces the previous turn's text", () => {
  let state = apply(
    EMPTY_DRAFT_PREVIEW_STATE,
    previewEvent({ text: "old turn" }),
  );
  state = apply(
    state,
    previewEvent({ turnId: "turn-2", seq: 1, text: "new turn" }),
  );

  const stream = selectChannelDraftStream(state, CHANNEL, AGENT);
  assert.equal(stream.turnKey, "turn-2");
  assert.equal(stream.text, "new turn");
});

test("a done frame clears the preview", () => {
  let state = apply(
    EMPTY_DRAFT_PREVIEW_STATE,
    previewEvent({ text: "finishing" }),
  );
  state = apply(
    state,
    previewEvent({ seq: 2, status: "done", text: "finishing" }),
  );
  assert.equal(selectChannelDraftStream(state, CHANNEL, AGENT), null);
});

test("a done frame for a stale turn leaves the live one alone", () => {
  let state = apply(
    EMPTY_DRAFT_PREVIEW_STATE,
    previewEvent({ turnId: "turn-2", text: "live" }),
  );
  state = apply(
    state,
    previewEvent({ turnId: "turn-1", seq: 9, status: "done", text: "stale" }),
  );
  assert.equal(selectChannelDraftStream(state, CHANNEL, AGENT).text, "live");
});

test("previews expire when the agent stops publishing", () => {
  const state = apply(
    EMPTY_DRAFT_PREVIEW_STATE,
    previewEvent({ text: "stalled" }),
  );
  const stillFresh = pruneChannelDraftPreviews(
    state,
    NOW_SECONDS * 1_000 + DRAFT_PREVIEW_TTL_MS - 1,
  );
  assert.equal(stillFresh, state, "an unexpired preview is left untouched");

  const expired = pruneChannelDraftPreviews(
    state,
    NOW_SECONDS * 1_000 + DRAFT_PREVIEW_TTL_MS + 1,
  );
  assert.equal(selectChannelDraftStream(expired, CHANNEL, AGENT), null);
});

test("streams are scoped to a channel and an agent", () => {
  const state = apply(EMPTY_DRAFT_PREVIEW_STATE, previewEvent());
  assert.equal(selectChannelDraftStream(state, "other-channel", AGENT), null);
  assert.equal(selectChannelDraftStream(state, CHANNEL, "cd".repeat(32)), null);
  assert.equal(selectChannelDraftStream(state, null, AGENT), null);
});

test("whitespace-only text is not a draft", () => {
  const state = apply(
    EMPTY_DRAFT_PREVIEW_STATE,
    previewEvent({ text: "   \n" }),
  );
  assert.equal(selectChannelDraftStream(state, CHANNEL, AGENT), null);
});

test("an uppercase author pubkey still matches its agent", () => {
  const state = apply(
    EMPTY_DRAFT_PREVIEW_STATE,
    previewEvent({ pubkey: AGENT.toUpperCase() }),
  );
  assert.equal(selectChannelDraftStream(state, CHANNEL, AGENT).text, "forming");
});
