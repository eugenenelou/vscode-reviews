import { join } from "node:path";
import * as vscode from "vscode";
import { ReviewStore, type NewCommentInput } from "./core/store";
import type { Review, ReviewComment } from "./core/types";
import { parseLocation } from "./core/location";
import { formatPrompt } from "./core/format";

export const CONTROLLER_ID = "vscode-reviews";

/** Extra fields vscode preserves on the Comment instance and passes back into command handlers. */
export interface ReviewCommentHandle extends vscode.Comment {
  readonly id: string;
  readonly parent: vscode.CommentThread;
}

/** Comment lines/ranges are stored 1-indexed (matches the prompt format); vscode Ranges are 0-indexed. */
class ReviewNoteComment implements ReviewCommentHandle {
  body: string | vscode.MarkdownString;
  mode: vscode.CommentMode;
  author: vscode.CommentAuthorInformation = { name: "Review" };
  contextValue = "canEdit";

  constructor(
    public readonly id: string,
    body: string,
    mode: vscode.CommentMode,
    public readonly parent: vscode.CommentThread,
  ) {
    this.body = body;
    this.mode = mode;
  }
}

/** True when this document is the left/old side of an open diff editor tab — out of scope per spec. */
export function isDiffOriginalSide(uri: vscode.Uri): boolean {
  const key = uri.toString();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (
        tab.input instanceof vscode.TabInputTextDiff &&
        tab.input.original.toString() === key
      ) {
        return true;
      }
    }
  }
  return false;
}

function provideCommentingRanges(
  document: vscode.TextDocument,
): vscode.Range[] {
  if (isDiffOriginalSide(document.uri)) {
    return [];
  }
  const lastLine = Math.max(document.lineCount - 1, 0);
  return [new vscode.Range(0, 0, lastLine, 0)];
}

/**
 * A thread's initial range is sometimes just the clicked gutter line even
 * when the editor has a wider selection over that line (native drag-select
 * already produces the right range and this is then a no-op union).
 */
function resolveCommentRange(thread: vscode.CommentThread): vscode.Range {
  const base = thread.range ?? new vscode.Range(0, 0, 0, 0);
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== thread.uri.toString()) {
    return base;
  }
  const selection = editor.selection;
  if (selection.isEmpty || selection.isSingleLine) {
    return base;
  }
  const selectionEndLine =
    selection.end.character === 0 && selection.end.line > selection.start.line
      ? selection.end.line - 1
      : selection.end.line;
  const overlaps =
    selection.start.line <= base.end.line &&
    selectionEndLine >= base.start.line;
  if (!overlaps) {
    return base;
  }
  const startLine = Math.min(selection.start.line, base.start.line);
  const endLine = Math.max(selectionEndLine, base.end.line);
  return new vscode.Range(startLine, 0, endLine, 0);
}

function getWorkspaceRoot(uri: vscode.Uri): string {
  const folder =
    vscode.workspace.getWorkspaceFolder(uri) ??
    vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath ?? "";
}

async function promptContinueOrNew(): Promise<boolean> {
  const choice = await vscode.window.showQuickPick(
    [
      { label: "Continue previous review", value: true },
      { label: "Start a new review", value: false },
    ],
    {
      placeHolder:
        "The active review has been idle a while — continue it or start fresh?",
      ignoreFocusOut: true,
    },
  );
  return choice?.value ?? true;
}

export class ReviewsController {
  /** One thread per document showing the comment: the same revision can be open as gitlens:// and git:// documents. */
  private readonly threadsByCommentId = new Map<
    string,
    vscode.CommentThread[]
  >();
  readonly controller: vscode.CommentController;

  constructor(
    private readonly store: ReviewStore,
    private readonly storeDir: string,
  ) {
    this.controller = vscode.comments.createCommentController(
      CONTROLLER_ID,
      "Reviews",
    );
    this.controller.commentingRangeProvider = { provideCommentingRanges };
  }

  dispose(): void {
    this.controller.dispose();
  }

  renderVisibleEditors(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.renderDocument(editor.document);
    }
  }

  renderDocument(document: vscode.TextDocument): void {
    const review = this.store.getActiveReview();
    if (!review) {
      return;
    }
    if (isDiffOriginalSide(document.uri)) {
      return;
    }
    const workspaceRoot = getWorkspaceRoot(document.uri);
    const { relPath, shortSha } = parseLocation(
      document.uri.toString(),
      workspaceRoot,
    );
    const key = document.uri.toString();
    for (const comment of review.comments) {
      if (comment.path !== relPath || comment.shortSha !== shortSha) {
        continue;
      }
      const rendered = this.threadsFor(comment.id).some(
        (thread) => thread.uri.toString() === key,
      );
      if (!rendered) {
        this.renderComment(document.uri, comment);
      }
    }
  }

  private threadsFor(commentId: string): vscode.CommentThread[] {
    return this.threadsByCommentId.get(commentId) ?? [];
  }

  private trackThread(commentId: string, thread: vscode.CommentThread): void {
    this.threadsByCommentId.set(commentId, [
      ...this.threadsFor(commentId),
      thread,
    ]);
  }

  private disposeThreads(commentId: string): void {
    for (const thread of this.threadsFor(commentId)) {
      thread.dispose();
    }
    this.threadsByCommentId.delete(commentId);
  }

  private setCommentText(commentId: string, text: string): void {
    for (const thread of this.threadsFor(commentId)) {
      thread.comments = [
        new ReviewNoteComment(
          commentId,
          text,
          vscode.CommentMode.Preview,
          thread,
        ),
      ];
    }
  }

  private renderComment(uri: vscode.Uri, comment: ReviewComment): void {
    const range = new vscode.Range(
      comment.startLine - 1,
      0,
      comment.endLine - 1,
      0,
    );
    const thread = this.controller.createCommentThread(uri, range, []);
    thread.canReply = false;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    const noteComment = new ReviewNoteComment(
      comment.id,
      comment.text,
      vscode.CommentMode.Preview,
      thread,
    );
    thread.comments = [noteComment];
    this.trackThread(comment.id, thread);
  }

  private async confirmContinue(now: number): Promise<void> {
    if (this.store.needsContinuePrompt(now)) {
      const answer = await promptContinueOrNew();
      this.store.rememberContinueAnswer(answer, now);
      if (!answer) {
        this.disposeAllThreads();
      }
    }
  }

  /** Adds a comment not typed in a thread (e.g. a promoted guide note) and renders it where visible. */
  async addComment(input: NewCommentInput): Promise<void> {
    const now = Date.now();
    await this.confirmContinue(now);
    this.store.addComment(input, now);
    this.renderVisibleEditors();
  }

  async createComment(reply: vscode.CommentReply): Promise<void> {
    const now = Date.now();
    await this.confirmContinue(now);

    const thread = reply.thread;
    const workspaceRoot = getWorkspaceRoot(thread.uri);
    const { relPath, shortSha } = parseLocation(
      thread.uri.toString(),
      workspaceRoot,
    );
    const range = resolveCommentRange(thread);
    thread.range = range;
    const comment = this.store.addComment(
      {
        path: relPath,
        startLine: range.start.line + 1,
        endLine: range.end.line + 1,
        shortSha,
        text: reply.text,
      },
      now,
    );

    thread.canReply = false;
    const noteComment = new ReviewNoteComment(
      comment.id,
      comment.text,
      vscode.CommentMode.Preview,
      thread,
    );
    thread.comments = [noteComment];
    this.trackThread(comment.id, thread);
  }

  editComment(comment: ReviewCommentHandle): void {
    comment.mode = vscode.CommentMode.Editing;
    comment.parent.comments = [...comment.parent.comments];
  }

  cancelEditComment(comment: ReviewCommentHandle): void {
    const original = this.store
      .getActiveReview()
      ?.comments.find((c) => c.id === comment.id);
    if (original) {
      comment.body = original.text;
    }
    comment.mode = vscode.CommentMode.Preview;
    comment.parent.comments = [...comment.parent.comments];
  }

  saveComment(comment: ReviewCommentHandle): void {
    const text = String(comment.body);
    this.store.editComment(comment.id, { text }, Date.now());
    this.setCommentText(comment.id, text);
  }

  deleteComment(comment: ReviewCommentHandle): void {
    this.store.deleteComment(comment.id, Date.now());
    this.disposeThreads(comment.id);
  }

  async newReview(): Promise<void> {
    this.store.startNewReview(Date.now());
    this.disposeAllThreads();
  }

  /** Copies the given review's prompt, or the active review's when none is given. */
  async copyPrompt(review?: Review): Promise<void> {
    const target = review ?? this.store.getActiveReview();
    if (!target || target.comments.length === 0) {
      vscode.window.showInformationMessage("No review to copy.");
      return;
    }
    await vscode.env.clipboard.writeText(formatPrompt(target));
    vscode.window.showInformationMessage("Review prompt copied to clipboard.");
  }

  /** Copies the review's own JSON file path to the clipboard. */
  async copyLink(review: Review): Promise<void> {
    await vscode.env.clipboard.writeText(
      join(this.storeDir, `${review.id}.json`),
    );
    vscode.window.showInformationMessage(
      "Review file path copied to clipboard.",
    );
  }

  /** Deletes a review by id (active or past), disposing its threads if it was active. */
  deleteReview(reviewId: string): void {
    const wasActive = this.store.getActiveReview()?.id === reviewId;
    this.store.deleteReview(reviewId);
    if (wasActive) {
      this.disposeAllThreads();
    }
  }

  /** Sidebar-driven delete: works for a comment in the active or a past review. */
  deleteCommentById(review: Review, commentId: string): void {
    this.store.deleteComment(commentId, Date.now(), review.id);
    this.disposeThreads(commentId);
  }

  /** Sidebar-driven edit: prompts with an input box, works for active or past reviews. */
  async editCommentById(review: Review, comment: ReviewComment): Promise<void> {
    const text = await vscode.window.showInputBox({
      prompt: "Edit comment",
      value: comment.text,
      ignoreFocusOut: true,
    });
    if (text === undefined || text === comment.text) {
      return;
    }
    this.store.editComment(comment.id, { text }, Date.now(), review.id);
    this.setCommentText(comment.id, text);
  }

  private disposeAllThreads(): void {
    for (const commentId of [...this.threadsByCommentId.keys()]) {
      this.disposeThreads(commentId);
    }
  }
}
