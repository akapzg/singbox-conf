import { describe, expect, it } from "vitest";
import { changedLines } from "../src/diff";

const lines = (n: number, prefix = "l") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe("changedLines", () => {
  it("is empty for identical text", () => {
    expect(changedLines("a\nb", "a\nb")).toEqual([]);
  });

  it("finds an edited line", () => {
    expect(changedLines("a\nb\nc", "a\nB\nc")).toEqual([{ start: 1, end: 1 }]);
  });

  it("finds inserted lines", () => {
    expect(changedLines("a\nd", "a\nb\nc\nd")).toEqual([{ start: 1, end: 2 }]);
  });

  it("reports a deletion as the position it happened at", () => {
    expect(changedLines("a\nb\nc", "a\nc")).toEqual([{ start: 1, end: 1, deleted: true }]);
    expect(changedLines("a\nb", "a")).toEqual([{ start: 1, end: 1, deleted: true }]);
    expect(changedLines("a\nb\nc\nd", "a\nd")).toEqual([{ start: 1, end: 1, deleted: true }]);
  });

  it("puts a removed object's deletion before the next object, not inside it", () => {
    const obj = (x: string) => `{\n  "${x}"\n},`;
    expect(changedLines(`[\n${obj("a")}\n${obj("b")}\n]`, `[\n${obj("b")}\n]`)).toEqual([{ start: 1, end: 1, deleted: true }]);
    // The same for an inserted object: its own lines are shaded, not the next object's "{".
    expect(changedLines(`[\n${obj("b")}\n]`, `[\n${obj("a")}\n${obj("b")}\n]`)).toEqual([{ start: 1, end: 3 }]);
  });

  it("shows a replacement as changed lines only", () => {
    expect(changedLines("a\nb\nc\nd", "a\nX\nd")).toEqual([{ start: 1, end: 1 }]);
  });

  it("reports two separate changes as two ranges", () => {
    const old = lines(40).join("\n");
    const next = lines(40);
    next[5] = "x";
    next.splice(30, 0, "y", "z");
    expect(changedLines(old, next.join("\n"))).toEqual([
      { start: 5, end: 5 },
      { start: 30, end: 31 },
    ]);
  });

  it("falls back to one range when the middle is huge", () => {
    const old = lines(2000, "a").join("\n");
    const next = lines(2000, "b").join("\n");
    expect(changedLines(old, next)).toEqual([{ start: 0, end: 1999 }]);
  });
});
