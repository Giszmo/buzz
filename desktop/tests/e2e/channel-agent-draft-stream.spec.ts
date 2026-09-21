import { expect, test, type Page } from "@playwright/test";

import { KIND_TYPING_INDICATOR } from "../../src/shared/constants/kinds";
import { TEST_IDENTITIES, installMockBridge } from "../helpers/bridge";

const AGENTS_CHANNEL_ID = "94a444a4-c0a3-5966-ab05-530c6ddc2301";
const AGENT_PUBKEY = TEST_IDENTITIES.alice.pubkey;
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

  test("streams the forming reply and keeps thoughts opt-in", async ({
    page,
  }) => {
    await startWorkingTurn(page);

    // A turn that has only reasoned so far renders nothing: reasoning is
    // opt-in, and an empty card would claim the agent is writing.
    await seedObserverEvents(page, [
      chunkEvent(1, "agent_thought_chunk", THOUGHT_TEXT),
    ]);
    await expect(page.getByTestId("agent-draft-preview")).toHaveCount(0);

    await seedObserverEvents(page, [
      chunkEvent(2, "agent_message_chunk", REPLY_TEXT),
    ]);

    const card = page.getByTestId("agent-draft-preview");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("agent-draft-preview-status")).toContainText(
      "is writing",
    );
    await expect(card.getByTestId("agent-draft-preview-text")).toContainText(
      REPLY_TEXT,
    );
    // Thoughts stay off until asked for, even though the chunks arrived.
    await expect(card.getByTestId("agent-draft-preview-thought")).toHaveCount(
      0,
    );
    await expect(card).not.toContainText(THOUGHT_TEXT);

    await page.screenshot({
      path: `${SHOTS}/draft-reply-only.png`,
    });

    const thoughtsToggle = card.getByTestId(
      "agent-draft-preview-toggle-thoughts",
    );
    await expect(thoughtsToggle).toHaveAttribute("aria-pressed", "false");
    await thoughtsToggle.click();
    await expect(thoughtsToggle).toHaveAttribute("aria-pressed", "true");
    await expect(card.getByTestId("agent-draft-preview-thought")).toContainText(
      THOUGHT_TEXT,
    );

    await page.screenshot({
      path: `${SHOTS}/draft-reply-with-thoughts.png`,
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

  test("the working-agents popover can switch the stream off and back on", async ({
    page,
  }) => {
    await startWorkingTurn(page);
    await seedObserverEvents(page, [
      chunkEvent(1, "agent_message_chunk", REPLY_TEXT),
    ]);
    await expect(page.getByTestId("agent-draft-preview")).toBeVisible();

    await page.getByTestId("bot-activity-composer-trigger").click();
    const previewToggle = page.getByTestId("bot-activity-toggle-draft-preview");
    await expect(previewToggle).toBeVisible();
    await expect(previewToggle).toHaveAttribute("aria-checked", "true");
    await previewToggle.click({ force: true });
    await expect(page.getByTestId("agent-draft-preview")).toHaveCount(0);

    // The switch that hid the surface is still reachable, so the reader is
    // never stranded without a way back.
    await expect(previewToggle).toHaveAttribute("aria-checked", "false");
    await expect(
      page.getByTestId("bot-activity-toggle-draft-thoughts"),
    ).toBeDisabled();
    await previewToggle.click({ force: true });
    await expect(page.getByTestId("agent-draft-preview")).toBeVisible();
  });
});
