# Working in this repo

This repo holds the shared GitHub Actions, reusable workflows and workflow
templates that every Cru app builds and deploys with. A change here reaches
every app that pins `@v2` as soon as it is released, so treat each change as a
fleet-wide change.

These rules are for anyone changing the repo, people and coding agents alike.

## This repo is public

Anyone can read the code, the commits, the pull requests and the issues. Some
workflows have to name real accounts and roles to work. Beyond what the code
needs to run, keep internal detail out of all of them, and don't add new
examples of it:

- No internal app or service names, internal hostnames, account IDs, ARNs,
  work-item keys, ticket links, people's names or handles, or chat channels.
- New test fixtures use made-up names and hosts, like `example-app` and
  `000000000000`. Never copy real names from a log or an error into a test.
- Say why a change is needed in general terms ("a function with a published
  version", not "the checkout app's lambda").
- Before you push, read your own diff and the pull request text for anything on
  this list.

## Pull requests

- **Coding agents may push branches and open pull requests without asking
  first.** Merging is the part that needs a person.
- **Every pull request a person or a coding agent opens needs a human review
  and approval.** Never merge your own pull request, never turn on auto-merge
  for it, and never push straight to `main`. (Dependabot's updates follow
  `dependabot-auto-merge.yml` instead.)
- **Run an adversarial review before you open the pull request.** Have someone,
  or a separate agent with no stake in the change, try to break it: wrong
  inputs, AWS or GCP calls that fail halfway, retries, a caller still on an old
  version, a rollback after a failed deploy. Fix what holds up, and say in the
  pull request what was checked and what was left alone on purpose.
- Keep `dist/` out of pull requests. A bot rebuilds it on `main` after every
  merge (`build-dist.yml`).
- Don't edit `CHANGELOG.md` or the version in `package.json`. release-please
  writes both.
- Don't add a "Test Plan" section to the pull request description.

## Commits

Commit messages follow Conventional Commits, because release-please reads them
to pick the next version and write the changelog. Pull requests are squashed
when they merge, so the pull request title becomes that commit: write it the
same way.

- `feat:` adds something callers can use (minor release).
- `fix:` changes behavior to fix a bug (patch release).
- `test:`, `docs:`, `chore:`, `ci:` and `build:` don't cut a release on their
  own.
- Add a scope when it helps, like `fix(v2):` or `feat(ecs):`.
- A breaking change (`feat!:` or a `BREAKING CHANGE:` footer) releases a new
  major version, `v3`. Apps pinned to `@v2` stay where they are and stop getting
  updates until each one moves. Don't make one without a plan agreed with the
  maintainers.

## Keep old callers working

Apps pin `@v2`, and the roll-tags job moves `v2` and `v2.x` to each new
release. So:

- A new input needs a default that keeps today's behavior.
- Don't rename or remove an input, an output or an environment variable that a
  caller might set or read.
- When a change needs a new cloud permission, the code must still work, or fail
  with a clear message, for an app whose role doesn't have it yet. Roles live in
  other repos and change on their own schedule.

## Checks

Use the Node version in `.tool-versions`. Before you push, run:

```shell
npm ci
npm run lint
npm run build
npm test
```

CI runs the same three. `npm run build` writes `dist/`; don't commit it.

## Code style

- Match the style of the file you are in. Most of the v2 code uses no
  semicolons and a space before a function's parentheses, `function name
  (args)`. Lint doesn't check style, so this is on you.
- Comments say why, not what. The deploy code explains its failure handling in
  plain sentences, because the person reading it is often in the middle of a
  failed deploy.
- Tests use vitest, and mock the cloud calls in `src/aws.js`, `src/v2/aws.js`,
  `src/gcp.js` and `src/v2/gcp.js` rather than calling AWS or GCP.
