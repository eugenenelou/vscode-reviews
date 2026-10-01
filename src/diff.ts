import { basename } from "node:path";
import * as vscode from "vscode";
import { buildRevisionUri } from "./core/location";

/** The subset of the built-in Git extension's API used to resolve a commit's parent. */
interface GitCommit {
  hash: string;
  parents: string[];
}

interface GitRepository {
  getCommit(ref: string): Promise<GitCommit>;
  getObjectDetails(
    treeish: string,
    path: string,
  ): Promise<{ mode: string; object: string; size: number }>;
}

interface GitAPI {
  getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitExtensionExports {
  getAPI(version: 1): GitAPI;
}

/**
 * Stand-in for a side of a diff where the file doesn't exist (added in the
 * commit, root commit, or deleted by it): the Git filesystem provider throws
 * "file not found" rather than serving an empty document, so we serve one.
 */
export const EMPTY_DOCUMENT_SCHEME = "vscode-reviews-empty";

export interface DiffSides {
  left: vscode.Uri;
  right: vscode.Uri;
}

/** Opens a document and reveals/selects the given (0-indexed) line. */
export async function openAndReveal(
  uri: vscode.Uri,
  line: number,
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document);
  const clampedLine = Math.max(line, 0);
  const range = new vscode.Range(clampedLine, 0, clampedLine, 0);
  editor.selection = new vscode.Selection(range.start, range.start);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

async function resolveRepository(
  uri: vscode.Uri,
): Promise<GitRepository | undefined> {
  const gitExtension =
    vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
  if (!gitExtension) {
    return undefined;
  }
  const exports = gitExtension.isActive
    ? gitExtension.exports
    : await gitExtension.activate();
  return exports.getAPI(1).getRepository(uri) ?? undefined;
}

async function existsAt(
  repository: GitRepository,
  ref: string,
  path: string,
): Promise<boolean> {
  try {
    await repository.getObjectDetails(ref, path);
    return true;
  } catch {
    return false;
  }
}

export function revisionUri(
  root: vscode.WorkspaceFolder,
  path: string,
  ref: string,
): vscode.Uri {
  return vscode.Uri.from(buildRevisionUri(path, ref, root.uri.fsPath));
}

/**
 * Both sides of a file's diff between a commit's parent and the commit, an
 * empty document standing in for a side where the file doesn't exist.
 * Undefined without a Git repository; throws when the commit isn't in it.
 */
export async function commitDiffSides(
  root: vscode.WorkspaceFolder,
  sha: string,
  path: string,
): Promise<DiffSides | undefined> {
  const repository = await resolveRepository(
    vscode.Uri.joinPath(root.uri, path),
  );
  if (!repository) {
    return undefined;
  }
  const parent = (await repository.getCommit(sha)).parents[0];
  const right = revisionUri(root, path, sha);
  const empty = right.with({ scheme: EMPTY_DOCUMENT_SCHEME, query: "" });
  return {
    left:
      parent && (await existsAt(repository, parent, path))
        ? revisionUri(root, path, parent)
        : empty,
    right: (await existsAt(repository, sha, path)) ? right : empty,
  };
}

export function diffTitle(path: string, sha: string): string {
  return `${basename(path)} (${sha.slice(0, 7)})`;
}
