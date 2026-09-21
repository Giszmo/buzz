import type { AgentDraftStream } from "./agentDraftStream";

/** What the live draft surface renders for one agent, or nothing at all. */
export type AgentDraftPresentation = {
  /** Reply text so far. */
  text: string;
  /** Shimmered status line, e.g. `Carol is writing…`. */
  statusLabel: string;
};

/**
 * Decide what to render for one working agent.
 *
 * Returns `null` whenever there is nothing honest to show — no draft yet, or
 * the preview switched off. Rendering an empty card would claim the agent is
 * writing when it may only be reading, which the activity headline next to the
 * composer already covers.
 */
export function buildAgentDraftPresentation({
  agentName,
  draft,
  previewEnabled,
}: {
  agentName: string;
  draft: AgentDraftStream | null;
  previewEnabled: boolean;
}): AgentDraftPresentation | null {
  if (!previewEnabled || draft === null || draft.text === "") {
    return null;
  }

  return {
    text: draft.text,
    statusLabel: `${agentName} is writing…`,
  };
}
