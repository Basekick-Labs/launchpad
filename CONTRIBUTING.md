# Contributing to Arc Launchpad

Thanks for your interest in improving Launchpad. Contributions of all sizes are welcome: bug fixes, tests, documentation, and features. This guide explains how to get a change from idea to merged.

## Finding something to work on

- Issues labeled [`good first issue`](https://github.com/Basekick-Labs/launchpad/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) are scoped, well-described, and a good entry point. They name the files to read, point at an existing implementation in the repo to model the work on, and list what they depend on.
- Larger efforts are tracked under an umbrella issue with a checklist — for example [#19](https://github.com/Basekick-Labs/launchpad/issues/19) for dashboarding. Read the umbrella first; it carries the architecture decisions the individual issues assume.
- Most issues include the file, the line, and the intended fix shape. If the shape is unclear, ask on the issue before writing code.
- Comment on an issue when you start working on it, so effort is not duplicated.

## Before you open a PR

1. **One issue per PR.** Reference it in the body (`Closes #123`, or `Refs #123` if your change covers only part of it).

2. **Keep PRs small.** We do not review large PRs. If the change you have in mind is large, split it into a series of smaller PRs that can be reviewed and merged independently. A PR that does one thing well merges fast; a PR that does five things waits.

3. **Add tests.** A bug fix needs a regression test that fails before the fix and passes after it. Pure logic — parsers, SQL builders, validators, formatters — should be covered by unit tests. Deterministic tests are strongly preferred over sleeps and retries.

4. **Verify it against a real flow.** `npm run check` and `npm run build` passing is the floor, not the bar. If your change touches a page or an API route, exercise it and say in the PR body what you ran and what you observed. Reviewers verify claims locally, so a precise description speeds things up.

5. **Match the house style.** Read the surrounding code before introducing a new pattern:
   - This is **Svelte 4** — `export let`, `$:` reactive statements, `createEventDispatcher`. Not runes.
   - Server-only code lives under `src/lib/server/` and is never imported from client code.
   - Use SvelteKit's `RequestHandler` and `Actions` patterns rather than rolling custom HTTP handling.
   - All SQL goes through `better-sqlite3` prepared statements with bound parameters. No string interpolation into SQL, ever.
   - Every API route and `load` function starts with an explicit auth check, and scopes its queries by org. There is no "internal endpoint" exception.
   - Validate input at system boundaries — API handlers, form actions, webhooks. SvelteKit form actions do not validate for you.
   - Helpers used by more than one feature belong in `src/lib/server/util.ts`, not in whichever feature file needed them first.

6. **Write the commit and PR title as a conventional commit.** `feat(dashboards): add the stat panel`, `fix(auth): ...`, `chore(deps): ...`. PRs are squash-merged with the PR title as the commit subject, so the title becomes permanent history. Branch from `main`, named `feat/description` or `fix/description`.

7. **Leave "Allow edits by maintainers" enabled.** We often apply small fixups directly on your branch so your PR can merge without another round trip.

8. **Sign the CLA.** A bot comments on your first PR with a one-line reply to post. Post that sentence as its own comment; the dashed lines the bot draws around it are formatting, not part of the signature. See [Contributor License Agreement](#contributor-license-agreement) below. You sign once, not per PR, and the signature carries across every Basekick Labs repository you open a PR against afterwards.

## AI-assisted contributions

AI patches and contributions are welcome. Two conditions:

- **Be strong on the logic.** You are the author. Understand why the change is correct, what the failure mode was, and what the edge cases are. If a reviewer asks why a line exists, "the tool wrote it" is not an answer.
- **Review it yourself first.** Read the whole diff, run the checks, and cut anything you cannot defend before submitting. We review every PR the same way regardless of how it was written, and unverified AI output wastes the review cycle that could have gone to your next contribution.

The same size rule applies double here: AI tools make it easy to generate large diffs, and we will ask you to split them.

## Security

Do not open a public issue for a security vulnerability. Email **security@basekick.net** instead.

Launchpad holds Arc admin tokens, user credentials, and org membership, and it proxies authenticated requests to Arc instances. Changes near authentication, the instance proxy, SSRF validation, or RBAC get a closer review than the rest of the codebase, and are worth flagging explicitly in your PR description.

## Building and testing

Launchpad is a SvelteKit application on Node 20+.

```sh
npm install
cp .env.example .env        # set LAUNCHPAD_JWT_SECRET at minimum
npm run dev                 # http://localhost:5173

npm run check               # svelte-check + tsc — must pass
npm test                    # unit tests
npm run build               # production bundle — must pass
```

Notes:

- `npm run dev` sets `NODE_TLS_REJECT_UNAUTHORIZED=0` so a local Arc instance with a self-signed certificate works. That is a development convenience and must never be relied on in the application code.
- To point Launchpad at an Arc instance on `localhost` or a private address, set `LAUNCHPAD_ALLOW_PRIVATE_ENDPOINTS=true`. The SSRF guard blocks private endpoints by default, and that default is deliberate.
- Modules importing `$env/dynamic/private` cannot be unit-tested standalone. Test those through the running application.

## Review and merge

- CI must be green. First-time contributors need a maintainer to approve the workflow run; this usually happens at first review.
- Reviews verify claims locally, so precise PR descriptions — what you ran, what you observed — speed things up.
- PRs are squash-merged with the PR title as the commit subject.
- Merged contributions are credited in the GitHub release notes for the version they ship in.

## Contributor License Agreement

Launchpad is licensed under Apache-2.0. Basekick Labs also ships commercially
licensed products in the Arc family, and may license Launchpad itself under
additional terms in future. Including a contribution in those requires your
explicit permission, which is what the [CLA](CLA.md) grants.

In short:

- **You keep ownership of your contribution.** The CLA is a license grant, not a
  copyright assignment. You can use, relicense, or redistribute your own work
  anywhere else, with no restriction.
- **You grant Basekick Labs the right to license your contribution under other
  terms**, including in commercial and closed-source builds.
- **You confirm the work is yours to give** — that it is your original creation,
  and that if your employer owns your work output, you have permission to submit
  it.

Signing takes one comment. On your first PR a bot posts instructions; you reply
with the sign-off line it gives you, and your signature is recorded against your
GitHub username. You will not be asked again on later PRs.

If you cannot sign (for example, your employer will not permit it), say so on the
issue before writing code and we will find another way to get the fix in —
usually by reimplementing it from the described behavior rather than the patch.

Read the full text in [CLA.md](CLA.md).

## And finally

If Launchpad is useful to you, or you just enjoyed contributing, star the repo ;)
