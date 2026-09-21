import type { AgentDraftStream } from "@/features/agents/ui/agentDraftStream";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_AGENT_DRAFT_PREVIEW } from "@/shared/constants/kinds";
import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * Channel-visible previews of the reply an agent is writing (kind 24201).
 *
 * The owner-scoped observer stream can only show an agent's own owner what it
 * is writing. These frames are plaintext and `h`-tagged to the channel, so a
 * teammate watching someone else's agent sees the same forming reply. The
 * harness publishes them only when its operator opts in, and reasoning is a
 * second opt-in on top — so most agents emit nothing here and the card falls
 * back to the owner's decrypted transcript.
 *
 * Frames carry the cumulative text, not a delta: dropping one loses a beat of
 * animation, never the text.
 */

/** How long a preview survives without a new frame. */
export const DRAFT_PREVIEW_TTL_MS = 15_000;

const TURN_TAG = "turn";
const PART_TAG = "part";
const SEQ_TAG = "seq";
const STATUS_TAG = "status";
const PART_REPLY = "reply";
const PART_THOUGHT = "thought";
const STATUS_DONE = "done";

export type ChannelDraftPreviewFrame = {
  agentPubkey: string;
  channelId: string;
  turnId: string;
  part: "reply" | "thought";
  seq: number;
  text: string;
  /** The turn is over; the preview should clear rather than age out. */
  done: boolean;
  /** Event timestamp in ms, the base for this preview's expiry. */
  timestampMs: number;
};

type DraftPart = {
  seq: number;
  text: string;
};

type DraftEntry = {
  agentPubkey: string;
  channelId: string;
  turnId: string;
  reply: DraftPart | null;
  thought: DraftPart | null;
  expiresAt: number;
};

/** Keyed by `${channelId}:${agentPubkey}` — one live turn per agent per channel. */
export type ChannelDraftPreviewState = Readonly<Record<string, DraftEntry>>;

export const EMPTY_DRAFT_PREVIEW_STATE: ChannelDraftPreviewState = {};

function tagValue(tags: string[][], key: string): string | null {
  for (const tag of tags) {
    if (tag[0] === key && typeof tag[1] === "string") {
      return tag[1];
    }
  }
  return null;
}

function entryKey(channelId: string, agentPubkey: string) {
  return `${channelId}:${agentPubkey}`;
}

/**
 * Read one relay event into a frame, or `null` when it is not a usable
 * preview. Malformed frames are dropped rather than rendered: the finished
 * kind:9 is the source of truth, so guessing at a broken preview buys nothing.
 */
export function parseChannelDraftPreview(
  event: RelayEvent,
): ChannelDraftPreviewFrame | null {
  if (event.kind !== KIND_AGENT_DRAFT_PREVIEW) {
    return null;
  }
  const channelId = tagValue(event.tags, "h");
  const turnId = tagValue(event.tags, TURN_TAG);
  const part = tagValue(event.tags, PART_TAG);
  const seq = Number.parseInt(tagValue(event.tags, SEQ_TAG) ?? "", 10);
  if (
    !channelId ||
    !turnId ||
    (part !== PART_REPLY && part !== PART_THOUGHT) ||
    !Number.isFinite(seq)
  ) {
    return null;
  }

  return {
    agentPubkey: normalizePubkey(event.pubkey),
    channelId,
    turnId,
    part,
    seq,
    text: event.content,
    done: tagValue(event.tags, STATUS_TAG) === STATUS_DONE,
    timestampMs: event.created_at * 1_000,
  };
}

/**
 * Fold a frame into the state.
 *
 * A newer turn replaces an older one outright — an agent writes one reply at a
 * time in a channel, and carrying the previous turn's text forward would show
 * a stale reply next to a fresh one. Within a turn, a lower `seq` for a part
 * is a reordered or replayed frame and is ignored, so text never rewinds.
 */
export function applyChannelDraftPreview(
  state: ChannelDraftPreviewState,
  frame: ChannelDraftPreviewFrame,
  nowMs: number = Date.now(),
): ChannelDraftPreviewState {
  const key = entryKey(frame.channelId, frame.agentPubkey);
  const existing = state[key];

  if (frame.done) {
    // The turn ended: drop the whole entry, including a part whose own
    // closing frame lost the publisher's per-tick budget.
    if (!existing || existing.turnId !== frame.turnId) {
      return state;
    }
    const next = { ...state };
    delete next[key];
    return next;
  }

  const sameTurn = existing?.turnId === frame.turnId;
  const base: DraftEntry = sameTurn
    ? existing
    : {
        agentPubkey: frame.agentPubkey,
        channelId: frame.channelId,
        turnId: frame.turnId,
        reply: null,
        thought: null,
        expiresAt: 0,
      };

  const current = frame.part === PART_REPLY ? base.reply : base.thought;
  if (current && current.seq >= frame.seq) {
    return state;
  }

  const updated: DraftEntry = {
    ...base,
    expiresAt: Math.max(
      base.expiresAt,
      frame.timestampMs + DRAFT_PREVIEW_TTL_MS,
      nowMs,
    ),
    ...(frame.part === PART_REPLY
      ? { reply: { seq: frame.seq, text: frame.text } }
      : { thought: { seq: frame.seq, text: frame.text } }),
  };

  return { ...state, [key]: updated };
}

/** Drop previews whose agent stopped publishing. Returns `state` when unchanged. */
export function pruneChannelDraftPreviews(
  state: ChannelDraftPreviewState,
  nowMs: number = Date.now(),
): ChannelDraftPreviewState {
  let changed = false;
  const next: Record<string, DraftEntry> = {};
  for (const [key, entry] of Object.entries(state)) {
    if (entry.expiresAt > nowMs) {
      next[key] = entry;
      continue;
    }
    changed = true;
  }
  return changed ? next : state;
}

/**
 * The live draft for one agent in one channel, in the same shape the
 * owner-scoped transcript selector produces, so the card renders either
 * source without knowing which it got.
 */
export function selectChannelDraftStream(
  state: ChannelDraftPreviewState,
  channelId: string | null | undefined,
  agentPubkey: string,
): AgentDraftStream | null {
  if (!channelId) {
    return null;
  }
  const entry = state[entryKey(channelId, normalizePubkey(agentPubkey))];
  if (!entry) {
    return null;
  }

  const text = entry.reply?.text.trim() ?? "";
  const thought = entry.thought?.text.trim() ?? "";
  if (text === "" && thought === "") {
    return null;
  }

  return { turnKey: entry.turnId, text, thought };
}
