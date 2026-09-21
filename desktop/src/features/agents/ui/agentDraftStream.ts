import type { TranscriptItem } from "./agentSessionTypes";

/**
 * The reply an agent is composing right now, assembled from the observer
 * transcript.
 *
 * The ACP bridge already streams `agent_message_chunk` and
 * `agent_thought_chunk` to the agent's owner, and `buildTranscriptState`
 * already coalesces those chunks into one `message` item and one `thought`
 * item per turn. This selector picks the pair belonging to the turn that is
 * still running, so a channel surface can render the reply as it forms
 * instead of waiting for the finished kind:9.
 */
export type AgentDraftStream = {
  /** Turn the draft belongs to — `turnId`, falling back to `sessionId`. */
  turnKey: string;
  /** Reply text so far. Empty while the agent has only thought or used tools. */
  text: string;
  /** Reasoning text so far. Empty when the harness emits no thought chunks. */
  thought: string;
};

/**
 * Turn identity for a transcript item. `buildTranscriptState` keys its
 * per-turn items the same way (`event.turnId ?? event.sessionId`), so this
 * groups exactly the items that belong to one prompt turn.
 */
function turnKeyOf(item: TranscriptItem): string | null {
  return item.turnId ?? item.sessionId ?? null;
}

function scopeToChannel(
  transcript: readonly TranscriptItem[],
  channelId: string | null | undefined,
): readonly TranscriptItem[] {
  if (!channelId) {
    return transcript;
  }
  return transcript.filter((item) => item.channelId === channelId);
}

/**
 * Select the in-progress reply for the newest turn in `channelId`.
 *
 * Returns `null` when the transcript has nothing for this channel, when the
 * newest turn carries no turn identity, or when that turn has produced neither
 * reply text nor reasoning yet. Callers are expected to gate on an
 * "agent is working" signal as well — this selector reads a transcript that
 * also retains completed turns, and on its own cannot tell a running turn from
 * the last finished one.
 */
export function selectAgentDraftStream(
  transcript: readonly TranscriptItem[],
  channelId: string | null | undefined,
): AgentDraftStream | null {
  const scoped = scopeToChannel(transcript, channelId);
  if (scoped.length === 0) {
    return null;
  }

  // Walk backwards to the newest item that belongs to an identified turn; that
  // turn is the one still running. Items with no turn identity (rare — an
  // observer frame that arrived before the session resolved) are skipped
  // rather than allowed to hide a live draft.
  let turnKey: string | null = null;
  for (let index = scoped.length - 1; index >= 0; index--) {
    const item = scoped[index];
    if (!item) {
      continue;
    }
    const key = turnKeyOf(item);
    if (key !== null) {
      turnKey = key;
      break;
    }
  }
  if (turnKey === null) {
    return null;
  }

  let text = "";
  let thought = "";

  for (const item of scoped) {
    if (turnKeyOf(item) !== turnKey) {
      continue;
    }
    if (item.type === "message" && item.role === "assistant") {
      text = item.text;
    } else if (item.type === "thought") {
      thought = item.text;
    }
  }

  const trimmedText = text.trim();
  const trimmedThought = thought.trim();
  if (trimmedText === "" && trimmedThought === "") {
    return null;
  }

  return {
    turnKey,
    text: trimmedText,
    thought: trimmedThought,
  };
}
