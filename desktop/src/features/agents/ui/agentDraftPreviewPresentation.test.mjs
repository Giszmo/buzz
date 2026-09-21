import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentDraftPresentation } from "./agentDraftPreviewPresentation.ts";

const DRAFT = {
  turnKey: "turn-1",
  text: "Half a sent",
};

test("renders the reply and shimmers a writing status", () => {
  const presentation = buildAgentDraftPresentation({
    agentName: "Carol",
    draft: DRAFT,
    previewEnabled: true,
  });
  assert.deepEqual(presentation, {
    text: "Half a sent",
    statusLabel: "Carol is writing…",
  });
});

test("a draft with no reply text renders nothing", () => {
  assert.equal(
    buildAgentDraftPresentation({
      agentName: "Carol",
      draft: { ...DRAFT, text: "" },
      previewEnabled: true,
    }),
    null,
  );
});

test("the preview switch suppresses the surface entirely", () => {
  assert.equal(
    buildAgentDraftPresentation({
      agentName: "Carol",
      draft: DRAFT,
      previewEnabled: false,
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
    }),
    null,
  );
});
