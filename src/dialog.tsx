// In-page replacements for prompt/confirm/alert, built on shadcn's AlertDialog and Dialog. Embedded
// browsers (e.g. app web views) may not support the native ones: prompt() throws "not supported".

import { useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
  const node = request ? <DialogView key={Date.now()} request={request} done={() => setRequest(null)} /> : null;
  return [dialogs, node];
}

function DialogView(props: { request: Request; done: () => void }) {
  const r = props.request;
  const [text, setText] = useState(r.kind === "text" ? r.initial : "");
  const settle = (ok: boolean) => {
    if (r.kind === "text") r.resolve(ok ? text.trim() || null : null);
    else if (r.kind === "confirm") r.resolve(ok);
    else r.resolve();
    props.done();
  };

  if (r.kind === "text") {
    return (
      <Dialog open onOpenChange={(open) => !open && settle(false)}>
        <DialogContent className="sm:max-w-md">
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) settle(true);
            }}
          >
            <DialogHeader>
              <DialogTitle>{r.title}</DialogTitle>
              {r.message && <DialogDescription>{r.message}</DialogDescription>}
            </DialogHeader>
            <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} onFocus={(e) => e.target.select()} spellCheck={false} aria-label={r.title} />
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
              <Button type="submit" disabled={!text.trim()}>
                {r.confirmLabel}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && settle(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{r.title}</AlertDialogTitle>
          {r.message && <AlertDialogDescription className="max-h-[50vh] overflow-y-auto whitespace-pre-line">{r.message}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          {r.kind === "confirm" && <AlertDialogCancel onClick={() => settle(false)}>取消</AlertDialogCancel>}
          <AlertDialogAction variant={r.kind === "confirm" && r.danger ? "destructive" : "default"} onClick={() => settle(true)}>
            {r.kind === "alert" ? "知道了" : r.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
