---
name: release-notes
description: Write or update the GitHub release notes for a diagrid-dev-dashboard release in the project's house format (intro paragraph, "What's new" with emoji-headed sections, fixed "Install & run" block). Use this whenever the user asks to write, draft, update, rewrite or fix release notes or a changelog for a dev-dashboard release, mentions a tag like v0.0.27, says "the latest release", or wants GoReleaser's auto-generated commit list replaced with readable notes — even if they don't say "skill" or name the format.
---

# Release notes for diagrid-dev-dashboard

GoReleaser publishes each release (`scripts/release.sh vX.Y.Z` → tag → `.github/workflows/release.yaml`)
with an auto-generated list of commits. That list is unreadable for users, so the notes are rewritten
by hand into a fixed house format. This skill produces those notes and publishes them.

The format has stayed the same since v0.0.23. The **previous release's notes are the source of
truth**: copy their structure, intro wording and Install & run block, and change only what this
release changed. `references/template.md` has the format as a fallback and the section vocabulary.

## Workflow

### 1. Find the target release and the previous one

```sh
gh release list --limit 5
```

The target is the release the user named, or the one marked `Latest`. The previous release is the next
one down the list. Read both bodies:

```sh
gh release view vPREV --json body --jq .body > <scratch>/vPREV.md
gh release view vTARGET --json body --jq .body > <scratch>/vTARGET-original.md   # backup before editing
```

Keep the backup: publishing replaces the body, and the user may want the original back.

### 2. Work out what is actually in the release

Release tags point at a **detached** commit that `scripts/release.sh` adds on top of `main` (it
embeds the prebuilt `web/dist`). So the range between two tags is main's history plus one release
commit. List the first-parent history to see which PRs landed:

```sh
git fetch -q --tags
git log --first-parent --format='%h %s' vPREV..vTARGET
```

Ignore the `release vX.Y.Z (embed built SPA for go install)` commit. For each merged PR, read what it
does for users: `gh pr view <N> --json title,body`. PR bodies and `git log vPREV^..vTARGET^ --format='%s'`
(the non-first-parent commits) give the detail; the release notes describe the **outcome**, not the
commits.

Check dependency, image and CI changes between the two release parents. These feed the 📦
Dependencies and 🧪 Testing sections, and are easy to miss when reading PR titles:

```sh
git diff --stat vPREV^ vTARGET^ -- go.mod web/package.json Dockerfile '**/go.mod' .github/workflows
git diff vPREV^ vTARGET^ -- go.mod web/package.json Dockerfile   # versions: old → new
```

Dependabot PRs ("build(deps): bump …") belong in 📦 Dependencies. Only list changes that are in this
range — if nothing changed in a category, leave its section out.

### 3. Write the notes

Follow the previous release's structure exactly (see `references/template.md`):

1. `## Diagrid Dapr Dev Dashboard`
2. The intro paragraph: the fixed first sentence, then **one sentence summarising this release**,
   then the Konami line. Copy the fixed parts word for word from the previous release.
   - Feature release: "In `vX.Y.Z` <the headline changes, in plain words>."
   - Maintenance release: "`vX.Y.Z` is a maintenance release: <what it tidies or updates>."
3. `### What's new`, with one bold emoji-headed section per topic:
   - **Feature sections first**, biggest first, each with its own fitting emoji and a title that names
     the feature (e.g. `**🐳 Run the dashboard inside Docker Compose**`).
   - Then the standard sections, in this order, only when they have content: 🎨 UI, 🚀 Startup,
     🔒 Security, 🐛 Fixes, 📈 Telemetry, 📚 Docs, 🧪 Testing, 📦 Dependencies.
4. `### Install & run`: copy the previous release's block **verbatim**, changing only the version
   (`@vX.Y.Z` for `go install`, `:X.Y.Z` without the `v` for the container image). If the install
   instructions changed in this release, update them here as well.

Writing rules — these are what make the notes useful to someone deciding whether to upgrade:

- Write for users of the dashboard, not for reviewers of the code. Say what they can now do or what
  stopped going wrong ("The Workflows page no longer says **No state store detected** when…"), not which
  function changed. No commit hashes, PR numbers or internal type names.
- Bold UI labels and page names (**Workflows**, **App Detail**); put flags, env vars, file names,
  commands and versions in backticks (`--mode compose`, `DEVDASHBOARD_MODE`).
- One idea per bullet, full sentences, plain words. Group related bullets under one section rather than
  making many one-bullet sections.
- Call out behaviour changes users might trip over (something that used to happen and no longer does).
- Dependencies use `name old → new`, grouped by Go / Web / image / CI, as in earlier releases.

### 4. Verify before publishing

- The install block matches the previous release except for the version:
  ```sh
  diff <(sed -n '/^### Install & run/,$p' vPREV.md | sed 's/PREV_VERSION/X/g') \
       <(sed -n '/^### Install & run/,$p' vTARGET.md | sed 's/TARGET_VERSION/X/g')
  ```
- The archives are attached (`gh release view vTARGET --json assets --jq '.assets[].name'`: five
  archives plus `checksums.txt`), and the image exists:
  `docker manifest inspect ghcr.io/diagridio/dev-dashboard:X.Y.Z`. If either is missing, tell the user
  rather than publishing notes that point at it.
- Every claim in the notes maps to a change in the range from step 2.

### 5. Publish and confirm

Publishing edits a public release, so only do it when the user asked for the notes to be updated
(drafting alone is not a request to publish). Then:

```sh
gh release edit vTARGET --notes-file <scratch>/vTARGET.md
gh release view vTARGET --json url,body --jq '.url'
diff <(gh release view vTARGET --json body --jq .body) <scratch>/vTARGET.md   # only a trailing newline may differ
```

`gh release view --json` has no `isLatest` field; use `gh release list --limit 1` to confirm which
release is marked Latest.

Report to the user: the release URL, the sections the notes contain and why (e.g. "no 📦 Dependencies:
nothing changed"), anything new compared with the previous format, and where the backup of the original
body is saved.
