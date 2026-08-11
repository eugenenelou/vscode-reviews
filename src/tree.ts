import * as vscode from "vscode";
import { ReviewStore } from "./core/store";
import type { Review, ReviewComment } from "./core/types";
import { excerptComment } from "./core/format";

export type ReviewsTreeNode =
  | { kind: "activeReview"; review: Review }
  | { kind: "emptyActive" }
  | { kind: "pastSection" }
  | { kind: "emptyPast" }
  | { kind: "pastReview"; review: Review }
  | { kind: "comment"; review: Review; comment: ReviewComment };

function lineLabel(comment: ReviewComment): string {
  return comment.startLine === comment.endLine
    ? `${comment.startLine}`
    : `${comment.startLine}-${comment.endLine}`;
}

function formatReviewLabel(review: Review): string {
  const date = new Date(review.createdAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const count = review.comments.length;
  return `${date} — ${count} comment${count === 1 ? "" : "s"}`;
}

export class ReviewsTreeProvider implements vscode.TreeDataProvider<ReviewsTreeNode> {
  private readonly emitter = new vscode.EventEmitter<
    ReviewsTreeNode | undefined
  >();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: ReviewStore) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getChildren(element?: ReviewsTreeNode): ReviewsTreeNode[] {
    if (!element) {
      const active = this.store.getActiveReview();
      return [
        active
          ? { kind: "activeReview", review: active }
          : { kind: "emptyActive" },
        { kind: "pastSection" },
      ];
    }
    switch (element.kind) {
      case "activeReview":
        return this.commentNodes(element.review);
      case "pastSection": {
        const past = this.store.listPastReviews();
        return past.length
          ? past.map((review) => ({ kind: "pastReview", review }) as const)
          : [{ kind: "emptyPast" }];
      }
      case "pastReview":
        return this.commentNodes(element.review);
      default:
        return [];
    }
  }

  private commentNodes(review: Review): ReviewsTreeNode[] {
    return review.comments.map((comment) => ({
      kind: "comment",
      review,
      comment,
    }));
  }

  getTreeItem(element: ReviewsTreeNode): vscode.TreeItem {
    switch (element.kind) {
      case "activeReview": {
        const item = new vscode.TreeItem(
          `Active review — ${formatReviewLabel(element.review)}`,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.contextValue = "activeReview";
        item.iconPath = new vscode.ThemeIcon("comment-discussion");
        return item;
      }
      case "emptyActive": {
        const item = new vscode.TreeItem("No active review yet");
        item.description = "add a comment in any editor to start one";
        return item;
      }
      case "pastSection": {
        const count = this.store.listPastReviews().length;
        const item = new vscode.TreeItem(
          `Past reviews (${count})`,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.contextValue = "pastSection";
        return item;
      }
      case "emptyPast": {
        return new vscode.TreeItem("No past reviews");
      }
      case "pastReview": {
        const item = new vscode.TreeItem(
          formatReviewLabel(element.review),
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.contextValue = "pastReview";
        item.iconPath = new vscode.ThemeIcon("history");
        return item;
      }
      case "comment": {
        const { comment } = element;
        const label = `${comment.path} — ${lineLabel(comment)} — ${excerptComment(comment.text)}`;
        const item = new vscode.TreeItem(label);
        item.contextValue = comment.shortSha ? "commentAtRevision" : "comment";
        item.iconPath = new vscode.ThemeIcon("note");
        item.command = {
          command: "vscode-reviews.openComment",
          title: "Open",
          arguments: [comment],
        };
        return item;
      }
    }
  }
}
