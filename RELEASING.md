# Releasing

This SDK is published to **npm** as [`lago-agent-sdk`](https://www.npmjs.com/package/lago-agent-sdk) — an unscoped package, matching Lago's other public SDKs (`lago-javascript-client`, `lago-nodejs-client`) and the Python package name.

Releases are triggered by pushing a `v*.*.*` git tag. The publish workflow:

1. Runs the full CI gate (typecheck, lint, format, tests, build)
2. Verifies the tag's version matches `package.json`
3. Packs a tarball for verification
4. Publishes to npm with **OIDC trusted publishing** + sigstore **provenance** attestation
5. Creates a GitHub Release with auto-generated notes + the tarball

## One-time setup (already done — for reference)

Configure the trusted publisher on npm:
**Package settings → Configure trusted publishing**

| Field | Value |
| --- | --- |
| GitHub Owner | `getlago` |
| Repository name | `lago-agent-sdk-js` |
| Workflow filename | `publish.yml` |
| Environment name | `npm` |

Then in this repo: **Settings → Environments → New environment** named `npm`. (No secrets needed inside it — OIDC handles auth.)

### Environment protection (required before first release)

Trusted publishing is bound to the `npm` environment, so that environment is the **only** thing standing between a pushed tag and a live npm release. A freshly created environment has **no** protection rules by default — until you add them, any successful run publishes immediately. Treat this as a mandatory setup step, not an optional one. Configure it under **Settings → Environments → npm**:

| Rule | Setting | Why |
| --- | --- | --- |
| Required reviewers | Add 1+ maintainers | The publish job pauses for human approval before it can mint the OIDC token and upload — a second pair of eyes on every release. |
| Deployment branches and tags | **Selected** → add a `v*.*.*` tag rule | Only protected version tags can deploy to `npm`; a random branch push or arbitrary tag can't trigger a publish. |

With these in place, the `test` and `build` jobs still run on any matching tag, but the `publish` job blocks until an approver signs off, and only for `v*.*.*` tags.

The workflow itself is hardened in depth, so a misconfigured environment alone can't publish from the wrong place:
- Least-privilege `permissions: contents: read` default — only `publish` gets `id-token: write`, only `release` gets `contents: write`.
- Every third-party action pinned to a full commit SHA so a re-pointed tag can't inject code into the token-minting job (kept fresh by `.github/dependabot.yml`).
- The `publish` job carries `if: startsWith(github.ref, 'refs/tags/v')`, so even without the environment rule it refuses to run on a non-tag ref.
- `publish` builds from source (`npm ci` from the committed lockfile + `npm run build`) and runs `npm publish --provenance`. npm provenance is bound to the build, so it can't be attached to a pre-packed tarball — the package must be built in the publishing job. The reinstall is reproducible (pinned lockfile) and the job runs only on a `v*.*.*` tag behind the approval gate.

The `--provenance` flag attaches a signed sigstore attestation that ties the published artifact to this exact GitHub Actions run/commit — visible as the "Built and signed on GitHub Actions" badge on the npm package page.

## Cutting a release

Replace `X.Y.Z` below with the version you're releasing.

```bash
# 1. Update the version
$EDITOR package.json                # bump the "version" field to X.Y.Z
# (or: npm version X.Y.Z --no-git-tag-version)
$EDITOR CHANGELOG.md                # add release notes under a new heading

# 2. Commit + push
git commit -am "Release X.Y.Z"
git push

# 3. Tag and push the tag — this triggers the publish workflow
git tag vX.Y.Z
git push --tags
```

Within ~5 minutes the workflow lands the package on npm and opens a GitHub Release. Customers can then:

```bash
npm install lago-agent-sdk@X.Y.Z
```

## If something goes wrong mid-release

- **CI fails before build:** fix the failure, delete the tag, retag, push.
  ```bash
  git tag -d vX.Y.Z
  git push --delete origin vX.Y.Z
  # fix the issue, recommit
  git tag vX.Y.Z
  git push --tags
  ```
- **Build succeeds but npm publish fails:** re-running the workflow from the GitHub Actions UI is safe.
- **A bad version is already on npm:** npm allows `npm unpublish` within 72 hours of publish. After that, you must release a fresh patch version (`v0.2.1`). Don't publish breaking changes under a patch.

## Versioning policy

Pre-1.0 we follow `0.<minor>.<patch>` where:
- `<minor>` bumps for new features or breaking changes (we're in 0.x — breakages are allowed but documented in `CHANGELOG.md`).
- `<patch>` bumps for fixes only.

Post-1.0 we follow strict [semver](https://semver.org).
