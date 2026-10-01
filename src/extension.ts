import { join } from "node:path";
import * as vscode from "vscode";
import { gitLensCommitRef } from "./core/cursor";
import {
  commitDiffSides,
  diffTitle,
  EMPTY_DOCUMENT_SCHEME,
  openAndReveal,
  revisionUri,
  type DiffSides,
} from "./diff";
import { markReviewed, resyncCursor } from "./cursor";
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
import {
  entryFiles,
  fileKey,
  filesToRead,
  type GuideCommit,
  type Grouping,
} from "./core/guide";
import {
  GuideNotes,
  GuideState,
  GuideTreeProvider,
  guideDecorations,
  openGuideFile,
  openMultiDiff,
  type GuideNoteComment,
  guideFileAt,
  type GuideFileNode,
  type GuideTreeNode,
} from "./guideView";

async function updateSetting(key: string, value: unknown): Promise<void> {
  await vscode.workspace
    .getConfiguration("vscode-reviews")
    .update(key, value, vscode.ConfigurationTarget.Global);
}

/**
 * Default click on a comment: opens the working-tree file when there's no
 * shortSha, otherwise a diff of the file between the commit's parent and the
 * commit itself, with the cursor on the commented line.
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

  let sides: DiffSides | undefined;
  try {
    sides = await commitDiffSides(root, comment.shortSha, comment.path);
  } catch {
    vscode.window.showWarningMessage(
      `Revision ${comment.shortSha} is no longer in this repo.`,
    );
    await openAndReveal(fileUri, line);
    return;
  }
  if (!sides) {
    await openAndReveal(
      revisionUri(root, comment.path, comment.shortSha),
      line,
    );
    return;
  }
  await vscode.commands.executeCommand(
    "vscode.diff",
    sides.left,
    sides.right,
    diffTitle(comment.path, comment.shortSha),
    { selection: new vscode.Range(line, 0, line, 0) },
  );
}

function workspaceRootFor(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function runGit<T>(action: () => T): T | undefined {
  try {
    return action();
  } catch (error) {
    vscode.window.showErrorMessage(
      `Reviews: git failed — ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function markCommitReviewed(cwd: string, ref: string): void {
  const result = runGit(() => markReviewed(cwd, ref));
  if (result?.kind === "detached") {
    vscode.window.showErrorMessage(
      "Reviews: HEAD is detached — no branch to mark reviewed.",
    );
  } else if (result?.kind === "marked") {
    vscode.window.showInformationMessage(
      `Reviews: ${result.tag} → ${result.sha.slice(0, 7)}`,
    );
  }
}

function markHeadReviewed(): void {
  const cwd = workspaceRootFor();
  if (cwd) {
    markCommitReviewed(cwd, "HEAD");
  }
}

function resyncReviewCursor(): void {
  const cwd = workspaceRootFor();
  if (!cwd) {
    return;
  }
  const result = runGit(() => resyncCursor(cwd));
  switch (result?.kind) {
    case "detached":
      vscode.window.showErrorMessage(
        "Reviews: HEAD is detached — no branch to resync.",
      );
      break;
    case "noTag":
      vscode.window.showInformationMessage(
        `Reviews: no review cursor (${result.tag}) on this branch.`,
      );
      break;
    case "upToDate":
      vscode.window.showInformationMessage(
        `Reviews: cursor ${result.tag} is up to date.`,
      );
      break;
    case "moved":
      vscode.window.showInformationMessage(
        `Reviews: moved ${result.tag} from ${result.from.slice(0, 7)} to ${result.to.slice(0, 7)}.`,
      );
      break;
    case "notFound":
      vscode.window.showWarningMessage(
        `Reviews: the commit marked by ${result.tag} is no longer on this branch with the same diff — re-mark the last reviewed commit manually.`,
      );
      break;
  }
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

  const root = vscode.workspace.workspaceFolders?.[0];
  const guide = new GuideState(
    join(fileStore.dir, "guides"),
    fileStore.root,
    context.workspaceState,
  );
  const guideNotes = new GuideNotes(guide, root?.uri.fsPath ?? fileStore.root);
  const guideTree = new GuideTreeProvider(
    guide,
    root?.uri ?? vscode.Uri.file(fileStore.root),
  );
  const guideView = vscode.window.createTreeView("vscode-reviews.guide", {
    treeDataProvider: guideTree,
    manageCheckboxStateManually: true,
  });
  const guideWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(guide.guidesDir), "*.json"),
  );
  guide.onDidChange(() => {
    guideNotes.rerender();
    const snapshot = guide.snapshot;
    if (!snapshot) {
      guideView.description = undefined;
      return;
    }
    const shas = [...snapshot.current.values()].filter(
      (sha) => sha !== undefined,
    );
    const reviewed = shas.filter(
      (sha) => guide.reviewState(sha) !== "unreviewed",
    ).length;
    guideView.description = `${snapshot.guide.branch} · ${reviewed}/${snapshot.guide.commits.length} reviewed`;
  });
  guide.reload();

  const markGuideCommit = (sha: string) => {
    markCommitReviewed(fileStore.root, sha);
    guide.reload();
  };

  const offerMarkReviewed = async (commit: GuideCommit, sha: string) => {
    const choice = await vscode.window.showInformationMessage(
      `All files of "${commit.subject}" checked.`,
      "Mark reviewed",
    );
    if (choice === "Mark reviewed") {
      markGuideCommit(sha);
    }
  };

  const setFilesChecked = async (
    changes: { node: GuideFileNode; on: boolean }[],
  ) => {
    await guide.setChecked(
      changes.map(({ node, on }) => ({
        key: fileKey(node.commit, node.file),
        on,
      })),
    );
    const checked = guide.checked();
    const completed = new Map(
      changes
        .filter(
          ({ node, on }) =>
            on &&
            node.commit.files.every((f) =>
              checked.has(fileKey(node.commit, f)),
            ),
        )
        .map(({ node }) => [node.commit, node.sha]),
    );
    for (const [commit, sha] of completed) {
      await offerMarkReviewed(commit, sha);
    }
  };

  context.subscriptions.push(
    reviews,
    treeView,
    guideNotes,
    guideView,
    guideWatcher,
    guideWatcher.onDidCreate(() => guide.reload()),
    guideWatcher.onDidChange(() => guide.reload()),
    guideWatcher.onDidDelete(() => guide.reload()),
    guideView.onDidChangeVisibility((event) => {
      if (event.visible) {
        guide.reload();
      }
    }),
    guideView.onDidChangeCheckboxState((event) =>
      setFilesChecked(
        event.items.flatMap(([node, checkState]) =>
          node.kind === "file"
            ? [
                {
                  node,
                  on: checkState === vscode.TreeItemCheckboxState.Checked,
                },
              ]
            : [],
        ),
      ),
    ),
    vscode.commands.registerCommand(
      "vscode-reviews.guide.toggleFileReviewed",
      async (args?: { source?: "view" | "editor" }) => {
        const snapshot = guide.snapshot;
        const editorUri = vscode.window.activeTextEditor?.document.uri;
        const selected = guideView.selection[0];
        const node =
          args?.source === "view"
            ? selected?.kind === "file"
              ? selected
              : undefined
            : snapshot && editorUri
              ? guideFileAt(
                  snapshot,
                  editorUri,
                  root?.uri.fsPath ?? fileStore.root,
                )
              : undefined;
        if (!node) {
          vscode.window.showInformationMessage(
            "Reviews: no guide file here — select one in the Guide view or open its diff.",
          );
          return;
        }
        if (guide.reviewState(node.sha) !== "unreviewed") {
          vscode.window.showInformationMessage(
            `Reviews: "${node.commit.subject}" is already reviewed.`,
          );
          return;
        }
        const on = !guide.checked().has(fileKey(node.commit, node.file));
        await setFilesChecked([{ node, on }]);
      },
    ),
    vscode.window.registerFileDecorationProvider(guideDecorations),
    vscode.commands.registerCommand("vscode-reviews.guide.refresh", () =>
      guide.reload(),
    ),
    vscode.commands.registerCommand("vscode-reviews.guide.groupByTopic", () =>
      updateSetting("guideGrouping", "topicThenTier" satisfies Grouping),
    ),
    vscode.commands.registerCommand("vscode-reviews.guide.groupByTier", () =>
      updateSetting("guideGrouping", "tierThenTopic" satisfies Grouping),
    ),
    vscode.commands.registerCommand("vscode-reviews.guide.reasonInline", () =>
      updateSetting("guideFileReason", "inline"),
    ),
    vscode.commands.registerCommand(
      "vscode-reviews.guide.reasonSecondLine",
      () => updateSetting("guideFileReason", "secondLine"),
    ),
    vscode.commands.registerCommand("vscode-reviews.guide.showNotes", () =>
      updateSetting("guideNotesInline", true),
    ),
    vscode.commands.registerCommand("vscode-reviews.guide.hideNotes", () =>
      updateSetting("guideNotesInline", false),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("vscode-reviews.guideGrouping") ||
        event.affectsConfiguration("vscode-reviews.guideFileReason")
      ) {
        guideTree.refresh();
      }
      if (event.affectsConfiguration("vscode-reviews.guideNotesInline")) {
        guideNotes.rerender();
      }
    }),
    vscode.commands.registerCommand(
      "vscode-reviews.guide.openFile",
      async (node: GuideTreeNode) => {
        if (root && node.kind === "file") {
          await openGuideFile(root, node.sha, node.file);
        }
      },
    ),
    vscode.commands.registerCommand(
      "vscode-reviews.guide.openMultiDiff",
      async (node: GuideTreeNode) => {
        if (!root) {
          return;
        }
        if (node.kind === "group") {
          await openMultiDiff(
            root,
            node.sha,
            `${node.commit.subject} — ${node.group.key || "Other"}`,
            entryFiles(node.group.children),
          );
        } else if (node.kind === "commit" && node.sha) {
          await openMultiDiff(
            root,
            node.sha,
            node.commit.subject,
            filesToRead(node.commit),
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      "vscode-reviews.guide.markReviewed",
      (node: GuideTreeNode) => {
        if (node.kind === "commit" && node.sha) {
          markGuideCommit(node.sha);
        }
      },
    ),
    vscode.commands.registerCommand(
      "vscode-reviews.guide.promoteNote",
      async (comment: GuideNoteComment) => {
        await reviews.addComment(comment.input);
        await guide.markPromoted(comment.key);
        guideNotes.rerender();
      },
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      EMPTY_DOCUMENT_SCHEME,
      { provideTextDocumentContent: () => "" },
    ),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      reviews.renderDocument(doc);
      guideNotes.renderDocument(doc);
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) {
        reviews.renderDocument(editor.document);
        guideNotes.renderDocument(editor.document);
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
        const uri = revisionUri(root, node.comment.path, node.comment.shortSha);
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
    vscode.commands.registerCommand("vscode-reviews.markReviewed", () => {
      markHeadReviewed();
      guide.reload();
    }),
    vscode.commands.registerCommand(
      "vscode-reviews.gitlens.markReviewed",
      (node: unknown) => {
        const ref = gitLensCommitRef(node);
        if (!ref) {
          vscode.window.showErrorMessage(
            "Reviews: could not read a commit from this GitLens item.",
          );
          return;
        }
        markCommitReviewed(ref.repoPath, ref.sha);
        guide.reload();
      },
    ),
    vscode.commands.registerCommand("vscode-reviews.resyncCursor", () => {
      resyncReviewCursor();
      guide.reload();
    }),
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
