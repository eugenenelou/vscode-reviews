export interface CommitRef {
  sha: string;
  repoPath: string;
}

export interface PatchIdEntry {
  patchId: string;
  sha: string;
}

export function reviewTagName(branch: string): string {
  return `rv/${branch}`;
}

/** Parses `git patch-id` output: one `<patch-id> <commit-sha>` per line. */
export function parsePatchIds(output: string): PatchIdEntry[] {
  const entries: PatchIdEntry[] = [];
  for (const line of output.split("\n")) {
    const [patchId, sha] = line.trim().split(/\s+/);
    if (patchId && sha) {
      entries.push({ patchId, sha });
    }
  }
  return entries;
}

/** The first (newest, in `git log` order) candidate sharing the target's patch-id. */
export function findRebasedSha(
  targetPatchId: string,
  candidates: PatchIdEntry[],
): string | undefined {
  return candidates.find((c) => c.patchId === targetPatchId)?.sha;
}

/** Reads the commit from a GitLens commit view node (`node.commit.{sha,repoPath}`). */
export function gitLensCommitRef(node: unknown): CommitRef | undefined {
  const commit = (node as { commit?: unknown } | undefined)?.commit as
    | { sha?: unknown; repoPath?: unknown }
    | undefined;
  if (
    typeof commit?.sha !== "string" ||
    typeof commit.repoPath !== "string" ||
    !/^[0-9a-f]{40,64}$/i.test(commit.sha)
  ) {
    return undefined;
  }
  return { sha: commit.sha, repoPath: commit.repoPath };
}
