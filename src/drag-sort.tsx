// Reordering a list by dragging a handle, or by focusing it and pressing ↑/↓.
//
// The dragged row follows the pointer, the others slide out of its way (FLIP: measure, reorder,
// then animate each row from its old place), and on release it settles into its slot. Near the
// top or bottom of the window the page scrolls.
//
// Pointer events are followed on the window rather than captured on the handle: React moves DOM
// nodes when the order changes, and moving the captured element drops the capture.

import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type PointerEvent } from "react";

/** `ids` with `id` moved right before `beforeId`, or to the end when it is null. */
export function moveBefore(ids: string[], id: string, beforeId: string | null): string[] {
  const next = ids.filter((x) => x !== id);
  const at = beforeId === null ? next.length : next.indexOf(beforeId);
  next.splice(at < 0 ? next.length : at, 0, id);
  return next;
}

const SLIDE = "transform 180ms cubic-bezier(0.2, 0, 0, 1)";
/** Distance from the window edge where dragging scrolls the page, and the header it sits under. */
const EDGE = 56;
const HEADER = 64;

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The nearest ancestor that scrolls vertically, if any. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if ((overflowY === "auto" || overflowY === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** Where the element sits in the layout, ignoring any transform it is animating with. */
function layoutTop(el: HTMLElement): number {
  const shift = new DOMMatrixReadOnly(getComputedStyle(el).transform).m42;
  return el.getBoundingClientRect().top - shift;
}

interface Drag {
  id: string;
  /** Pointer distance from the row's top when grabbed. */
  grab: number;
  pointerY: number;
}

export function useDragSort(ids: string[], onReorder: (ids: string[]) => void) {
  const [dragging, setDragging] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  // Window listeners outlive a render; they read the latest list and callback from here.
  const latest = useRef({ ids, onReorder });
  latest.current = { ids, onReorder };
  const drag = useRef<Drag | null>(null);
  /** Row positions on screen just before the last reorder, for the slide animation. */
  const before = useRef<Map<string, number> | null>(null);

  /** Keep the dragged row under the pointer, wherever its slot is now. */
  const follow = () => {
    const d = drag.current;
    const el = d && rows.current.get(d.id);
    if (!d || !el) return;
    el.style.transition = "none";
    el.style.transform = `translateY(${d.pointerY - d.grab - layoutTop(el)}px)`;
  };

  const place = (id: string, beforeId: string | null) => {
    const { ids, onReorder } = latest.current;
    const next = moveBefore(ids, id, beforeId);
    if (next.join() === ids.join()) return;
    before.current = new Map([...rows.current].map(([k, el]) => [k, el.getBoundingClientRect().top]));
    onReorder(next);
  };

  // After a reorder, start every row (except the one being dragged) from where it was on screen
  // and let it slide to its new slot.
  useLayoutEffect(() => {
    const old = before.current;
    before.current = null;
    if (old) {
      const animate = !reducedMotion();
      for (const [id, el] of rows.current) {
        if (id === drag.current?.id) continue;
        const from = old.get(id);
        if (from === undefined) continue;
        el.style.transition = "none";
        el.style.transform = "";
        const delta = from - el.getBoundingClientRect().top;
        if (!delta || !animate) continue;
        el.style.transform = `translateY(${delta}px)`;
        void el.offsetHeight;
        el.style.transition = SLIDE;
        el.style.transform = "";
      }
    }
    follow();
  }, [ids.join()]);

  // Unmounting mid-drag (e.g. switching tabs) must not leave listeners behind.
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  /** Follow the pointer until release. Listeners go on synchronously so a fast drag isn't missed. */
  const start = (id: string, pointerY: number) => {
    const row = rows.current.get(id);
    if (!row) return;
    drag.current = { id, grab: pointerY - layoutTop(row), pointerY };
    // A list with its own scrollbar (e.g. group members) scrolls at its edges, the page at the window's.
    const scroller = scrollParent(row);

    /** Put the dragged row before the first other row whose middle is below the pointer. */
    const reposition = () => {
      const y = drag.current!.pointerY;
      let target: string | null = null;
      for (const other of latest.current.ids) {
        if (other === id) continue;
        const el = rows.current.get(other);
        if (!el) continue;
        if (y < layoutTop(el) + el.offsetHeight / 2) {
          target = other;
          break;
        }
      }
      place(id, target);
      follow();
    };
    const onMove = (e: globalThis.PointerEvent) => {
      drag.current!.pointerY = e.clientY;
      reposition();
    };
    // Scroll while the pointer rests near an edge; the rows move under it, so reposition too.
    let frame = requestAnimationFrame(function tick() {
      const y = drag.current!.pointerY;
      let moved = false;
      if (scroller) {
        const r = scroller.getBoundingClientRect();
        const inner = y < r.top + EDGE / 2 ? -(r.top + EDGE / 2 - y) : y > r.bottom - EDGE / 2 ? EDGE / 2 - (r.bottom - y) : 0;
        if (inner) {
          const before = scroller.scrollTop;
          scroller.scrollBy(0, Math.round(inner / 3));
          moved = scroller.scrollTop !== before;
        }
      }
      if (!moved) {
        const speed = y < HEADER + EDGE ? -(HEADER + EDGE - y) : y > innerHeight - EDGE ? EDGE - (innerHeight - y) : 0;
        if (speed) {
          window.scrollBy(0, Math.round(speed / 4));
          moved = true;
        }
      }
      if (moved) reposition();
      frame = requestAnimationFrame(tick);
    });

    const body = document.body.style;
    const saved = [body.userSelect, body.cursor];
    const stop = () => {
      cancelAnimationFrame(frame);
      [body.userSelect, body.cursor] = saved;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      cleanup.current = null;
      drag.current = null;
      // Settle into the slot.
      const el = rows.current.get(id);
      if (el) {
        el.style.transition = reducedMotion() ? "none" : SLIDE;
        el.style.transform = "";
      }
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
        start(id, e.clientY);
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
