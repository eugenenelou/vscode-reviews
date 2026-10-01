import { describe, expect, it } from "vitest";
import {
  commitProgress,
  commitReviewState,
  fileKey,
  groupByTier,
  latestGuideFor,
  matchGuideCommits,
  parseGuide,
  type GuideCommit,
} from "./guide";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

function rawGuide(overrides: Record<string, unknown> = {}) {
  return {
    branch: "eugene/foo",
    base: SHA_C,
    createdAt: 1000,
    commits: [
      {
        sha: SHA_A,
        patchId: "p1",
        subject: "feat: add x",
        summary: "adds x",
        files: [
          { path: "src/b.ts", tier: "skim", reason: "test" },
          {
            path: "src/a.ts",
            tier: "critical",
            reason: "core",
            notes: [{ startLine: 3, text: "check this" }],
          },
        ],
      },
    ],
    ...overrides,
  };
}

function commit(overrides: Partial<GuideCommit> = {}): GuideCommit {
  return {
    sha: SHA_A,
    patchId: "p1",
    subject: "s",
    summary: "",
    flags: [],
    files: [],
    ...overrides,
  };
}

describe("parseGuide", () => {
  it("parses a guide, defaulting flags, notes and a note's endLine", () => {
    const guide = parseGuide("g1", rawGuide());
    expect(guide.id).toBe("g1");
    expect(guide.commits[0]?.flags).toEqual([]);
    expect(guide.commits[0]?.files[0]?.notes).toEqual([]);
    expect(guide.commits[0]?.files[1]?.notes).toEqual([
      { startLine: 3, endLine: 3, text: "check this" },
    ]);
  });

  it("names the offending field", () => {
    const bad = rawGuide();
    (bad.commits[0]!.files[0] as { tier: string }).tier = "urgent";
    expect(() => parseGuide("g1", bad)).toThrow(
      "guide.commits[0].files[0].tier: expected one of critical, review, skim, skip",
    );
  });

  it("rejects a note range ending before it starts", () => {
    const bad = rawGuide();
    (bad.commits[0]!.files[1] as { notes: unknown[] }).notes = [
      { startLine: 5, endLine: 2, text: "x" },
    ];
    expect(() => parseGuide("g1", bad)).toThrow("endLine is before startLine");
  });
});

describe("latestGuideFor", () => {
  it("picks the newest guide of the branch", () => {
    const old = parseGuide("old", rawGuide({ createdAt: 1 }));
    const recent = parseGuide("new", rawGuide({ createdAt: 2 }));
    const other = parseGuide("other", rawGuide({ branch: "x", createdAt: 3 }));
    expect(latestGuideFor([old, recent, other], "eugene/foo")).toBe(recent);
    expect(latestGuideFor([old], "nope")).toBeUndefined();
  });
});

describe("groupByTier", () => {
  it("orders tiers by importance, drops empty ones, keeps reading order", () => {
    const files = [
      { path: "1", tier: "skim", reason: "", notes: [] },
      { path: "2", tier: "critical", reason: "", notes: [] },
      { path: "3", tier: "skim", reason: "", notes: [] },
    ] as const;
    expect(
      groupByTier(commit({ files: [...files] })).map((g) => [
        g.tier,
        g.files.map((f) => f.path),
      ]),
    ).toEqual([
      ["critical", ["2"]],
      ["skim", ["1", "3"]],
    ]);
  });
});

describe("matchGuideCommits", () => {
  it("matches by sha, then by patch-id after a rewrite, else stale", () => {
    const same = commit({ sha: SHA_A, patchId: "p1" });
    const rebased = commit({ sha: "old", patchId: "p2" });
    const gone = commit({ sha: "gone", patchId: "p3" });
    const matches = matchGuideCommits(
      [same, rebased, gone],
      [
        { patchId: "p1", sha: SHA_A },
        { patchId: "p2", sha: SHA_B },
      ],
    );
    expect(matches.get(same)).toBe(SHA_A);
    expect(matches.get(rebased)).toBe(SHA_B);
    expect(matches.get(gone)).toBeUndefined();
  });
});

describe("commitReviewState", () => {
  const ordered = [SHA_A, SHA_B, SHA_C];

  it("marks commits up to the cursor reviewed, the cursor itself distinctly", () => {
    expect(commitReviewState(SHA_A, ordered, SHA_B)).toBe("reviewed");
    expect(commitReviewState(SHA_B, ordered, SHA_B)).toBe("cursor");
    expect(commitReviewState(SHA_C, ordered, SHA_B)).toBe("unreviewed");
  });

  it("marks nothing reviewed without a cursor in the history", () => {
    expect(commitReviewState(SHA_A, ordered, undefined)).toBe("unreviewed");
    expect(commitReviewState(SHA_A, ordered, "elsewhere")).toBe("unreviewed");
  });
});

describe("commitProgress", () => {
  it("counts checked files by patch-id key", () => {
    const c = commit({
      files: [
        { path: "a", tier: "review", reason: "", notes: [] },
        { path: "b", tier: "review", reason: "", notes: [] },
      ],
    });
    const checked = new Set([fileKey(c, c.files[0]!)]);
    expect(commitProgress(c, checked)).toEqual({ done: 1, total: 2 });
    expect(fileKey(c, c.files[0]!)).toBe("p1:a");
  });
});
