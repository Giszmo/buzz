import * as React from "react";
import { Brain } from "lucide-react";

import {
  setAgentDraftThoughtsEnabled,
  useAgentDraftPreviewEnabled,
  useAgentDraftThoughtsEnabled,
} from "@/features/agents/ui/agentDraftPreviewPreference";
import { buildAgentDraftPresentation } from "@/features/agents/ui/agentDraftPreviewPresentation";
import { selectAgentDraftStream } from "@/features/agents/ui/agentDraftStream";
import { useAgentTranscript } from "@/features/agents/ui/useObserverEvents";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { cn } from "@/shared/lib/cn";
import { Markdown } from "@/shared/ui/markdown";
import { Shimmer } from "@/shared/ui/Shimmer";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import type { BotActivityAgent } from "./BotActivityBar";

/**
 * Cap on how many agents stream at once above one composer. Beyond this the
 * dock would push the timeline off screen; the composer activity headline
 * still reports every working agent.
 */
const MAX_STREAMING_AGENTS = 2;

/** Distance from the bottom, in px, still treated as "following the stream". */
const FOLLOW_THRESHOLD_PX = 24;

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
 * Nothing new crosses the relay for this: the ACP bridge already streams
 * `agent_message_chunk` and `agent_thought_chunk` to the agent's owner as
 * NIP-44 observer frames, and the desktop transcript already coalesces them.
 * This surface only shows what the owner can already decrypt — a channel
 * member who does not own the agent sees nothing here.
 */
export function ChannelAgentDraftPreview({
  agents,
  channelId,
  profiles,
  workingBotPubkeys,
}: ChannelAgentDraftPreviewProps) {
  const previewEnabled = useAgentDraftPreviewEnabled();
  const streamingAgents = React.useMemo(() => {
    const working = new Set(
      workingBotPubkeys.map((pubkey) => pubkey.toLowerCase()),
    );
    return agents
      .filter((agent) => working.has(agent.pubkey.toLowerCase()))
      .slice(0, MAX_STREAMING_AGENTS);
  }, [agents, workingBotPubkeys]);

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
  agent: BotActivityAgent;
  channelId: string | null;
  profiles?: UserProfileLookup;
}) {
  const transcript = useAgentTranscript(true, agent.pubkey);
  const previewEnabled = useAgentDraftPreviewEnabled();
  const showThoughts = useAgentDraftThoughtsEnabled();
  const draft = React.useMemo(
    () => selectAgentDraftStream(transcript, channelId),
    [transcript, channelId],
  );
  const presentation = React.useMemo(
    () =>
      buildAgentDraftPresentation({
        agentName: agent.name,
        draft,
        previewEnabled,
        showThoughts,
      }),
    [agent.name, draft, previewEnabled, showThoughts],
  );

  if (!presentation) {
    return null;
  }

  return (
    <div
      className="rounded-2xl border border-dashed border-border bg-card/80 px-3 py-2 shadow-xs"
      data-testid="agent-draft-preview"
      data-agent-pubkey={agent.pubkey}
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
        <button
          aria-pressed={showThoughts}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
            showThoughts
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
          )}
          data-testid="agent-draft-preview-toggle-thoughts"
          onClick={() => setAgentDraftThoughtsEnabled(!showThoughts)}
          title={
            showThoughts
              ? "Stop showing the agent's reasoning."
              : "Also show the agent's reasoning while it writes."
          }
          type="button"
        >
          <Brain aria-hidden="true" className="h-3 w-3" />
          Thoughts
        </button>
      </div>

      {/* Keyed on the turn so a reader who scrolled back during one turn
          starts the next turn following the newest text again. */}
      {presentation.thought !== null ? (
        <StreamingBlock
          className="mt-1.5 max-h-24 border-l-2 border-border/70 pl-2 text-xs leading-4 text-muted-foreground"
          key={`thought:${draft?.turnKey}`}
          testId="agent-draft-preview-thought"
          text={presentation.thought}
        />
      ) : null}

      {presentation.text !== "" ? (
        <StreamingBlock
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
 * A bounded, self-scrolling window over text that is still growing.
 *
 * The block follows the newest text while the reader is at the bottom and
 * stops following the moment they scroll up, so reading back through a long
 * reply is not yanked away by the next chunk.
 */
function StreamingBlock({
  className,
  testId,
  text,
}: {
  className?: string;
  testId: string;
  text: string;
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const followRef = React.useRef(true);

  const handleScroll = React.useCallback(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    followRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <=
      FOLLOW_THRESHOLD_PX;
  }, []);

  React.useEffect(() => {
    const element = scrollRef.current;
    if (text === "" || !element || !followRef.current) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [text]);

  return (
    <div
      className={cn("min-w-0 overflow-y-auto overscroll-contain", className)}
      data-testid={testId}
      onScroll={handleScroll}
      ref={scrollRef}
    >
      <Markdown className="leading-5" content={text || " "} />
    </div>
  );
}
