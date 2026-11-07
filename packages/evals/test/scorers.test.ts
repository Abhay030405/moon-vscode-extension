import { describe, expect, it } from "vitest";
import { ranksOf, recallAt, scoreRetrieval } from "../scorers";

describe("retrieval scoring", () => {
  it("counts found, missed and extra files (paths compared as src/x.py)", () => {
    const score = scoreRetrieval(["./src/a.py", "docs\\a.rst", "other.py"], ["src/a.py", "tests/test_a.py"], ["docs/a.rst"]);
    expect(score).toEqual({ found: ["src/a.py"], missed: ["tests/test_a.py"], extra: ["other.py"], recall: 0.5, pass: false });
  });

  it("map ranks and recall@k", () => {
    const ranks = ranksOf(["x.py", "src/a.py", "y.py"], ["src/a.py", "gone.py"]);
    expect(ranks).toEqual({ "src/a.py": 2, "gone.py": undefined });
    expect(recallAt(ranks, 1)).toBe(0);
    expect(recallAt(ranks, 5)).toBe(0.5);
  });
});
