import * as React from "react";

import {
  applyChannelDraftPreview,
  EMPTY_DRAFT_PREVIEW_STATE,
  parseChannelDraftPreview,
  pruneChannelDraftPreviews,
  selectChannelDraftStream,
  type ChannelDraftPreviewState,
} from "@/features/agents/channelDraftPreviews";
import type { AgentDraftStream } from "@/features/agents/ui/agentDraftStream";
import { relayClient } from "@/shared/api/relayClient";

/**
 * Live store of channel-visible agent draft previews (kind 24201).
 *
 * One subscription per channel, shared by every card in that channel:
 * the draft dock renders a card per working agent, and each of them
 * subscribing separately would open a REQ per agent for the same filter.
 */

const PRUNE_INTERVAL_MS = 1_000;

let state: ChannelDraftPreviewState = EMPTY_DRAFT_PREVIEW_STATE;
const listeners = new Set<() => void>();
const subscriberCountByChannel = new Map<string, number>();
const disposersByChannel = new Map<string, () => Promise<void> | void>();
let pruneTimer: ReturnType<typeof setInterval> | null = null;

function notify() {
  for (const listener of listeners) {
    listener();
  }
}

function setState(next: ChannelDraftPreviewState) {
  if (next === state) {
    return;
  }
  state = next;
  notify();
}

function subscribeStore(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ChannelDraftPreviewState {
  return state;
}

function ensurePruneTimer() {
  if (pruneTimer !== null || typeof window === "undefined") {
    return;
  }
  pruneTimer = window.setInterval(() => {
    setState(pruneChannelDraftPreviews(state));
    if (
      Object.keys(state).length === 0 &&
      subscriberCountByChannel.size === 0
    ) {
      stopPruneTimer();
    }
  }, PRUNE_INTERVAL_MS);
}

function stopPruneTimer() {
  if (pruneTimer === null) {
    return;
  }
  window.clearInterval(pruneTimer);
  pruneTimer = null;
}

/**
 * Keep a channel's preview subscription open while this component is mounted.
 *
 * Reference-counted per channel: the last unmount closes the relay
 * subscription and forgets that channel's previews, so a channel nobody is
 * looking at costs nothing.
 */
export function useChannelDraftPreviews(channelId: string | null | undefined) {
  React.useEffect(() => {
    if (!channelId) {
      return;
    }

    const count = (subscriberCountByChannel.get(channelId) ?? 0) + 1;
    subscriberCountByChannel.set(channelId, count);
    ensurePruneTimer();

    if (count === 1) {
      // The relay subscription resolves asynchronously, so the disposer
      // registered now is a shim: unmounting before it resolves sets
      // `disposed`, and the late subscription closes itself.
      let disposed = false;
      let dispose: (() => Promise<void> | void) | null = null;
      disposersByChannel.set(channelId, () => {
        disposed = true;
        return dispose?.();
      });
      relayClient
        .subscribeToAgentDraftPreviews(channelId, (event) => {
          const frame = parseChannelDraftPreview(event);
          if (!frame || frame.channelId !== channelId) {
            return;
          }
          setState(applyChannelDraftPreview(state, frame));
        })
        .then((unsubscribe) => {
          if (disposed) {
            void unsubscribe();
            return;
          }
          dispose = unsubscribe;
        })
        .catch((error) => {
          console.error(
            "Failed to subscribe to agent draft previews",
            channelId,
            error,
          );
        });
    }

    return () => {
      const remaining = (subscriberCountByChannel.get(channelId) ?? 1) - 1;
      if (remaining > 0) {
        subscriberCountByChannel.set(channelId, remaining);
        return;
      }
      subscriberCountByChannel.delete(channelId);
      const dispose = disposersByChannel.get(channelId);
      disposersByChannel.delete(channelId);
      void dispose?.();
      dropChannel(channelId);
    };
  }, [channelId]);
}

function dropChannel(channelId: string) {
  const next: Record<string, (typeof state)[string]> = {};
  let changed = false;
  for (const [key, entry] of Object.entries(state)) {
    if (entry.channelId === channelId) {
      changed = true;
      continue;
    }
    next[key] = entry;
  }
  if (changed) {
    setState(next);
  }
}

/** The forming reply one agent is publishing into this channel, if any. */
export function useChannelAgentDraft(
  channelId: string | null | undefined,
  agentPubkey: string,
): AgentDraftStream | null {
  const previews = React.useSyncExternalStore(
    subscribeStore,
    getSnapshot,
    () => EMPTY_DRAFT_PREVIEW_STATE,
  );
  return React.useMemo(
    () => selectChannelDraftStream(previews, channelId, agentPubkey),
    [previews, channelId, agentPubkey],
  );
}

/** Test seam: drop every preview and subscription bookkeeping. */
export function resetChannelDraftPreviewStore() {
  state = EMPTY_DRAFT_PREVIEW_STATE;
  subscriberCountByChannel.clear();
  disposersByChannel.clear();
  stopPruneTimer();
  notify();
}
