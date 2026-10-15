import { describe, expect, it } from "vitest";
import { moveBefore } from "../src/drag-sort";

describe("moveBefore", () => {
  const ids = ["a", "b", "c", "d"];
  it("moves to any position, not only the neighbours", () => {
    expect(moveBefore(ids, "d", "a")).toEqual(["d", "a", "b", "c"]);
    expect(moveBefore(ids, "a", null)).toEqual(["b", "c", "d", "a"]);
    expect(moveBefore(ids, "b", "d")).toEqual(["a", "c", "b", "d"]);
  });
  it("leaves the list alone when the item stays put", () => {
    expect(moveBefore(ids, "b", "c")).toEqual(ids);
    expect(moveBefore(ids, "d", null)).toEqual(ids);
  });
});
