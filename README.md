# Reviews

Line-anchored review comments in any editor, kept together as one review and
exported to the clipboard as an AI-agent prompt.

## What it does

Reviewing a diff or reading code produces observations that usually go
nowhere. This extension lets you jot a comment on any line, in any editor —
a GitLens diff, a native diff view, or a plain file — and collects them into
a single **active review** you can copy as a prompt for an AI agent.

## The three gestures

1. **Comment in any editor or diff.** Hover a line's gutter, click `+`,
   type. Comments accumulate into the active review automatically — no
   start/stop ceremony. In a diff view, comment on the new (right-hand) side
   only. Edit and delete a comment from its inline widget.
2. **Navigate from the sidebar.** The Reviews icon in the activity bar opens
   a tree: the active review's comments on top, past reviews below,
   collapsed, each expandable to its own comment list. Clicking a comment
   made on a committed diff version opens a diff of that file between the
   commit's parent and the commit, with the cursor on the commented line
   (against an empty left side when the file was added in that commit).
   Right-click it for **Open File at Revision** (the file as of that commit,
   read-only) or **Open Current File** (the working-tree file, at the
   stored — possibly since-drifted — line). A comment made on a plain file
   (no revision) just opens that file. Right-click (or use the inline icons)
   for Copy Prompt, New Review, Delete Review, Edit Comment, Delete Comment.
3. **Copy prompt.** Run "Reviews: Copy prompt" (command palette, view title
   bar, or a review's context menu) to copy that review as plain text —
   `path:line` (or `path:start-end`, with `@shortsha` for a comment made on a
   committed diff version) followed by the comment text, entries separated
   by `---`.

If the active review has been idle past the configured timeout, adding a new
comment asks whether to continue it or start fresh; the answer is remembered
for the same duration.

## Review cursor

A lightweight git tag `rv/<branch>` (e.g. `rv/eugene/foo` for branch
`eugene/foo`) marks the last commit you reviewed on the branch checked out in
the repo. GitLens shows tags in front of commit messages, so the tag is the
visible cursor.

- **Mark reviewed** — right-click a commit in any GitLens commit view, or use
  the ✓ button in the Reviews view title bar to mark the current branch's
  `HEAD` in the workspace repo. Runs
  `git tag -f rv/<branch> <sha>`.
- **Resync review cursor** — the sync button in the Reviews view title bar.
  After a rebase, the tagged commit is no longer in `HEAD`'s history; resync
  finds the commit in `rv/<branch>..HEAD` with the same `git patch-id
  --stable` and moves the tag there. Nothing runs automatically.

Detached `HEAD` is refused. Caveats: `git push --tags` publishes `rv/` tags
too; resync only finds the commit when its own diff is unchanged (a conflict
resolution or squash into it means re-marking manually).

## Review guide

Run `/prepare-review` in your agent: it reads every commit since your review
cursor (or since `main`) and writes a guide. The **Guide** view then walks the
branch commit by commit:

- commits are listed newest first; each commit's files are grouped by tier —
  🔴 critical, 🟡 review, ⚪ skim, and a collapsed skip for generated files —
  and by topic when the commit touches several concerns, in reading order, the
  first marked **★ start here**. The view title button switches between
  tier → topic and topic → tier; topics are left out when a commit has only one. Groups
  show a short hint from the agent on what to look for;
- each file's reason sits on a row under it; a title button puts it back on
  the file's row;
- hover a commit for the agent's summary and flags (⚑);
- click a file for its diff in that commit; the multi-diff button on a commit
  or tier opens its files in one scrolling diff;
- the agent's line notes appear in the diff as "Guide" comments; **Add to
  Review** turns one into a regular review comment; the eye button in the
  view title hides or shows them;
- check files as you go (`ctrl+alt+r` toggles the file selected in the view,
  or the one in the focused diff); checking a commit's last file offers **Mark
  reviewed**, which moves the review cursor. Reviewed commits are dimmed, the
  cursor commit carries a green bookmark.

After a rebase, commits are re-found by patch-id; a commit that changed shows
as stale until you re-run `/prepare-review`.

## Settings

- `vscode-reviews.guideGrouping` (default `tierThenTopic`) — how the Guide
  view nests a commit's files: `tierThenTopic` or `topicThenTier`.
- `vscode-reviews.guideNotesInline` (default `true`) — show the Guide's line
  notes as comment threads in diffs.
- `vscode-reviews.guideFileReason` (default `secondLine`) — show each file's
  reason on a row under it, or `inline` after its path.
- `vscode-reviews.idleTimeoutMinutes` (default `60`) — minutes of inactivity
  before a new comment triggers the continue/new-review prompt.

VS Code itself auto-opens the built-in Comments panel the first time you add
a comment (the `comments.openView` setting, default `firstFile`). This
extension doesn't change that behavior; if you don't want it, set
`"comments.openView": "never"` in your own settings.

## Running it

```
npm install
npm run compile
```

Then press `F5` in VS Code to launch an Extension Development Host with the
extension loaded.

Run the unit tests (pure core logic — review lifecycle, prompt formatting,
URI parsing) with:

```
npm test
```

## Packaging

```
npx @vscode/vsce package
```

Produces a `.vsix` you can install via "Extensions: Install from VSIX...".
