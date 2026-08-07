import { describe, expect, it } from "vitest";
import { excerptComment, formatPrompt } from "./format";
import type { Review } from "./types";

function review(comments: Review["comments"]): Review {
  return {
    id: "r1",
    createdAt: 0,
    lastActivityAt: 0,
    archivedAt: null,
    comments,
  };
}

describe("formatPrompt", () => {
  it("formats a single-line comment as path:line + text, no trailing separator", () => {
    const r = review([
      {
        id: "1",
        path: "src/foo/bar.py",
        startLine: 42,
        endLine: 42,
        text: "this copies the list for nothing",
      },
    ]);
    expect(formatPrompt(r)).toBe(
      "src/foo/bar.py:42\nthis copies the list for nothing",
    );
  });

  it("formats a range as path:start-end", () => {
    const r = review([
      {
        id: "1",
        path: "src/services/sync.py",
        startLine: 88,
        endLine: 91,
        text: "extract this into a helper",
      },
    ]);
    expect(formatPrompt(r)).toBe(
      "src/services/sync.py:88-91\nextract this into a helper",
    );
  });

  it("appends @shortsha when present", () => {
    const r = review([
      {
        id: "1",
        path: "src/foo/bar.py",
        startLine: 42,
        endLine: 42,
        shortSha: "abc1234",
        text: "this copies the list for nothing",
      },
    ]);
    expect(formatPrompt(r)).toBe(
      "src/foo/bar.py:42@abc1234\nthis copies the list for nothing",
    );
  });

  it("joins multiple comments with a lone --- separator line, matching the spec example exactly", () => {
    const r = review([
      {
        id: "1",
        path: "src/foo/bar.py",
        startLine: 42,
        endLine: 42,
        shortSha: "abc1234",
        text: "this copies the list for nothing",
      },
      {
        id: "2",
        path: "src/services/sync.py",
        startLine: 88,
        endLine: 91,
        text: "extract this into a helper",
      },
    ]);
    expect(formatPrompt(r)).toBe(
      "src/foo/bar.py:42@abc1234\n" +
        "this copies the list for nothing\n" +
        "---\n" +
        "src/services/sync.py:88-91\n" +
        "extract this into a helper",
    );
  });
});

describe("excerptComment", () => {
  it("returns the first line unchanged when short", () => {
    expect(excerptComment("short note")).toBe("short note");
  });

  it("truncates long text with an ellipsis", () => {
    const text = "a".repeat(60);
    const result = excerptComment(text, 40);
    expect(result).toBe(`${"a".repeat(40)}…`);
  });

  it("only considers the first line of multi-line text", () => {
    expect(excerptComment("first line\nsecond line")).toBe("first line");
  });
});
