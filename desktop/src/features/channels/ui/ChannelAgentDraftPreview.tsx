import * as React from "react";

import {
  useChannelAgentDraft,
  useChannelDraftAgentPubkeys,
  useChannelDraftPreviews,
} from "@/features/agents/channelDraftPreviewStore";
import { useAgentDraftPreviewEnabled } from "@/features/agents/ui/agentDraftPreviewPreference";
import { buildAgentDraftPresentation } from "@/features/agents/ui/agentDraftPreviewPresentation";
import { selectAgentDraftStream } from "@/features/agents/ui/agentDraftStream";
import { useAgentTranscript } from "@/features/agents/ui/useObserverEvents";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { cn } from "@/shared/lib/cn";
import { truncateNpub } from "@/shared/lib/pubkey";
import { Shimmer } from "@/shared/ui/Shimmer";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import type { BotActivityAgent } from "./BotActivityBar";

/**
 * Cap on how many agents stream at once above one composer. Beyond this the
 * dock would push the timeline off screen; the composer activity headline
 * still reports every working agent.
 */
const MAX_STREAMING_AGENTS = 2;

type ChannelAgentDraftPreviewProps = {
  agents: BotActivityAgent[];
  channelId: string | null;
  profiles?: UserProfileLookup;
  workingBotPubkeys: string[];
};

/**
 * The reply an agent is writing, rendered above the composer where the
 * finished message will land.
 *
 * Two sources feed this, in order of reach:
 *
 * 1. **Channel previews** (kind 24201) — plaintext and `h`-tagged to the
 *    channel, so every member sees the same forming reply. Published only by
 *    harnesses whose operator opted in. These stand on their own: the frame
 *    names its writer, so a card appears for a harness this client has never
 *    heard of and holds no session with.
 * 2. **The owner's observer transcript** — the NIP-44 stream the agent's own
 *    owner already receives. It covers agents that publish no channel
 *    preview, but only for their owner, and only while the client already
 *    counts that agent as working here.
 *
 * The preview is never interactive: it is a moving draft, not a message. The
 * text the reader can select, copy, react to or reply to is the `kind:9` that
 * replaces this card when the turn ends.
 */
type StreamingAgent = {
  pubkey: string;
  name: string;
};

function resolveAgentName(pubkey: string, profiles?: UserProfileLookup) {
  const profile = profiles?.[pubkey.toLowerCase()];
  return profile?.displayName ?? profile?.name ?? truncateNpub(pubkey);
}

export function ChannelAgentDraftPreview({
  agents,
  channelId,
  profiles,
  workingBotPubkeys,
}: ChannelAgentDraftPreviewProps) {
  const previewEnabled = useAgentDraftPreviewEnabled();
  useChannelDraftPreviews(previewEnabled ? channelId : null);
  const previewAgentPubkeys = useChannelDraftAgentPubkeys(
    previewEnabled ? channelId : null,
  );
  const streamingAgents = React.useMemo(() => {
    const working = new Set(
      workingBotPubkeys.map((pubkey) => pubkey.toLowerCase()),
    );
    const seen = new Set<string>();
    const streaming: StreamingAgent[] = [];
    // Agents that are publishing come first: they have text by construction,
    // while a working agent may be reading and render nothing — and the cap
    // below is small enough that the order decides who is seen.
    for (const pubkey of previewAgentPubkeys) {
      seen.add(pubkey.toLowerCase());
      streaming.push({ pubkey, name: resolveAgentName(pubkey, profiles) });
    }
    for (const agent of agents) {
      const key = agent.pubkey.toLowerCase();
      if (!working.has(key) || seen.has(key)) {
        continue;
      }
      seen.add(key);
      streaming.push({ pubkey: agent.pubkey, name: agent.name });
    }
    return streaming.slice(0, MAX_STREAMING_AGENTS);
  }, [agents, previewAgentPubkeys, profiles, workingBotPubkeys]);

  if (!previewEnabled || streamingAgents.length === 0) {
    return null;
  }

  return (
    <div
      className="pointer-events-auto flex flex-col gap-1.5 px-5 pb-1.5"
      data-testid="channel-agent-draft-previews"
    >
      {streamingAgents.map((agent) => (
        <AgentDraftCard
          agent={agent}
          channelId={channelId}
          key={agent.pubkey}
          profiles={profiles}
        />
      ))}
    </div>
  );
}

function AgentDraftCard({
  agent,
  channelId,
  profiles,
}: {
  agent: StreamingAgent;
  channelId: string | null;
  profiles?: UserProfileLookup;
}) {
  const transcript = useAgentTranscript(true, agent.pubkey);
  const previewEnabled = useAgentDraftPreviewEnabled();
  const channelDraft = useChannelAgentDraft(channelId, agent.pubkey);
  const ownerDraft = React.useMemo(
    () => selectAgentDraftStream(transcript, channelId),
    [transcript, channelId],
  );
  // The channel preview wins when both exist: the owner sees exactly what
  // their teammates see, so a bug in the shared path cannot hide behind a
  // private stream that only one person can check.
  const draft = channelDraft ?? ownerDraft;
  const presentation = React.useMemo(
    () =>
      buildAgentDraftPresentation({
        agentName: agent.name,
        draft,
        previewEnabled,
      }),
    [agent.name, draft, previewEnabled],
  );

  if (!presentation) {
    return null;
  }

  return (
    <div
      className="rounded-2xl border border-dashed border-border bg-card/80 px-3 py-2 shadow-xs"
      data-agent-pubkey={agent.pubkey}
      data-draft-source={channelDraft ? "channel" : "owner"}
      data-testid="agent-draft-preview"
    >
      <div className="flex items-center gap-2">
        <UserAvatar
          avatarUrl={profiles?.[agent.pubkey.toLowerCase()]?.avatarUrl ?? null}
          className="shrink-0"
          displayName={agent.name}
          fallbackDelayMs={0}
          shape="squircle"
          size="xs"
        />
        <p
          aria-live="polite"
          className="min-w-0 flex-1 truncate text-xs font-medium leading-4 text-muted-foreground"
          data-testid="agent-draft-preview-status"
        >
          <Shimmer>{presentation.statusLabel}</Shimmer>
        </p>
      </div>

      {presentation.text !== "" ? (
        <StreamingText
          className="mt-1.5 max-h-40 text-sm"
          key={`text:${draft?.turnKey}`}
          testId="agent-draft-preview-text"
          text={presentation.text}
        />
      ) : null}
    </div>
  );
}

/**
 * A bounded window over text that is still growing.
 *
 * Two deliberate choices:
 *
 * - **Inert, not just unstyled.** The draft must not be selectable,
 *   clickable, focusable, or reachable by assistive tech as if it were a
 *   message. The text a reader can act on is the `kind:9` that replaces this
 *   card when the turn ends.
 * - **Plain text, not Markdown.** A draft is routinely mid-syntax — an
 *   unclosed fence or a half-typed link — and rendering that as Markdown
 *   makes the reply jump between layouts as it grows. It also keeps links out
 *   of a surface that must not be interactive.
 *
 * Each arriving chunk fades in on its own, so the reply reads as written
 * rather than replaced.
 */
function StreamingText({
  className,
  testId,
  text,
}: {
  className?: string;
  testId: string;
  text: string;
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [{ settled, chunk }, setRendered] = React.useState({
    settled: "",
    chunk: text,
  });

  React.useEffect(() => {
    setRendered((current) => {
      const previous = current.settled + current.chunk;
      if (text === previous) {
        return current;
      }
      // Previews carry the cumulative text, so the common case is an append.
      // Anything else — the harness dropped the head of a long reply, or a
      // new turn reused this block — is shown as one new chunk.
      return text.startsWith(previous)
        ? { settled: previous, chunk: text.slice(previous.length) }
        : { settled: "", chunk: text };
    });
  }, [text]);

  React.useEffect(() => {
    const element = scrollRef.current;
    if (!element || settled.length + chunk.length === 0) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [settled, chunk]);

  return (
    <div
      className={cn(
        "min-w-0 flex-1 select-none overflow-hidden whitespace-pre-wrap break-words leading-5 text-muted-foreground",
        className,
      )}
      data-testid={testId}
      inert
      ref={scrollRef}
    >
      {settled}
      <span
        className="animate-in fade-in duration-500 motion-reduce:animate-none"
        key={settled.length}
      >
        {chunk}
      </span>
    </div>
  );
}
