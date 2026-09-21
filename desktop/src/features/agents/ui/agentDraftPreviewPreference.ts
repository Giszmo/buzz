import * as React from "react";

/**
 * Device-level preferences for the live agent draft shown above the composer.
 *
 * Two independent switches:
 *
 * - **preview** — render the reply as the agent writes it. On by default:
 *   the text is already going to reach every member of the channel, just a
 *   minute later, so seeing it form hides nothing. Readers who find a moving
 *   draft distracting switch it off.
 * - **thoughts** — also render the agent's reasoning for that turn. On by
 *   default but collapsed to one line: knowing the agent started reasoning is
 *   useful at a glance, while the full text is several screens of
 *   self-correction and is expanded deliberately.
 *
 * Both are stored in localStorage and shared across every channel, like the
 * other transcript preferences. They are UI preferences, not community-scoped
 * data, so they intentionally survive a community switch.
 */
const PREVIEW_STORAGE_KEY = "buzz:agent-draft-preview";
const THOUGHTS_STORAGE_KEY = "buzz:agent-draft-thoughts";

const listeners = new Set<() => void>();

function readStoredFlag(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const stored = window.localStorage.getItem(key);
    if (stored === null) {
      return fallback;
    }
    return stored !== "0";
  } catch {
    return fallback;
  }
}

function writeStoredFlag(key: string, enabled: boolean): void {
  try {
    window.localStorage.setItem(key, enabled ? "1" : "0");
  } catch {
    // Persistence is best-effort; the in-memory value still applies.
  }
}

let previewEnabled = readStoredFlag(PREVIEW_STORAGE_KEY, true);
let thoughtsEnabled = readStoredFlag(THOUGHTS_STORAGE_KEY, true);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function getPreviewSnapshot(): boolean {
  return previewEnabled;
}

function getPreviewServerSnapshot(): boolean {
  return true;
}

function getThoughtsSnapshot(): boolean {
  return thoughtsEnabled;
}

function getThoughtsServerSnapshot(): boolean {
  return true;
}

/** Update "show the reply as it is written" and notify subscribers. */
export function setAgentDraftPreviewEnabled(enabled: boolean): void {
  previewEnabled = enabled;
  writeStoredFlag(PREVIEW_STORAGE_KEY, enabled);
  notify();
}

/** Update "show the agent's reasoning" and notify subscribers. */
export function setAgentDraftThoughtsEnabled(enabled: boolean): void {
  thoughtsEnabled = enabled;
  writeStoredFlag(THOUGHTS_STORAGE_KEY, enabled);
  notify();
}

/** Whether the forming reply should be rendered above the composer. */
export function useAgentDraftPreviewEnabled(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    getPreviewSnapshot,
    getPreviewServerSnapshot,
  );
}

/** Whether the agent's reasoning should be rendered alongside the reply. */
export function useAgentDraftThoughtsEnabled(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    getThoughtsSnapshot,
    getThoughtsServerSnapshot,
  );
}
