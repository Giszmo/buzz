import type { AgentDraftStream } from "./agentDraftStream";

/** What the live draft surface renders for one agent, or nothing at all. */
export type AgentDraftPresentation = {
  /** Reply text so far; empty while the agent has only reasoning to show. */
  text: string;
  /** Reasoning text, or `null` when thoughts are off or the turn has none. */
  thought: string | null;
  /** Shimmered status line, e.g. `Carol is writing…`. */
  statusLabel: string;
};

/**
 * Decide what to render for one working agent.
 *
 * Returns `null` whenever there is nothing honest to show — no draft yet, the
 * preview switched off, or a turn that so far produced only reasoning while
 * the reader has reasoning switched off. Rendering an empty card would claim
 * the agent is writing when it may only be reading, which the activity
 * headline next to the composer already covers.
 */
export function buildAgentDraftPresentation({
  agentName,
  draft,
  previewEnabled,
  showThoughts,
}: {
  agentName: string;
  draft: AgentDraftStream | null;
  previewEnabled: boolean;
  showThoughts: boolean;
}): AgentDraftPresentation | null {
  if (!previewEnabled || draft === null) {
    return null;
  }

  const thought = showThoughts && draft.thought !== "" ? draft.thought : null;
  if (draft.text === "" && thought === null) {
    return null;
  }

  return {
    text: draft.text,
    thought,
    statusLabel:
      draft.text === ""
        ? `${agentName} is thinking…`
        : `${agentName} is writing…`,
  };
}
