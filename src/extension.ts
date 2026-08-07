import * as vscode from "vscode";
import { ReviewStore } from "./core/store";
import { getIdleTimeoutMs, loadState, saveState } from "./persistence";
import { ReviewsController, type ReviewCommentHandle } from "./reviews";

export function activate(context: vscode.ExtensionContext) {
  const store = new ReviewStore({
    timeoutMs: getIdleTimeoutMs(),
    initialState: loadState(context),
    onChange: (state) => saveState(context, state),
  });

  const reviews = new ReviewsController(store);
  reviews.renderVisibleEditors();

  context.subscriptions.push(
    reviews,
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
  );
}

export function deactivate() {}
