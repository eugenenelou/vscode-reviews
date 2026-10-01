import { describe, expect, it } from "vitest";
import {
  commitProgress,
  commitReviewState,
  fileKey,
  entryFiles,
  filesToRead,
  groupFiles,
  latestGuideFor,
  matchGuideCommits,
  parseGuide,
  type GuideCommit,
  type GuideEntry,
  type GuideFile,
  type Tier,
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
    topics: {},
    tiers: {},
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

  it("parses topics and group descriptions, rejecting an unknown tier key", () => {
    const raw = rawGuide();
    const c = raw.commits[0] as Record<string, unknown>;
    c.topics = { auth: "check the refresh path" };
    c.tiers = { skim: "" };
    (c.files as Record<string, unknown>[])[0]!.topic = "auth";
    const parsed = parseGuide("g1", raw).commits[0]!;
    expect(parsed.topics).toEqual({ auth: "check the refresh path" });
    expect(parsed.tiers).toEqual({ skim: "" });
    expect(parsed.files[0]?.topic).toBe("auth");
    expect(parsed.files[1]?.topic).toBeUndefined();
    c.tiers = { urgent: "x" };
    expect(() => parseGuide("g1", raw)).toThrow(
      "guide.commits[0].tiers.urgent",
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

function file(path: string, tier: Tier, topic?: string): GuideFile {
  return { path, tier, reason: "", notes: [], ...(topic ? { topic } : {}) };
}

/** Compact shape: a group as `[key, description, children]`, a file as its path. */
function shape(entries: GuideEntry[]): unknown[] {
  return entries.map((e) =>
    e.kind === "file" ? e.file.path : [e.key, e.description, shape(e.children)],
  );
}

describe("groupFiles", () => {
  const files = [
    file("api", "review", "auth"),
    file("model", "critical", "auth"),
    file("lock", "skip"),
    file("docs", "skim", "docs"),
  ];

  it("nests tiers then topics, tiers by importance, topics in reading order with untopiced last", () => {
    const c = commit({ files, tiers: { critical: "check the invariant" } });
    expect(shape(groupFiles(c, "tierThenTopic"))).toEqual([
      ["critical", "check the invariant", ["model"]],
      ["review", "", ["api"]],
      ["skim", "", ["docs"]],
      ["skip", "", ["lock"]],
    ]);
  });

  it("nests topics then tiers, with topic descriptions", () => {
    const c = commit({ files, topics: { auth: "token refresh" } });
    expect(shape(groupFiles(c, "topicThenTier"))).toEqual([
      [
        "auth",
        "token refresh",
        [
          ["critical", "", ["model"]],
          ["review", "", ["api"]],
        ],
      ],
      ["docs", "", [["skim", "", ["docs"]]]],
      ["", "", [["skip", "", ["lock"]]]],
    ]);
  });

  it("leaves out topics when the commit has a single one", () => {
    const c = commit({ files: [file("a", "review"), file("b", "skim")] });
    expect(shape(groupFiles(c, "topicThenTier"))).toEqual([
      ["review", "", ["a"]],
      ["skim", "", ["b"]],
    ]);
  });

  it("keeps a single tier", () => {
    const flat = commit({ files: [file("a", "review"), file("b", "review")] });
    expect(shape(groupFiles(flat, "tierThenTopic"))).toEqual([
      ["review", "", ["a", "b"]],
    ]);
  });
});

describe("entryFiles", () => {
  it("flattens groups in display order", () => {
    const c = commit({
      files: [
        file("api", "review", "auth"),
        file("docs", "skim", "docs"),
        file("model", "critical", "auth"),
      ],
    });
    expect(
      entryFiles(groupFiles(c, "topicThenTier")).map((f) => f.path),
    ).toEqual(["model", "api", "docs"]);
  });
});

describe("filesToRead", () => {
  it("lists non-skip files by tier, reading order within a tier", () => {
    const c = commit({
      files: [
        file("1", "skim"),
        file("2", "critical"),
        file("3", "skip"),
        file("4", "critical"),
      ],
    });
    expect(filesToRead(c).map((f) => f.path)).toEqual(["2", "4", "1"]);
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
