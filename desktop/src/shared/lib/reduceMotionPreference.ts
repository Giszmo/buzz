import * as React from "react";

/**
 * Device-level override that forces the app's reduced-motion behaviour on
 * without changing the OS accessibility setting.
 *
 * The OS preference still wins on its own — this only ever adds reduction,
 * never removes it, so a user who has reduced motion on system-wide cannot
 * accidentally turn the app's animations back on here.
 */
export const REDUCE_MOTION_STORAGE_KEY = "buzz.appearance.reduceMotion";
export const REDUCE_MOTION_ATTRIBUTE = "data-reduce-motion";
export const DEFAULT_REDUCE_MOTION = false;

const listeners = new Set<() => void>();
let reduceMotion: boolean = DEFAULT_REDUCE_MOTION;
let listeningForStorageChanges = false;

export function parseReduceMotion(value: string | null | undefined): boolean {
  return value === "true";
}

function readStoredReduceMotion(): boolean {
  try {
    return parseReduceMotion(
      globalThis.localStorage?.getItem(REDUCE_MOTION_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_REDUCE_MOTION;
  }
}

function applyReduceMotion(enabled: boolean): void {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  if (enabled) {
    root.setAttribute(REDUCE_MOTION_ATTRIBUTE, "true");
  } else {
    root.removeAttribute(REDUCE_MOTION_ATTRIBUTE);
  }
}

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

function applyStoredReduceMotion(): void {
  const nextReduceMotion = readStoredReduceMotion();
  const changed = nextReduceMotion !== reduceMotion;
  reduceMotion = nextReduceMotion;
  applyReduceMotion(nextReduceMotion);
  if (changed) notifyListeners();
}

function listenForStorageChanges(): void {
  if (listeningForStorageChanges || !globalThis.window?.addEventListener)
    return;
  globalThis.window.addEventListener("storage", (event) => {
    if (event.key === REDUCE_MOTION_STORAGE_KEY || event.key === null) {
      applyStoredReduceMotion();
    }
  });
  listeningForStorageChanges = true;
}

/** Apply the persisted preference before React renders to avoid a first-frame animation. */
export function initializeReduceMotionPreference(): void {
  applyStoredReduceMotion();
  listenForStorageChanges();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getReduceMotion(): boolean {
  return reduceMotion;
}

export function setReduceMotion(enabled: boolean): void {
  reduceMotion = enabled;
  applyReduceMotion(enabled);
  try {
    globalThis.localStorage?.setItem(
      REDUCE_MOTION_STORAGE_KEY,
      String(enabled),
    );
  } catch {
    // Persistence is best-effort; the live preference still applies.
  }
  notifyListeners();
}

export function useReduceMotion(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    getReduceMotion,
    () => DEFAULT_REDUCE_MOTION,
  );
}
