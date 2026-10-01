import type { PatchIdEntry } from "./cursor";

export const TIERS = ["critical", "review", "skim", "skip"] as const;
export type Tier = (typeof TIERS)[number];

/** Lines are 1-indexed, on the commit's (new) version of the file. */
export interface GuideNote {
  startLine: number;
  endLine: number;
  text: string;
}

export interface GuideFile {
  path: string;
  tier: Tier;
  reason: string;
  notes: GuideNote[];
}

export interface GuideCommit {
  sha: string;
  patchId: string;
  subject: string;
  summary: string;
  flags: string[];
  /** In reading order: the first file is where to start. */
  files: GuideFile[];
}

/** Written by the /prepare-review skill; commits oldest first. */
export interface Guide {
  id: string;
  branch: string;
  base: string;
  createdAt: number;
  commits: GuideCommit[];
}

export type CommitReviewState = "reviewed" | "cursor" | "unreviewed";

export interface TierGroup {
  tier: Tier;
  files: GuideFile[];
}

function fail(where: string, message: string): never {
  throw new Error(`${where}: ${message}`);
}

function str(value: unknown, where: string): string {
  if (typeof value !== "string") {
    fail(where, "expected a string");
  }
  return value;
}

function line(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    fail(where, "expected a positive integer line");
  }
  return value;
}

function arr(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(where, "expected an array");
  }
  return value;
}

function obj(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(where, "expected an object");
  }
  return value as Record<string, unknown>;
}

function parseNote(value: unknown, where: string): GuideNote {
  const note = obj(value, where);
  const startLine = line(note.startLine, `${where}.startLine`);
  const endLine =
    note.endLine === undefined
      ? startLine
      : line(note.endLine, `${where}.endLine`);
  if (endLine < startLine) {
    fail(where, "endLine is before startLine");
  }
  return { startLine, endLine, text: str(note.text, `${where}.text`) };
}

function parseFile(value: unknown, where: string): GuideFile {
  const file = obj(value, where);
  const tier = str(file.tier, `${where}.tier`);
  if (!(TIERS as readonly string[]).includes(tier)) {
    fail(`${where}.tier`, `expected one of ${TIERS.join(", ")}`);
  }
  return {
    path: str(file.path, `${where}.path`),
    tier: tier as Tier,
    reason: str(file.reason, `${where}.reason`),
    notes: arr(file.notes ?? [], `${where}.notes`).map((n, i) =>
      parseNote(n, `${where}.notes[${i}]`),
    ),
  };
}

function parseCommit(value: unknown, where: string): GuideCommit {
  const commit = obj(value, where);
  return {
    sha: str(commit.sha, `${where}.sha`),
    patchId: str(commit.patchId, `${where}.patchId`),
    subject: str(commit.subject, `${where}.subject`),
    summary: str(commit.summary, `${where}.summary`),
    flags: arr(commit.flags ?? [], `${where}.flags`).map((f, i) =>
      str(f, `${where}.flags[${i}]`),
    ),
    files: arr(commit.files, `${where}.files`).map((f, i) =>
      parseFile(f, `${where}.files[${i}]`),
    ),
  };
}

/** Validates a guide file's JSON; throws with the offending field's path. */
export function parseGuide(id: string, json: unknown): Guide {
  const guide = obj(json, "guide");
  if (typeof guide.createdAt !== "number") {
    fail("guide.createdAt", "expected a timestamp in ms");
  }
  return {
    id,
    branch: str(guide.branch, "guide.branch"),
    base: str(guide.base, "guide.base"),
    createdAt: guide.createdAt,
    commits: arr(guide.commits, "guide.commits").map((c, i) =>
      parseCommit(c, `guide.commits[${i}]`),
    ),
  };
}

/** The newest guide written for the branch. */
export function latestGuideFor(
  guides: Guide[],
  branch: string,
): Guide | undefined {
  return guides
    .filter((g) => g.branch === branch)
    .reduce<Guide | undefined>(
      (best, g) => (!best || g.createdAt > best.createdAt ? g : best),
      undefined,
    );
}

/** Non-empty tiers in tier order; files keep their reading order. */
export function groupByTier(commit: GuideCommit): TierGroup[] {
  return TIERS.map((tier) => ({
    tier,
    files: commit.files.filter((f) => f.tier === tier),
  })).filter((group) => group.files.length > 0);
}

/**
 * Where each guide commit lives on the branch now: the same sha, or after a
 * rewrite the commit with the same patch-id; undefined when it's gone (stale).
 */
export function matchGuideCommits(
  commits: GuideCommit[],
  branchCommits: PatchIdEntry[],
): Map<GuideCommit, string | undefined> {
  const shas = new Set(branchCommits.map((c) => c.sha));
  return new Map(
    commits.map((commit) => [
      commit,
      shas.has(commit.sha)
        ? commit.sha
        : branchCommits.find((c) => c.patchId === commit.patchId)?.sha,
    ]),
  );
}

/**
 * A commit at or before the review cursor is reviewed. `orderedShas` is the
 * branch history oldest first; a cursor outside it (before the range, or a
 * stale tag after a rewrite) marks nothing reviewed.
 */
export function commitReviewState(
  sha: string,
  orderedShas: string[],
  cursorSha: string | undefined,
): CommitReviewState {
  const cursorIndex = cursorSha ? orderedShas.indexOf(cursorSha) : -1;
  const index = orderedShas.indexOf(sha);
  if (cursorIndex < 0 || index < 0 || index > cursorIndex) {
    return "unreviewed";
  }
  return index === cursorIndex ? "cursor" : "reviewed";
}

/** Checked-file key, by patch-id so checks survive a rebase. */
export function fileKey(commit: GuideCommit, file: GuideFile): string {
  return `${commit.patchId}:${file.path}`;
}

export function noteKey(
  commit: GuideCommit,
  file: GuideFile,
  note: GuideNote,
): string {
  return `${fileKey(commit, file)}:${note.startLine}-${note.endLine}`;
}

export function commitProgress(
  commit: GuideCommit,
  checked: ReadonlySet<string>,
): { done: number; total: number } {
  return {
    done: commit.files.filter((f) => checked.has(fileKey(commit, f))).length,
    total: commit.files.length,
  };
}
