import * as vscode from "vscode";
import { ReviewStore } from "./core/store";
import type { ReviewComment } from "./core/types";
import { getIdleTimeoutMs, loadState, saveState } from "./persistence";
import { ReviewsController, type ReviewCommentHandle } from "./reviews";
import { ReviewsTreeProvider, type ReviewsTreeNode } from "./tree";

export function activate(context: vscode.ExtensionContext) {
  let treeProvider: ReviewsTreeProvider | undefined;
  const store = new ReviewStore({
    timeoutMs: getIdleTimeoutMs(),
    initialState: loadState(context),
    onChange: (state) => {
      saveState(context, state);
      treeProvider?.refresh();
    },
  });

  const reviews = new ReviewsController(store);
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
        const uri = vscode.Uri.joinPath(root.uri, comment.path);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        const line = Math.max(comment.startLine - 1, 0);
        const range = new vscode.Range(line, 0, line, 0);
        editor.selection = new vscode.Selection(range.start, range.start);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
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
  );
}

export function deactivate() {}
