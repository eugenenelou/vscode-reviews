import { basename } from "node:path";
import * as vscode from "vscode";
import { buildRevisionUri } from "./core/location";
import { ReviewStore } from "./core/store";
import type { ReviewComment } from "./core/types";
import {
  applyChange,
  getIdleTimeoutMs,
  initFileStore,
  loadReviews,
} from "./persistence";
import { ReviewsController, type ReviewCommentHandle } from "./reviews";
import { ReviewsTreeProvider, type ReviewsTreeNode } from "./tree";

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

/** Opens a document and reveals/selects the given (0-indexed) line. */
async function openAndReveal(uri: vscode.Uri, line: number): Promise<void> {
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

/**
 * The parent ref to diff against, or undefined when there is nothing to diff:
 * no parent commit (root), or the file didn't exist yet at the parent (added
 * in this commit) — the Git filesystem provider throws "file not found" rather
 * than serving an empty document for those.
 */
async function resolveDiffBase(
  repository: GitRepository,
  sha: string,
  path: string,
): Promise<string | undefined> {
  const commit = await repository.getCommit(sha);
  const parent = commit.parents[0];
  if (!parent) {
    return undefined;
  }
  try {
    await repository.getObjectDetails(parent, path);
    return parent;
  } catch {
    return undefined;
  }
}

/**
 * Default click on a comment: opens the working-tree file when there's no
 * shortSha, otherwise a diff of the file between the commit's parent and the
 * commit itself, with the cursor on the commented line. Falls back to the
 * file at that revision alone when there is no parent version to diff against.
 */
async function openComment(
  comment: ReviewComment,
  root: vscode.WorkspaceFolder,
): Promise<void> {
  const fileUri = vscode.Uri.joinPath(root.uri, comment.path);
  const line = Math.max(comment.startLine - 1, 0);
  if (!comment.shortSha) {
    await openAndReveal(fileUri, line);
    return;
  }

  const revisionUri = vscode.Uri.from(
    buildRevisionUri(comment.path, comment.shortSha, root.uri.fsPath),
  );

  let base: string | undefined;
  try {
    const repository = await resolveRepository(fileUri);
    if (!repository) {
      await openAndReveal(revisionUri, line);
      return;
    }
    base = await resolveDiffBase(repository, comment.shortSha, comment.path);
  } catch {
    vscode.window.showWarningMessage(
      `Revision ${comment.shortSha} is no longer in this repo.`,
    );
    await openAndReveal(fileUri, line);
    return;
  }

  if (!base) {
    await openAndReveal(revisionUri, line);
    return;
  }

  const leftUri = vscode.Uri.from(
    buildRevisionUri(comment.path, base, root.uri.fsPath),
  );
  await vscode.commands.executeCommand(
    "vscode.diff",
    leftUri,
    revisionUri,
    `${basename(comment.path)} (${comment.shortSha})`,
    { selection: new vscode.Range(line, 0, line, 0) },
  );
}

export function activate(context: vscode.ExtensionContext) {
  const fileStore = initFileStore();
  let treeProvider: ReviewsTreeProvider | undefined;
  const store = new ReviewStore({
    timeoutMs: getIdleTimeoutMs(),
    initialState: loadReviews(fileStore.dir),
    onChange: (change) => {
      applyChange(fileStore.dir, change);
      treeProvider?.refresh();
    },
  });

  const reviews = new ReviewsController(store, fileStore.dir);
  reviews.renderVisibleEditors();

  treeProvider = new ReviewsTreeProvider(store);
  const treeView = vscode.window.createTreeView("vscode-reviews.tree", {
    treeDataProvider: treeProvider,
  });

  context.subscriptions.push(
    reviews,
    treeView,
    vscode.workspace.onDidOpenTextDocument((doc) =>
      reviews.renderDocument(doc),
    ),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) {
        reviews.renderDocument(editor.document);
      }
    }),
    vscode.commands.registerCommand(
      "vscode-reviews.createComment",
      (reply: vscode.CommentReply) => reviews.createComment(reply),
    ),
    vscode.commands.registerCommand(
      "vscode-reviews.editComment",
      (comment: ReviewCommentHandle) => reviews.editComment(comment),
    ),
    vscode.commands.registerCommand(
      "vscode-reviews.cancelEditComment",
      (comment: ReviewCommentHandle) => reviews.cancelEditComment(comment),
    ),
    vscode.commands.registerCommand(
      "vscode-reviews.saveComment",
      (comment: ReviewCommentHandle) => reviews.saveComment(comment),
    ),
    vscode.commands.registerCommand(
      "vscode-reviews.deleteComment",
      (comment: ReviewCommentHandle) => reviews.deleteComment(comment),
    ),
    vscode.commands.registerCommand("vscode-reviews.newReview", () =>
      reviews.newReview(),
    ),
    vscode.commands.registerCommand("vscode-reviews.copyPrompt", () =>
      reviews.copyPrompt(),
    ),
    vscode.commands.registerCommand(
      "vscode-reviews.openComment",
      async (comment?: ReviewComment) => {
        const root = vscode.workspace.workspaceFolders?.[0];
        if (!root || !comment) {
          return;
        }
        await openComment(comment, root);
      },
    ),
    vscode.commands.registerCommand(
      "vscode-reviews.openCommentRevision",
      async (node: ReviewsTreeNode) => {
        if (node.kind !== "comment" || !node.comment.shortSha) {
          return;
        }
        const root = vscode.workspace.workspaceFolders?.[0];
        if (!root) {
          return;
        }
        const uri = vscode.Uri.from(
          buildRevisionUri(
            node.comment.path,
            node.comment.shortSha,
            root.uri.fsPath,
          ),
        );
        await openAndReveal(uri, node.comment.startLine - 1);
      },
    ),
    vscode.commands.registerCommand(
      "vscode-reviews.openCommentCurrent",
      async (node: ReviewsTreeNode) => {
        if (node.kind !== "comment") {
          return;
        }
        const root = vscode.workspace.workspaceFolders?.[0];
        if (!root) {
          return;
        }
        const uri = vscode.Uri.joinPath(root.uri, node.comment.path);
        await openAndReveal(uri, node.comment.startLine - 1);
      },
    ),
    vscode.commands.registerCommand(
      "vscode-reviews.tree.copyPrompt",
      (node: ReviewsTreeNode) => {
        if (node.kind === "activeReview" || node.kind === "pastReview") {
          reviews.copyPrompt(node.review);
        }
      },
    ),
    vscode.commands.registerCommand(
      "vscode-reviews.tree.deleteReview",
      async (node: ReviewsTreeNode) => {
        if (node.kind !== "activeReview" && node.kind !== "pastReview") {
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          "Delete this review and all its comments?",
          { modal: true },
          "Delete",
        );
        if (confirm === "Delete") {
          reviews.deleteReview(node.review.id);
        }
      },
    ),
    vscode.commands.registerCommand(
      "vscode-reviews.tree.editComment",
      (node: ReviewsTreeNode) => {
        if (node.kind === "comment") {
          reviews.editCommentById(node.review, node.comment);
        }
      },
    ),
    vscode.commands.registerCommand(
      "vscode-reviews.tree.deleteComment",
      (node: ReviewsTreeNode) => {
        if (node.kind === "comment") {
          reviews.deleteCommentById(node.review, node.comment.id);
        }
      },
    ),
    vscode.commands.registerCommand(
      "vscode-reviews.tree.copyLink",
      (node: ReviewsTreeNode) => {
        if (node.kind === "activeReview" || node.kind === "pastReview") {
          reviews.copyLink(node.review);
        }
      },
    ),
  );
}

export function deactivate() {}
