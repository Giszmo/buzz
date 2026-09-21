import { expect, test, type Page } from "@playwright/test";

import {
  KIND_AGENT_DRAFT_PREVIEW,
  KIND_TYPING_INDICATOR,
} from "../../src/shared/constants/kinds";
import { TEST_IDENTITIES, installMockBridge } from "../helpers/bridge";

const AGENTS_CHANNEL_ID = "94a444a4-c0a3-5966-ab05-530c6ddc2301";
const AGENT_PUBKEY = TEST_IDENTITIES.alice.pubkey;
// A publisher this client has no agent record, session or owner link for.
const STRANGER_PUBKEY = TEST_IDENTITIES.charlie.pubkey;
const TURN_ID = "draft-stream-turn";
const SESSION_ID = "draft-stream-session";
const SHOTS = "test-results/channel-agent-draft-stream";

const REPLY_TEXT =
  "The frames are already on the wire — they are just encrypted to the owner.";
const THOUGHT_TEXT = "Check whether the observer frames are channel-scoped.";

type SeededObserverEvent = {
  seq: number;
  timestamp: string;
  kind: string;
  agentIndex: number | null;
  channelId: string | null;
  sessionId: string | null;
  turnId: string | null;
  payload: unknown;
};

function chunkEvent(
  seq: number,
  sessionUpdate: "agent_message_chunk" | "agent_thought_chunk",
  text: string,
  channelId: string = AGENTS_CHANNEL_ID,
): SeededObserverEvent {
  return {
    seq,
    timestamp: new Date(Date.UTC(2026, 8, 21, 12, 0, seq)).toISOString(),
    kind: "acp_read",
    agentIndex: 0,
    channelId,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    payload: {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate,
          messageId: `${TURN_ID}-message`,
          content: { type: "text", text },
        },
      },
    },
  };
}

async function seedObserverEvents(page: Page, events: SeededObserverEvent[]) {
  await page.waitForFunction(
    () => typeof window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__ === "function",
  );
  await page.evaluate(
    ({ agentPubkey, evts }) => {
      window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__?.({
        agentPubkey,
        events: evts,
      });
    },
    { agentPubkey: AGENT_PUBKEY, evts: events },
  );
}

async function emitChannelDraft(
  page: Page,
  input: {
    part: "reply" | "thought";
    seq: number;
    text: string;
    done?: boolean;
    pubkey?: string;
  },
) {
  const { pubkey = AGENT_PUBKEY, ...draft } = input;
  await page.evaluate(
    ({ agentPubkey, turnId, draft: payload }) => {
      window.__BUZZ_E2E_EMIT_MOCK_AGENT_DRAFT__?.({
        channelName: "agents",
        pubkey: agentPubkey,
        turnId,
        ...payload,
      });
    },
    { agentPubkey: pubkey, turnId: TURN_ID, draft },
  );
}

/** Open the channel without putting any agent into the working set. */
async function openChannelIdle(page: Page) {
  await page.goto("/");
  await page.getByTestId("channel-agents").click();
  await expect(page.getByTestId("chat-title")).toHaveText("agents");
  await page.waitForFunction(
    ({ channelName, kind }) =>
      window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
        channelName,
        kind,
      }) ?? false,
    { channelName: "agents", kind: KIND_AGENT_DRAFT_PREVIEW },
  );
}

/**
 * Put the agent into the channel's "working" set the same way
 * `channels.spec.ts` does — a typing indicator is mirrored into the unified
 * working signal, which is what gates every composer-dock agent surface.
 */
async function startWorkingTurn(page: Page) {
  await page.goto("/");
  await page.getByTestId("channel-agents").click();
  await expect(page.getByTestId("chat-title")).toHaveText("agents");
  await page.waitForFunction(
    ({ channelName, kind }) =>
      window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
        channelName,
        kind,
      }) ?? false,
    { channelName: "agents", kind: KIND_TYPING_INDICATOR },
  );
  await page.evaluate((pubkey) => {
    window.__BUZZ_E2E_EMIT_MOCK_TYPING__?.({
      channelName: "agents",
      pubkey,
    });
  }, AGENT_PUBKEY);
  await expect(page.getByTestId("bot-activity-composer-trigger")).toBeVisible();
}

test.describe("agent draft streaming above the composer", () => {
  test.beforeEach(async ({ page }) => {
    await installMockBridge(page);
  });

  test("streams the forming reply from the owner's observer frames", async ({
    page,
  }) => {
    await startWorkingTurn(page);

    // Reasoning opens nothing: the card exists for the reply, and reasoning
    // never reaches this surface even for the agent's own owner.
    await seedObserverEvents(page, [
      chunkEvent(1, "agent_thought_chunk", THOUGHT_TEXT),
    ]);
    const card = page.getByTestId("agent-draft-preview");
    await expect(
      page.getByTestId("bot-activity-composer-trigger"),
    ).toBeVisible();
    await expect(card).toHaveCount(0);

    await seedObserverEvents(page, [
      chunkEvent(2, "agent_message_chunk", REPLY_TEXT),
    ]);

    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-draft-source", "owner");
    await expect(card.getByTestId("agent-draft-preview-status")).toContainText(
      "is writing",
    );
    await expect(card.getByTestId("agent-draft-preview-text")).toContainText(
      REPLY_TEXT,
    );

    // The reasoning seeded above is nowhere on the card, in any form.
    await expect(card).not.toContainText(THOUGHT_TEXT);

    await page.screenshot({
      animations: "disabled",
      path: `${SHOTS}/draft-owner-stream.png`,
    });

    // Later chunks replace the coalesced text in place — one forming message,
    // not a growing trail of rows.
    await seedObserverEvents(page, [
      chunkEvent(
        3,
        "agent_message_chunk",
        `${REPLY_TEXT} A client change is enough for the owner.`,
      ),
    ]);
    await expect(page.getByTestId("agent-draft-preview")).toHaveCount(1);
    await expect(card.getByTestId("agent-draft-preview-text")).toContainText(
      "A client change is enough for the owner.",
    );
  });

  test("renders a channel preview published by an agent nobody here owns", async ({
    page,
  }) => {
    await startWorkingTurn(page);
    await page.waitForFunction(
      ({ channelName, kind }) =>
        window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
          channelName,
          kind,
        }) ?? false,
      { channelName: "agents", kind: KIND_AGENT_DRAFT_PREVIEW },
    );

    // A frame claiming to carry reasoning is refused by the reader, so a
    // harness that regressed — or a channel member forging one by hand —
    // cannot put reasoning on this surface.
    await emitChannelDraft(page, {
      part: "thought",
      seq: 1,
      text: THOUGHT_TEXT,
    });
    await expect(page.getByTestId("agent-draft-preview")).toHaveCount(0);

    await emitChannelDraft(page, { part: "reply", seq: 1, text: "The frames" });

    const card = page.getByTestId("agent-draft-preview");
    await expect(card).toBeVisible();
    await expect(card).not.toContainText(THOUGHT_TEXT);
    // No observer frames were seeded: this text can only have come from the
    // plaintext channel-scoped preview every member receives.
    await expect(card).toHaveAttribute("data-draft-source", "channel");
    await expect(card.getByTestId("agent-draft-preview-text")).toContainText(
      "The frames",
    );

    // Cumulative frames replace the text rather than appending a second row.
    await emitChannelDraft(page, { part: "reply", seq: 2, text: REPLY_TEXT });
    await expect(page.getByTestId("agent-draft-preview")).toHaveCount(1);
    await expect(card.getByTestId("agent-draft-preview-text")).toContainText(
      REPLY_TEXT,
    );

    await page.screenshot({
      animations: "disabled",
      path: `${SHOTS}/draft-channel-stream.png`,
    });

    // The draft is a moving preview, not a message: nothing in it is
    // selectable, clickable, or focusable.
    await expect(card.getByTestId("agent-draft-preview-text")).toHaveAttribute(
      "inert",
      "",
    );

    // The closing frame clears the card; the finished kind:9 is what remains.
    await emitChannelDraft(page, {
      done: true,
      part: "reply",
      seq: 3,
      text: REPLY_TEXT,
    });
    await expect(page.getByTestId("agent-draft-preview")).toHaveCount(0);
  });

  test("streams a harness this client does not know is an agent", async ({
    page,
  }) => {
    // The case every self-hosted harness is in: it joined the channel as an
    // ordinary member, announced no agent record and declared no owner, so
    // this client holds no session with it and never counts it as working.
    // Before the frames were allowed to stand on their own, its previews were
    // received and then dropped for want of a roster entry — nothing rendered
    // for anyone, which is exactly what it looked like in production.
    await openChannelIdle(page);
    await expect(page.getByTestId("bot-activity-composer-trigger")).toHaveCount(
      0,
    );

    await emitChannelDraft(page, {
      part: "reply",
      pubkey: STRANGER_PUBKEY,
      seq: 1,
      text: REPLY_TEXT,
    });

    const card = page.getByTestId("agent-draft-preview");
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-agent-pubkey", STRANGER_PUBKEY);
    await expect(card).toHaveAttribute("data-draft-source", "channel");
    await expect(card.getByTestId("agent-draft-preview-status")).toContainText(
      "is writing",
    );
    await expect(card.getByTestId("agent-draft-preview-text")).toContainText(
      REPLY_TEXT,
    );

    // Still no working signal anywhere: the card came from the frame alone.
    await expect(page.getByTestId("bot-activity-composer-trigger")).toHaveCount(
      0,
    );

    await page.screenshot({
      animations: "disabled",
      path: `${SHOTS}/draft-unknown-harness.png`,
    });

    await emitChannelDraft(page, {
      done: true,
      part: "reply",
      pubkey: STRANGER_PUBKEY,
      seq: 2,
      text: REPLY_TEXT,
    });
    await expect(page.getByTestId("agent-draft-preview")).toHaveCount(0);
  });

  test("renders above the thread composer, not only the channel one", async ({
    page,
  }) => {
    // Threads are where a reply is usually waited for, and the thread drawer
    // has its own composer. Before this the dock was mounted on the channel
    // composer alone, so opening a thread hid the forming reply entirely.
    await openChannelIdle(page);
    const rootId = "d4".repeat(32);
    await page.evaluate(
      ({ id, pubkey }) => {
        window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
          channelName: "agents",
          content: "Thread root the agent is answering in.",
          id,
          pubkey,
        });
      },
      { id: rootId, pubkey: STRANGER_PUBKEY },
    );
    await page.getByTestId(`reply-message-${rootId}`).click({ force: true });
    await expect(page.getByTestId("message-thread-panel")).toBeVisible();

    await emitChannelDraft(page, {
      part: "reply",
      pubkey: STRANGER_PUBKEY,
      seq: 1,
      text: REPLY_TEXT,
    });

    const threadCard = page
      .getByTestId("thread-composer-overlay")
      .getByTestId("agent-draft-preview");
    await expect(threadCard).toBeVisible();
    await expect(threadCard).toHaveAttribute("data-draft-source", "channel");
    await expect(
      threadCard.getByTestId("agent-draft-preview-text"),
    ).toContainText(REPLY_TEXT);

    await page.screenshot({
      animations: "disabled",
      path: `${SHOTS}/draft-thread-composer.png`,
    });

    await emitChannelDraft(page, {
      done: true,
      part: "reply",
      pubkey: STRANGER_PUBKEY,
      seq: 2,
      text: REPLY_TEXT,
    });
    await expect(threadCard).toHaveCount(0);
  });

  test("renders above the inbox composer", async ({ page }) => {
    // The inbox is a second reading surface for the same conversations, with a
    // composer of its own: a reader who moves between threads from here saw
    // nothing at all before this mount existed.
    await page.goto("/");
    await expect(page.getByTestId("home-inbox-list")).toBeVisible();
    await page.waitForFunction(
      () =>
        typeof window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__ === "function" &&
        typeof window.__BUZZ_E2E_PUSH_MOCK_FEED_ITEM__ === "function",
    );

    const mentionId = await page.evaluate(
      ({ channelId, currentPubkey, senderPubkey }) => {
        const mention = window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
          channelName: "agents",
          content: "Mention that lands in the inbox.",
          id: "e5".repeat(32),
          mentionPubkeys: [currentPubkey],
          pubkey: senderPubkey,
        });
        if (!mention) {
          throw new Error("Mock message bridge is unavailable.");
        }
        window.__BUZZ_E2E_PUSH_MOCK_FEED_ITEM__?.({
          category: "mention",
          channel_id: channelId,
          channel_name: "agents",
          content: mention.content,
          created_at: mention.created_at,
          id: mention.id,
          kind: mention.kind,
          pubkey: mention.pubkey,
          tags: mention.tags,
        });
        return mention.id;
      },
      {
        channelId: AGENTS_CHANNEL_ID,
        currentPubkey: TEST_IDENTITIES.tyler.pubkey,
        senderPubkey: STRANGER_PUBKEY,
      },
    );

    await page.getByTestId(`home-inbox-item-${mentionId}`).click();
    await expect(page.getByTestId("home-inbox-detail")).toContainText(
      "lands in the inbox",
    );
    await page.waitForFunction(
      ({ channelName, kind }) =>
        window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
          channelName,
          kind,
        }) ?? false,
      { channelName: "agents", kind: KIND_AGENT_DRAFT_PREVIEW },
    );

    await emitChannelDraft(page, {
      part: "reply",
      pubkey: STRANGER_PUBKEY,
      seq: 1,
      text: REPLY_TEXT,
    });

    const inboxCard = page
      .getByTestId("home-inbox-detail-composer-overlay")
      .getByTestId("agent-draft-preview");
    await expect(inboxCard).toBeVisible();
    await expect(inboxCard).toHaveAttribute("data-draft-source", "channel");
    await expect(
      inboxCard.getByTestId("agent-draft-preview-text"),
    ).toContainText(REPLY_TEXT);

    await page.screenshot({
      animations: "disabled",
      path: `${SHOTS}/draft-inbox-composer.png`,
    });

    await emitChannelDraft(page, {
      done: true,
      part: "reply",
      pubkey: STRANGER_PUBKEY,
      seq: 2,
      text: REPLY_TEXT,
    });
    await expect(inboxCard).toHaveCount(0);
  });

  test("a draft from another channel never leaks into this one", async ({
    page,
  }) => {
    await startWorkingTurn(page);
    await seedObserverEvents(page, [
      chunkEvent(
        1,
        "agent_message_chunk",
        "Reply that belongs to #general.",
        "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50",
      ),
    ]);

    await expect(page.getByTestId("bot-activity-composer-trigger")).toBeVisible(
      {},
    );
    await expect(page.getByTestId("agent-draft-preview")).toHaveCount(0);
  });

  test("the working-agents popover can hide the stream and bring it back", async ({
    page,
  }) => {
    await startWorkingTurn(page);
    await seedObserverEvents(page, [
      chunkEvent(1, "agent_message_chunk", REPLY_TEXT),
    ]);
    await expect(page.getByTestId("agent-draft-preview")).toBeVisible();

    await page.getByTestId("bot-activity-composer-trigger").click();
    const hideToggle = page.getByTestId("bot-activity-toggle-draft-preview");
    await expect(hideToggle).toBeVisible();
    await expect(hideToggle).toHaveAttribute("aria-checked", "false");
    await hideToggle.click({ force: true });
    await expect(page.getByTestId("agent-draft-preview")).toHaveCount(0);

    // The switch that hid the surface is still reachable, so the reader is
    // never stranded without a way back.
    await expect(hideToggle).toHaveAttribute("aria-checked", "true");
    // There is no reasoning switch to offer: reasoning never reaches here.
    await expect(
      page.getByTestId("bot-activity-toggle-draft-thoughts"),
    ).toHaveCount(0);
    await hideToggle.click({ force: true });
    await expect(page.getByTestId("agent-draft-preview")).toBeVisible();
  });
});
