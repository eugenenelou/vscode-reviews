import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import * as vscode from "vscode";
import type { StoreChange, ReviewStorePersistedState } from "./core/store";
import type { Review, ReviewComment } from "./core/types";

export interface FileStore {
  dir: string;
  root: string;
}

/** On-disk shape is a pinned external contract (read by a separate CLI): `sha`, not `shortSha`. */
interface DiskComment {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  sha?: string;
  text: string;
}

interface DiskReview {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  archivedAt: number | null;
  comments: DiskComment[];
}

function toDiskComment(comment: ReviewComment): DiskComment {
  return {
    id: comment.id,
    path: comment.path,
    startLine: comment.startLine,
    endLine: comment.endLine,
    ...(comment.shortSha ? { sha: comment.shortSha } : {}),
    text: comment.text,
  };
}

function fromDiskComment(comment: DiskComment): ReviewComment {
  const { sha, ...rest } = comment;
  return sha ? { ...rest, shortSha: sha } : rest;
}

function toDiskReview(review: Review): DiskReview {
  return {
    id: review.id,
    createdAt: review.createdAt,
    lastActivityAt: review.lastActivityAt,
    archivedAt: review.archivedAt,
    comments: review.comments.map(toDiskComment),
  };
}

function fromDiskReview(review: DiskReview): Review {
  return {
    id: review.id,
    createdAt: review.createdAt,
    lastActivityAt: review.lastActivityAt,
    archivedAt: review.archivedAt,
    comments: review.comments.map(fromDiskComment),
  };
}

function resolveWorkspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const cwd = folder?.uri.fsPath ?? process.cwd();
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
    }).trim();
  } catch {
    return cwd;
  }
}

function slugFor(root: string): string {
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return `${basename(root)}-${hash}`;
}

/** Resolves the per-worktree store directory and writes meta.json, creating the directory if needed. */
export function initFileStore(): FileStore {
  const root = resolveWorkspaceRoot();
  const dir = join(
    homedir(),
    ".local",
    "share",
    "vscode-reviews",
    slugFor(root),
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ root }, null, 2));
  return { dir, root };
}

/** Reads every review file in the store dir; at most one has archivedAt: null (the active review). */
export function loadReviews(dir: string): ReviewStorePersistedState {
  if (!existsSync(dir)) {
    return { active: null, past: [] };
  }
  const reviews = readdirSync(dir)
    .filter((name) => name.endsWith(".json") && name !== "meta.json")
    .map((name) => {
      const disk = JSON.parse(
        readFileSync(join(dir, name), "utf8"),
      ) as DiskReview;
      return fromDiskReview(disk);
    });
  // The contract guarantees at most one archivedAt:null file; if that's ever
  // violated (e.g. hand-edited on disk), don't silently drop the extras —
  // keep the most recently active one, the rest fall back into past.
  const actives = reviews.filter((r) => r.archivedAt === null);
  const active =
    actives.length > 0
      ? actives.reduce((a, b) => (a.lastActivityAt >= b.lastActivityAt ? a : b))
      : null;
  const past = reviews
    .filter((r) => r !== active)
    .sort(
      (a, b) =>
        (b.archivedAt ?? b.lastActivityAt) - (a.archivedAt ?? a.lastActivityAt),
    );
  return { active, past };
}

export function reviewFilePath(dir: string, reviewId: string): string {
  return join(dir, `${reviewId}.json`);
}

/** Rewrites only the affected review's file, per the storage contract. */
export function applyChange(dir: string, change: StoreChange): void {
  if (change.kind === "save") {
    writeFileSync(
      reviewFilePath(dir, change.review.id),
      JSON.stringify(toDiskReview(change.review), null, 2),
    );
    return;
  }
  const target = reviewFilePath(dir, change.reviewId);
  if (existsSync(target)) {
    rmSync(target);
  }
}

export function getIdleTimeoutMs(): number {
  const minutes = vscode.workspace
    .getConfiguration("vscode-reviews")
    .get<number>("idleTimeoutMinutes", 60);
  return minutes * 60 * 1000;
}
