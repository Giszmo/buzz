import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentDraftPresentation } from "./agentDraftPreviewPresentation.ts";

const DRAFT = {
  turnKey: "turn-1",
  text: "Half a sent",
  thought: "weighing options",
};

test("renders the reply and shimmers a writing status", () => {
  const presentation = buildAgentDraftPresentation({
    agentName: "Carol",
    draft: DRAFT,
    previewEnabled: true,
    showThoughts: false,
  });
  assert.deepEqual(presentation, {
    text: "Half a sent",
    thought: null,
    statusLabel: "Carol is writing…",
  });
});

test("reasoning is opt-in and withheld by default", () => {
  const withoutThoughts = buildAgentDraftPresentation({
    agentName: "Carol",
    draft: DRAFT,
    previewEnabled: true,
    showThoughts: false,
  });
  assert.equal(withoutThoughts?.thought, null);

  const withThoughts = buildAgentDraftPresentation({
    agentName: "Carol",
    draft: DRAFT,
    previewEnabled: true,
    showThoughts: true,
  });
  assert.equal(withThoughts?.thought, "weighing options");
});

test("a thought-only turn renders nothing while reasoning is opt-out", () => {
  const draft = { ...DRAFT, text: "" };
  assert.equal(
    buildAgentDraftPresentation({
      agentName: "Carol",
      draft,
      previewEnabled: true,
      showThoughts: false,
    }),
    null,
  );
  assert.equal(
    buildAgentDraftPresentation({
      agentName: "Carol",
      draft,
      previewEnabled: true,
      showThoughts: true,
    })?.statusLabel,
    "Carol is thinking…",
  );
});

test("the preview switch suppresses the surface entirely", () => {
  assert.equal(
    buildAgentDraftPresentation({
      agentName: "Carol",
      draft: DRAFT,
      previewEnabled: false,
      showThoughts: true,
    }),
    null,
  );
});

test("no draft means no card", () => {
  assert.equal(
    buildAgentDraftPresentation({
      agentName: "Carol",
      draft: null,
      previewEnabled: true,
      showThoughts: true,
    }),
    null,
  );
});
