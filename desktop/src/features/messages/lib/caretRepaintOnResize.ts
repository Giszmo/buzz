import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

/**
 * Re-applies the caret after the editor changes size.
 *
 * The composer is anchored to the bottom, so a new line grows it upward and
 * moves the text under the caret. WebKitGTK keeps painting the caret at its
 * cached position from before the move: Shift+Enter twice in quick
 * succession leaves a steady second caret on the line above the real one
 * until the next keystroke. Repainting does not clear it; handing WebKit the
 * same selection again does, because that recomputes the caret rect.
 */
export const CaretRepaintOnResize = Extension.create({
  name: "caretRepaintOnResize",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        view(view) {
          if (typeof ResizeObserver === "undefined") return {};
          const observer = new ResizeObserver(() => {
            if (view.composing || !view.hasFocus()) return;
            const selection = view.dom.ownerDocument.getSelection();
            if (!selection?.isCollapsed || selection.rangeCount === 0) return;
            const range = selection.getRangeAt(0).cloneRange();
            if (!view.dom.contains(range.startContainer)) return;
            selection.removeAllRanges();
            selection.addRange(range);
          });
          observer.observe(view.dom);
          return { destroy: () => observer.disconnect() };
        },
      }),
    ];
  },
});
