// JSONC editor on CodeMirror 6: highlighting with comments, line numbers, bracket matching, undo,
// Tab to indent, and the parse error marked where it happened.

import { useEffect, useRef, type CSSProperties } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { tags } from "@lezer/highlight";
import { jsonErrorOffset, stripComments } from "./generate";

/** JSON plus // and /* *\/ comments. Strings followed by ":" are property names. */
const jsonc = StreamLanguage.define<{ inBlock: boolean }>({
  name: "jsonc",
  startState: () => ({ inBlock: false }),
  token(stream, state) {
    if (state.inBlock) {
      if (stream.skipTo("*/")) {
        stream.match("*/");
        state.inBlock = false;
      } else stream.skipToEnd();
      return "blockComment";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "lineComment";
    }
    if (stream.match("/*")) {
      state.inBlock = true;
      return "blockComment";
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return stream.match(/^\s*:/, false) ? "propertyName" : "string";
    if (stream.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)) return "number";
    if (stream.match(/^(?:true|false)\b/)) return "bool";
    if (stream.match(/^null\b/)) return "null";
    if (stream.match(/^[{}[\]]/)) return "bracket";
    stream.next();
    return "punctuation";
  },
  languageData: { commentTokens: { line: "//", block: { open: "/*", close: "*/" } } },
});

const highlight = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--cm-key)" },
  { tag: tags.string, color: "var(--cm-string)" },
  { tag: tags.number, color: "var(--cm-number)" },
  { tag: [tags.bool, tags.null], color: "var(--cm-literal)" },
  { tag: [tags.lineComment, tags.blockComment], color: "var(--muted-foreground)", fontStyle: "italic" },
]);

/** The JSON.parse error, if any, marked where it happened. */
const jsoncLinter = linter(
  (view) => {
    const text = view.state.doc.toString();
    if (!text.trim()) return [];
    const stripped = stripComments(text);
    try {
      JSON.parse(stripped);
      return [];
    } catch (e) {
      const message = (e as Error).message;
      const at = jsonErrorOffset(message, stripped) ?? 0;
      const line = view.state.doc.lineAt(at);
      const diagnostic: Diagnostic = { from: at, to: Math.max(at, Math.min(at + 1, line.to)), severity: "error", message: `JSON 格式错误：${message}` };
      return [diagnostic];
    }
  },
  { delay: 300 },
);

const theme = EditorView.theme({
  "&": {
    fontSize: "12px",
    border: "1px solid var(--input)",
    borderRadius: "var(--radius-md)",
    backgroundColor: "color-mix(in oklab, var(--input) 20%, transparent)",
  },
  "&.cm-focused": { outline: "none", borderColor: "var(--ring)", boxShadow: "0 0 0 2px color-mix(in oklab, var(--ring) 30%, transparent)" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6", overflow: "auto" },
  ".cm-content": { padding: "6px 0", caretColor: "var(--foreground)" },
  ".cm-line": { padding: "0 8px 0 4px" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--muted-foreground)", opacity: "0.7" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 4px 0 8px", minWidth: "2.2em" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--muted) 60%, transparent)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in oklab, var(--ring) 30%, transparent) !important",
  },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  ".cm-matchingBracket": { backgroundColor: "color-mix(in oklab, var(--ring) 25%, transparent)", outline: "none" },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
  ".cm-tooltip": { border: "1px solid var(--border)", backgroundColor: "var(--popover)", color: "var(--popover-foreground)", borderRadius: "6px" },
  ".cm-diagnostic-error": { borderLeftColor: "var(--destructive)" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--destructive)" },
  ".cm-gutter-lint": { width: "0.9em" },
});

export function CodeEditor(props: {
  /** Id of the element that labels the editor. */
  labelledBy?: string;
  value: string;
  onChange: (v: string) => void;
  /** Height in lines: grows with the text between these, then scrolls. */
  minLines?: number;
  maxLines?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;

  useEffect(() => {
    const extensions = [
      history(),
      drawSelection(),
      highlightActiveLine(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.lineWrapping,
      theme,
      EditorView.updateListener.of((u) => u.docChanged && onChange.current(u.state.doc.toString())),
      EditorView.contentAttributes.of({
        spellcheck: "false",
        autocapitalize: "off",
        autocorrect: "off",
        ...(props.labelledBy ? { "aria-labelledby": props.labelledBy } : {}),
      }),
      EditorState.tabSize.of(2),
      lineNumbers(),
      jsonc,
      syntaxHighlighting(highlight),
      bracketMatching(),
      indentOnInput(),
      lintGutter(),
      jsoncLinter,
    ];
    view.current = new EditorView({ parent: host.current!, state: EditorState.create({ doc: props.value, extensions }) });
    return () => view.current?.destroy();
    // Created once; outside changes to the value are synced by the effect below.
  }, []);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== props.value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.value } });
  }, [props.value]);

  const lineHeight = 19.2;
  const style = {
    "--cm-min": `${(props.minLines ?? 3) * lineHeight + 14}px`,
    "--cm-max": `${(props.maxLines ?? 24) * lineHeight + 14}px`,
  } as CSSProperties;
  return <div ref={host} className="code-editor" style={style} />;
}
