import { execFileSync } from "node:child_process";
import { findRebasedSha, parsePatchIds, reviewTagName } from "./core/cursor";

export type MarkResult =
  | { kind: "detached" }
  | { kind: "marked"; tag: string; sha: string };

export type ResyncResult =
  | { kind: "detached" }
  | { kind: "noTag"; tag: string }
  | { kind: "upToDate"; tag: string }
  | { kind: "moved"; tag: string; from: string; to: string }
  | { kind: "notFound"; tag: string };

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function succeeds(cwd: string, args: string[]): boolean {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

function currentBranch(cwd: string): string | undefined {
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  return branch === "HEAD" ? undefined : branch;
}

function resolveCommit(cwd: string, ref: string): string {
  return git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
}

export function markReviewed(cwd: string, ref: string): MarkResult {
  const branch = currentBranch(cwd);
  if (!branch) {
    return { kind: "detached" };
  }
  const tag = reviewTagName(branch);
  const sha = resolveCommit(cwd, ref);
  git(cwd, ["tag", "-f", tag, sha]);
  return { kind: "marked", tag, sha };
}

/** Moves the branch's review tag onto the commit with the same patch-id when the tagged commit is no longer in HEAD's history. */
export function resyncCursor(cwd: string): ResyncResult {
  const branch = currentBranch(cwd);
  if (!branch) {
    return { kind: "detached" };
  }
  const tag = reviewTagName(branch);
  const tagRef = `refs/tags/${tag}`;
  if (!succeeds(cwd, ["rev-parse", "--verify", "--quiet", tagRef])) {
    return { kind: "noTag", tag };
  }
  if (succeeds(cwd, ["merge-base", "--is-ancestor", tagRef, "HEAD"])) {
    return { kind: "upToDate", tag };
  }
  const from = resolveCommit(cwd, tagRef);
  const [target] = parsePatchIds(
    git(cwd, ["patch-id", "--stable"], git(cwd, ["show", tagRef])),
  );
  const candidates = parsePatchIds(
    git(
      cwd,
      ["patch-id", "--stable"],
      git(cwd, ["log", "-p", "--no-merges", `${tagRef}..HEAD`]),
    ),
  );
  const to = target && findRebasedSha(target.patchId, candidates);
  if (!to) {
    return { kind: "notFound", tag };
  }
  git(cwd, ["tag", "-f", tag, to]);
  return { kind: "moved", tag, from, to };
}
