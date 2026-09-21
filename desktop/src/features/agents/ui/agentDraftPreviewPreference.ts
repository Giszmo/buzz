import * as React from "react";

/**
 * Device-level preferences for the live agent draft shown above the composer.
 *
 * One switch: render the reply as the agent writes it. On by default — the
 * text is already going to reach every member of the channel, just a minute
 * later, so seeing it form hides nothing. Readers who find a moving draft
 * distracting switch it off.
 *
 * There is deliberately no reasoning switch: reasoning never reaches this
 * surface, so no reader preference could expose it.
 *
 * Stored in localStorage and shared across every channel, like the other
 * transcript preferences. It is a UI preference, not community-scoped data, so
 * it intentionally survives a community switch.
 */
const PREVIEW_STORAGE_KEY = "buzz:agent-draft-preview";

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

/** Update "show the reply as it is written" and notify subscribers. */
export function setAgentDraftPreviewEnabled(enabled: boolean): void {
  previewEnabled = enabled;
  writeStoredFlag(PREVIEW_STORAGE_KEY, enabled);
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
