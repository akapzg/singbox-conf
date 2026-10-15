// Reordering a list by dragging a handle, or by focusing it and pressing ↑/↓.
//
// Pointer events are followed on the window rather than captured on the handle: React moves DOM
// nodes when the order changes, and moving the captured element drops the capture, which used to
// end the drag after one step.

import { useEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type PointerEvent } from "react";

/** `ids` with `id` moved right before `beforeId`, or to the end when it is null. */
export function moveBefore(ids: string[], id: string, beforeId: string | null): string[] {
  const next = ids.filter((x) => x !== id);
  const at = beforeId === null ? next.length : next.indexOf(beforeId);
  next.splice(at < 0 ? next.length : at, 0, id);
  return next;
}

export function useDragSort(ids: string[], onReorder: (ids: string[]) => void) {
  const [dragging, setDragging] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  // Window listeners outlive a render; they read the latest list and callback from here.
  const latest = useRef({ ids, onReorder });
  latest.current = { ids, onReorder };

  const place = (id: string, beforeId: string | null) => {
    const { ids, onReorder } = latest.current;
    const next = moveBefore(ids, id, beforeId);
    if (next.join() !== ids.join()) onReorder(next);
  };

  // Unmounting mid-drag (e.g. switching tabs) must not leave listeners behind.
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  /** Follow the pointer until release. Listeners go on synchronously so a fast drag isn't missed. */
  const start = (id: string) => {
    /** The first other row whose middle is below the pointer: the dragged row goes before it. */
    const onMove = (e: globalThis.PointerEvent) => {
      let before: string | null = null;
      for (const other of latest.current.ids) {
        if (other === id) continue;
        const r = rows.current.get(other)?.getBoundingClientRect();
        if (r && e.clientY < r.top + r.height / 2) {
          before = other;
          break;
        }
      }
      place(id, before);
    };
    const body = document.body.style;
    const saved = [body.userSelect, body.cursor];
    const stop = () => {
      [body.userSelect, body.cursor] = saved;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      cleanup.current = null;
      setDragging(null);
    };
    body.userSelect = "none";
    body.cursor = "grabbing";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    cleanup.current = stop;
    setDragging(id);
  };
  return {
    dragging,
    /** Ref callback for the row element of `id`. */
    rowRef: (id: string) => (el: HTMLElement | null) => {
      if (el) rows.current.set(id, el);
      else rows.current.delete(id);
    },
    /** Props for the drag handle button of `id`. */
    handleProps: (id: string): HTMLAttributes<HTMLButtonElement> => ({
      onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        start(id);
      },
      onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        const list = latest.current.ids;
        const i = list.indexOf(id);
        if (e.key === "ArrowUp" && i > 0) place(id, list[i - 1]);
        if (e.key === "ArrowDown" && i < list.length - 1) place(id, list[i + 2] ?? null);
        // Keep focus on the handle as the row moves.
        const handle = e.currentTarget;
        requestAnimationFrame(() => handle.focus());
      },
    }),
  };
}
