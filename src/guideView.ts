import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import {
  commitProgress,
  commitReviewState,
  fileKey,
  groupFiles,
  latestGuideFor,
  matchGuideCommits,
  noteKey,
  parseGuide,
  type CommitReviewState,
  type GuideEntry,
  type Grouping,
  type Guide,
  type GuideCommit,
  type GuideFile,
  type GuideNote,
  type Tier,
} from "./core/guide";
import { parseLocation } from "./core/location";
import type { NewCommentInput } from "./core/store";
import { branchHistory, currentBranch, cursorSha } from "./cursor";
import { commitDiffSides, diffTitle } from "./diff";
import { isDiffOriginalSide } from "./reviews";

const CHECKED_KEY = "vscode-reviews.guide.checked";
const PROMOTED_KEY = "vscode-reviews.guide.promoted";
const DECORATION_SCHEME = "vscode-reviews-guide";

export interface GuideSnapshot {
  guide: Guide;
  /** Each guide commit's sha on the branch now; undefined when stale. */
  current: Map<GuideCommit, string | undefined>;
  orderedShas: string[];
  cursor: string | undefined;
}

type GuideLoad =
  | { kind: "message"; text: string; detail?: string }
  | { kind: "ok"; snapshot: GuideSnapshot; invalid: string[] };

/** Loads the current branch's newest guide and owns the per-workspace checked/promoted sets. */
export class GuideState {
  private load: GuideLoad = { kind: "message", text: "Loading…" };
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(
    readonly guidesDir: string,
    private readonly cwd: string,
    private readonly memento: vscode.Memento,
  ) {
    mkdirSync(guidesDir, { recursive: true });
  }

  get current(): GuideLoad {
    return this.load;
  }

  get snapshot(): GuideSnapshot | undefined {
    return this.load.kind === "ok" ? this.load.snapshot : undefined;
  }

  reload(): void {
    this.load = this.compute();
    this.emitter.fire();
  }

  private compute(): GuideLoad {
    let branch: string | undefined;
    try {
      branch = currentBranch(this.cwd);
    } catch {
      return { kind: "message", text: "Not a git repository" };
    }
    if (!branch) {
      return { kind: "message", text: "HEAD is detached" };
    }
    const guides: Guide[] = [];
    const invalid: string[] = [];
    const names = existsSync(this.guidesDir)
      ? readdirSync(this.guidesDir).filter((n) => n.endsWith(".json"))
      : [];
    for (const name of names) {
      try {
        const json: unknown = JSON.parse(
          readFileSync(join(this.guidesDir, name), "utf8"),
        );
        guides.push(parseGuide(name.replace(/\.json$/, ""), json));
      } catch (error) {
        invalid.push(
          `${name} — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const guide = latestGuideFor(guides, branch);
    if (!guide) {
      return {
        kind: "message",
        text: `No guide for ${branch}`,
        detail: invalid.length
          ? `invalid guide files: ${invalid.join("; ")}`
          : "run /prepare-review",
      };
    }
    try {
      const history = branchHistory(this.cwd, guide.base);
      return {
        kind: "ok",
        invalid,
        snapshot: {
          guide,
          current: matchGuideCommits(guide.commits, history),
          orderedShas: history.map((c) => c.sha),
          cursor: cursorSha(this.cwd, branch),
        },
      };
    } catch (error) {
      return {
        kind: "message",
        text: "Could not read the branch history",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  reviewState(sha: string): CommitReviewState {
    const snapshot = this.snapshot;
    return snapshot
      ? commitReviewState(sha, snapshot.orderedShas, snapshot.cursor)
      : "unreviewed";
  }

  checked(): Set<string> {
    return new Set(this.memento.get<string[]>(CHECKED_KEY, []));
  }

  async setChecked(keys: { key: string; on: boolean }[]): Promise<void> {
    const checked = this.checked();
    for (const { key, on } of keys) {
      if (on) {
        checked.add(key);
      } else {
        checked.delete(key);
      }
    }
    await this.memento.update(CHECKED_KEY, [...checked]);
    this.emitter.fire();
  }

  isPromoted(key: string): boolean {
    return this.memento.get<string[]>(PROMOTED_KEY, []).includes(key);
  }

  async markPromoted(key: string): Promise<void> {
    await this.memento.update(PROMOTED_KEY, [
      ...this.memento.get<string[]>(PROMOTED_KEY, []),
      key,
    ]);
  }
}

/** The guide file a document shows: that file at a guide commit's revision, never a diff's original side. */
export function guideFileAt(
  snapshot: GuideSnapshot,
  uri: vscode.Uri,
  workspaceRoot: string,
): GuideFileNode | undefined {
  if (
    (uri.scheme !== "git" && uri.scheme !== "gitlens") ||
    isDiffOriginalSide(uri)
  ) {
    return undefined;
  }
  const { relPath, shortSha } = parseLocation(uri.toString(), workspaceRoot);
  if (!shortSha) {
    return undefined;
  }
  for (const commit of snapshot.guide.commits) {
    const sha = snapshot.current.get(commit);
    const file = commit.files.find((f) => f.path === relPath);
    if (sha?.startsWith(shortSha) && file) {
      return { kind: "file", commit, sha, file };
    }
  }
  return undefined;
}

export type GuideFileNode = Extract<GuideTreeNode, { kind: "file" }>;

export type GuideTreeNode =
  | { kind: "message"; text: string; detail?: string }
  | { kind: "commit"; commit: GuideCommit; sha: string | undefined }
  | {
      kind: "group";
      commit: GuideCommit;
      sha: string;
      group: Extract<GuideEntry, { kind: "group" }>;
    }
  | { kind: "file"; commit: GuideCommit; sha: string; file: GuideFile }
  | { kind: "reason"; text: string };

const TIER_STYLE: Record<Tier, { label: string; icon: string; color: string }> =
  {
    critical: { label: "Critical", icon: "circle-filled", color: "charts.red" },
    review: { label: "Review", icon: "circle-filled", color: "charts.yellow" },
    skim: { label: "Skim", icon: "circle-filled", color: "disabledForeground" },
    skip: { label: "Skip", icon: "circle-slash", color: "disabledForeground" },
  };

export function guideGrouping(): Grouping {
  return vscode.workspace
    .getConfiguration("vscode-reviews")
    .get<Grouping>("guideGrouping", "tierThenTopic");
}

export function guideNotesInline(): boolean {
  return vscode.workspace
    .getConfiguration("vscode-reviews")
    .get<boolean>("guideNotesInline", true);
}

/** Whether the file's reason shows as a row under it rather than after its path. */
function reasonOnSecondLine(file: GuideFile): boolean {
  return (
    file.reason !== "" &&
    vscode.workspace
      .getConfiguration("vscode-reviews")
      .get<string>("guideFileReason", "secondLine") === "secondLine"
  );
}

function groupItem(
  group: Extract<GuideEntry, { kind: "group" }>,
): vscode.TreeItem {
  const allSkipped = group.files.every((f) => f.tier === "skip");
  const item = new vscode.TreeItem(
    group.dimension === "tier"
      ? TIER_STYLE[group.key as Tier].label
      : group.key || "Other",
    allSkipped
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.Expanded,
  );
  const count = group.files.length;
  const files = `${count} file${count === 1 ? "" : "s"}`;
  item.description = group.description || files;
  item.tooltip = group.description ? `${group.description} · ${files}` : files;
  if (group.dimension === "tier") {
    const style = TIER_STYLE[group.key as Tier];
    item.iconPath = new vscode.ThemeIcon(
      style.icon,
      new vscode.ThemeColor(style.color),
    );
  } else {
    item.iconPath = new vscode.ThemeIcon("tag");
  }
  item.contextValue = "guideGroup";
  return item;
}

function commitDecorationUri(
  sha: string,
  state: CommitReviewState,
): vscode.Uri {
  return vscode.Uri.from({
    scheme: DECORATION_SCHEME,
    path: `/${sha}`,
    query: state,
  });
}

/** Dims reviewed commits and colors the cursor commit; ThemeIcon colors can't reach the label. */
export const guideDecorations: vscode.FileDecorationProvider = {
  provideFileDecoration(uri) {
    if (uri.scheme !== DECORATION_SCHEME) {
      return undefined;
    }
    if (uri.query === "reviewed") {
      return new vscode.FileDecoration(
        undefined,
        "reviewed",
        new vscode.ThemeColor("disabledForeground"),
      );
    }
    if (uri.query === "cursor") {
      return new vscode.FileDecoration(
        "rv",
        "review cursor",
        new vscode.ThemeColor("charts.green"),
      );
    }
    return undefined;
  },
};

export class GuideTreeProvider implements vscode.TreeDataProvider<GuideTreeNode> {
  private readonly emitter = new vscode.EventEmitter<
    GuideTreeNode | undefined
  >();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly state: GuideState,
    private readonly rootUri: vscode.Uri,
  ) {
    state.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  private entryNodes(
    commit: GuideCommit,
    sha: string,
    entries: GuideEntry[],
  ): GuideTreeNode[] {
    return entries.map((entry) =>
      entry.kind === "group"
        ? { kind: "group", commit, sha, group: entry }
        : { kind: "file", commit, sha, file: entry.file },
    );
  }

  getChildren(element?: GuideTreeNode): GuideTreeNode[] {
    if (!element) {
      const load = this.state.current;
      if (load.kind === "message") {
        return [load];
      }
      const { snapshot, invalid } = load;
      return [
        ...[...snapshot.guide.commits].reverse().map(
          (commit) =>
            ({
              kind: "commit",
              commit,
              sha: snapshot.current.get(commit),
            }) as const,
        ),
        ...invalid.map(
          (text) =>
            ({
              kind: "message",
              text: "Invalid guide file",
              detail: text,
            }) as const,
        ),
      ];
    }
    if (element.kind === "commit" && element.sha) {
      return this.entryNodes(
        element.commit,
        element.sha,
        groupFiles(element.commit, guideGrouping()),
      );
    }
    if (element.kind === "group") {
      return this.entryNodes(
        element.commit,
        element.sha,
        element.group.children,
      );
    }
    if (element.kind === "file" && reasonOnSecondLine(element.file)) {
      return [{ kind: "reason", text: element.file.reason }];
    }
    return [];
  }

  /** The first commit not yet reviewed, which opens expanded. */
  private nextToReview(): GuideCommit | undefined {
    const snapshot = this.state.snapshot;
    return snapshot?.guide.commits.find((c) => {
      const sha = snapshot.current.get(c);
      return sha && this.state.reviewState(sha) === "unreviewed";
    });
  }

  getTreeItem(element: GuideTreeNode): vscode.TreeItem {
    switch (element.kind) {
      case "message": {
        const item = new vscode.TreeItem(element.text);
        item.description = element.detail;
        item.tooltip = element.detail;
        return item;
      }
      case "commit":
        return this.commitItem(element.commit, element.sha);
      case "group":
        return groupItem(element.group);
      case "file":
        return this.fileItem(element.commit, element.sha, element.file);
      case "reason": {
        const item = new vscode.TreeItem("");
        item.description = element.text;
        item.tooltip = element.text;
        return item;
      }
    }
  }

  private commitItem(
    commit: GuideCommit,
    sha: string | undefined,
  ): vscode.TreeItem {
    const item = new vscode.TreeItem(commit.subject);
    const tooltip = new vscode.MarkdownString(
      `**${commit.subject}**\n\n${commit.summary}`,
    );
    for (const flag of commit.flags) {
      tooltip.appendMarkdown(`\n\n⚑ ${flag}`);
    }
    item.tooltip = tooltip;
    const flags = commit.flags.length ? ` · ⚑ ${commit.flags.length}` : "";
    if (!sha) {
      item.description = "stale — re-run /prepare-review";
      item.iconPath = new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("list.warningForeground"),
      );
      item.contextValue = "guideCommitStale";
      return item;
    }
    const state = this.state.reviewState(sha);
    const short = sha.slice(0, 7);
    item.resourceUri = commitDecorationUri(sha, state);
    item.contextValue = "guideCommit";
    item.collapsibleState =
      commit === this.nextToReview()
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
    if (state === "unreviewed") {
      const { done, total } = commitProgress(commit, this.state.checked());
      item.description = `${short} · ${done}/${total}${flags}`;
      item.iconPath = new vscode.ThemeIcon("git-commit");
    } else if (state === "cursor") {
      item.description = `${short} · review cursor${flags}`;
      item.iconPath = new vscode.ThemeIcon(
        "bookmark",
        new vscode.ThemeColor("charts.green"),
      );
    } else {
      item.description = `${short} · reviewed${flags}`;
      item.iconPath = new vscode.ThemeIcon(
        "check",
        new vscode.ThemeColor("disabledForeground"),
      );
    }
    return item;
  }

  private fileItem(
    commit: GuideCommit,
    sha: string,
    file: GuideFile,
  ): vscode.TreeItem {
    const item = new vscode.TreeItem(file.path);
    item.resourceUri = vscode.Uri.joinPath(this.rootUri, file.path);
    item.iconPath = vscode.ThemeIcon.File;
    const notes = file.notes.length
      ? `${file.notes.length} note${file.notes.length === 1 ? "" : "s"}`
      : "";
    const secondLine = reasonOnSecondLine(file);
    item.description = [
      commit.files[0] === file ? "★ start here" : "",
      secondLine ? "" : file.reason,
      notes,
    ]
      .filter(Boolean)
      .join(" · ");
    if (secondLine) {
      item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    }
    item.tooltip = file.reason;
    item.contextValue = "guideFile";
    if (this.state.reviewState(sha) === "unreviewed") {
      item.checkboxState = this.state.checked().has(fileKey(commit, file))
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
    }
    item.command = {
      command: "vscode-reviews.guide.openFile",
      title: "Open diff",
      arguments: [{ kind: "file", commit, sha, file } satisfies GuideTreeNode],
    };
    return item;
  }
}

/** Opens one file's diff in the commit, on its first note's line. */
export async function openGuideFile(
  root: vscode.WorkspaceFolder,
  sha: string,
  file: GuideFile,
): Promise<void> {
  const sides = await commitDiffSides(root, sha, file.path);
  if (!sides) {
    vscode.window.showErrorMessage(
      "Reviews: no Git repository for this workspace.",
    );
    return;
  }
  const line = Math.max((file.notes[0]?.startLine ?? 1) - 1, 0);
  await vscode.commands.executeCommand(
    "vscode.diff",
    sides.left,
    sides.right,
    diffTitle(file.path, sha),
    {
      selection: new vscode.Range(line, 0, line, 0),
    },
  );
}

/** Opens files of the commit as one multi-diff editor, in the given order. */
export async function openMultiDiff(
  root: vscode.WorkspaceFolder,
  sha: string,
  title: string,
  files: GuideFile[],
): Promise<void> {
  const resources: [vscode.Uri, vscode.Uri, vscode.Uri][] = [];
  for (const file of files) {
    const sides = await commitDiffSides(root, sha, file.path);
    if (sides) {
      resources.push([
        vscode.Uri.joinPath(root.uri, file.path),
        sides.left,
        sides.right,
      ]);
    }
  }
  await vscode.commands.executeCommand("vscode.changes", title, resources);
}

/** A read-only guide note; carries what promoting it to a review comment needs. */
export class GuideNoteComment implements vscode.Comment {
  readonly author: vscode.CommentAuthorInformation = { name: "Guide" };
  readonly mode = vscode.CommentMode.Preview;
  readonly contextValue = "guideNote";
  readonly body: vscode.MarkdownString;

  constructor(
    readonly key: string,
    readonly input: NewCommentInput,
  ) {
    this.body = new vscode.MarkdownString(input.text);
  }
}

/** Renders the guide's focus notes as read-only comment threads on the commit's version of each file. */
export class GuideNotes {
  readonly controller = vscode.comments.createCommentController(
    "vscode-reviews-guide",
    "Review guide",
  );
  private threads: vscode.CommentThread[] = [];
  private readonly renderedDocs = new Set<string>();

  constructor(
    private readonly state: GuideState,
    private readonly workspaceRoot: string,
  ) {}

  dispose(): void {
    this.controller.dispose();
  }

  rerender(): void {
    for (const thread of this.threads) {
      thread.dispose();
    }
    this.threads = [];
    this.renderedDocs.clear();
    for (const editor of vscode.window.visibleTextEditors) {
      this.renderDocument(editor.document);
    }
  }

  renderDocument(document: vscode.TextDocument): void {
    if (!guideNotesInline()) {
      return;
    }
    const snapshot = this.state.snapshot;
    const key = document.uri.toString();
    if (!snapshot || this.renderedDocs.has(key)) {
      return;
    }
    const found = guideFileAt(snapshot, document.uri, this.workspaceRoot);
    if (!found) {
      return;
    }
    this.renderedDocs.add(key);
    for (const note of found.file.notes) {
      this.renderNote(
        document.uri,
        found.commit,
        found.file,
        note,
        found.sha.slice(0, 7),
      );
    }
  }

  private renderNote(
    uri: vscode.Uri,
    commit: GuideCommit,
    file: GuideFile,
    note: GuideNote,
    shortSha: string,
  ): void {
    const key = noteKey(commit, file, note);
    if (this.state.isPromoted(key)) {
      return;
    }
    const thread = this.controller.createCommentThread(
      uri,
      new vscode.Range(note.startLine - 1, 0, note.endLine - 1, 0),
      [],
    );
    thread.canReply = false;
    thread.label = "Guide";
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.comments = [
      new GuideNoteComment(key, {
        path: file.path,
        startLine: note.startLine,
        endLine: note.endLine,
        shortSha,
        text: note.text,
      }),
    ];
    this.threads.push(thread);
  }
}
