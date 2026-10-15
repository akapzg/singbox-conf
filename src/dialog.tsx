// In-page replacements for prompt/confirm/alert. Embedded browsers (e.g. app web views) may not
// support the native ones at all: prompt() throws "not supported" in some of them.

import { useEffect, useRef, useState, type ReactNode } from "react";

type Request =
  | { kind: "text"; title: string; message?: string; initial: string; confirmLabel: string; resolve: (v: string | null) => void }
  | { kind: "confirm"; title: string; message?: string; confirmLabel: string; danger: boolean; resolve: (v: boolean) => void }
  | { kind: "alert"; title: string; message?: string; resolve: () => void };

export interface Dialogs {
  /** Ask for a short text; null when cancelled or left empty. */
  askText(title: string, initial: string, options?: { message?: string; confirmLabel?: string }): Promise<string | null>;
  confirm(title: string, options?: { message?: string; confirmLabel?: string; danger?: boolean }): Promise<boolean>;
  alert(title: string, message?: string): Promise<void>;
}

export function useDialogs(): [Dialogs, ReactNode] {
  const [request, setRequest] = useState<Request | null>(null);
  const dialogs: Dialogs = {
    askText: (title, initial, o = {}) =>
      new Promise((resolve) =>
        setRequest({ kind: "text", title, initial, message: o.message, confirmLabel: o.confirmLabel ?? "确定", resolve }),
      ),
    confirm: (title, o = {}) =>
      new Promise((resolve) =>
        setRequest({ kind: "confirm", title, message: o.message, confirmLabel: o.confirmLabel ?? "确定", danger: !!o.danger, resolve }),
      ),
    alert: (title, message) => new Promise((resolve) => setRequest({ kind: "alert", title, message, resolve })),
  };
  const node = request ? <DialogView request={request} done={() => setRequest(null)} /> : null;
  return [dialogs, node];
}

function DialogView(props: { request: Request; done: () => void }) {
  const r = props.request;
  const [text, setText] = useState(r.kind === "text" ? r.initial : "");
  const inputRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  const cancel = () => {
    if (r.kind === "text") r.resolve(null);
    else if (r.kind === "confirm") r.resolve(false);
    else r.resolve();
    props.done();
  };
  const ok = () => {
    if (r.kind === "text") r.resolve(text.trim() || null);
    else if (r.kind === "confirm") r.resolve(true);
    else r.resolve();
    props.done();
  };

  useEffect(() => {
    if (r.kind === "text") {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      okRef.current?.focus();
    }
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && cancel();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onSubmit={(e) => {
          e.preventDefault();
          ok();
        }}
      >
        <h3 id="dialog-title">{r.title}</h3>
        {r.message && <p className="dialog-message">{r.message}</p>}
        {r.kind === "text" && (
          <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label={r.title} />
        )}
        <div className="dialog-actions">
          {r.kind !== "alert" && (
            <button type="button" className="ghost" onClick={cancel}>
              取消
            </button>
          )}
          <button
            ref={okRef}
            type="submit"
            className={r.kind === "confirm" && r.danger ? "primary danger-fill" : "primary"}
            disabled={r.kind === "text" && !text.trim()}
          >
            {r.kind === "alert" ? "知道了" : r.confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
