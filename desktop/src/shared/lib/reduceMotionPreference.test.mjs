import assert from "node:assert/strict";
import test from "node:test";

const values = new Map();
const attributes = new Map();
const windowListeners = new Map();

globalThis.window = {
  addEventListener: (type, listener) => windowListeners.set(type, listener),
};
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
};
globalThis.document = {
  documentElement: {
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
  },
};

const preference = await import("./reduceMotionPreference.ts");

test("only the string true enables reduced motion", () => {
  assert.equal(preference.parseReduceMotion(null), false);
  assert.equal(preference.parseReduceMotion("false"), false);
  assert.equal(preference.parseReduceMotion("1"), false);
  assert.equal(preference.parseReduceMotion("true"), true);
});

test("persists and applies the reduce motion preference", () => {
  preference.setReduceMotion(true);
  assert.equal(preference.getReduceMotion(), true);
  assert.equal(values.get(preference.REDUCE_MOTION_STORAGE_KEY), "true");
  assert.equal(attributes.get(preference.REDUCE_MOTION_ATTRIBUTE), "true");
});

test("removes the attribute rather than writing a falsy value", () => {
  preference.setReduceMotion(true);
  preference.setReduceMotion(false);
  assert.equal(preference.getReduceMotion(), false);
  assert.equal(values.get(preference.REDUCE_MOTION_STORAGE_KEY), "false");
  assert.equal(attributes.has(preference.REDUCE_MOTION_ATTRIBUTE), false);
});

test("initializes from the persisted preference", () => {
  values.set(preference.REDUCE_MOTION_STORAGE_KEY, "true");
  preference.initializeReduceMotionPreference();
  assert.equal(preference.getReduceMotion(), true);
  assert.equal(attributes.get(preference.REDUCE_MOTION_ATTRIBUTE), "true");
});

test("applies reduce motion changes from another window", () => {
  values.set(preference.REDUCE_MOTION_STORAGE_KEY, "false");
  windowListeners.get("storage")({
    key: preference.REDUCE_MOTION_STORAGE_KEY,
  });
  assert.equal(preference.getReduceMotion(), false);
  assert.equal(attributes.has(preference.REDUCE_MOTION_ATTRIBUTE), false);
});

test("returns to the default when another window clears storage", () => {
  preference.setReduceMotion(true);
  values.clear();
  windowListeners.get("storage")({ key: null });
  assert.equal(preference.getReduceMotion(), false);
  assert.equal(attributes.has(preference.REDUCE_MOTION_ATTRIBUTE), false);
});
