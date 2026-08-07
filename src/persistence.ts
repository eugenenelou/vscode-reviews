import * as vscode from "vscode";
import type { ReviewStorePersistedState } from "./core/store";

const STORAGE_KEY = "vscode-reviews.state";

export function loadState(
  context: vscode.ExtensionContext,
): ReviewStorePersistedState | undefined {
  return context.workspaceState.get<ReviewStorePersistedState>(STORAGE_KEY);
}

export function saveState(
  context: vscode.ExtensionContext,
  state: ReviewStorePersistedState,
): void {
  void context.workspaceState.update(STORAGE_KEY, state);
}

export function getIdleTimeoutMs(): number {
  const minutes = vscode.workspace
    .getConfiguration("vscode-reviews")
    .get<number>("idleTimeoutMinutes", 60);
  return minutes * 60 * 1000;
}
