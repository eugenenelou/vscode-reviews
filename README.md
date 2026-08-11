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
   commit's parent and the commit, with the cursor on the commented line —
   or just the file at that revision when it was added in that commit and
   there is no earlier version to diff against. Right-click it for **Open File at Revision** (the file as of that commit,
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

## Settings

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
