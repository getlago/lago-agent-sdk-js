# Releasing

This SDK is published to **npm** as [`@getlago/agent-sdk`](https://www.npmjs.com/package/@getlago/agent-sdk).

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

The `--provenance` flag in the workflow attaches a signed sigstore attestation that ties the published artifact to this exact GitHub Actions run — visible as a verified badge on the npm package page.

## Cutting a release

```bash
# 1. Update the version
$EDITOR package.json                # bump version, e.g. 0.1.0 -> 0.2.0
# (or: npm version 0.2.0 --no-git-tag-version)
$EDITOR CHANGELOG.md                # add release notes under a new heading

# 2. Commit + push
git commit -am "Release 0.2.0"
git push

# 3. Tag and push the tag — this triggers the publish workflow
git tag v0.2.0
git push --tags
```

Within ~5 minutes the workflow lands the package on npm and opens a GitHub Release. Customers can then:

```bash
npm install @getlago/agent-sdk@0.2.0
```

## If something goes wrong mid-release

- **CI fails before build:** fix the failure, delete the tag, retag, push.
  ```bash
  git tag -d v0.2.0
  git push --delete origin v0.2.0
  # fix the issue, recommit
  git tag v0.2.0
  git push --tags
  ```
- **Build succeeds but npm publish fails:** re-running the workflow from the GitHub Actions UI is safe.
- **A bad version is already on npm:** npm allows `npm unpublish` within 72 hours of publish. After that, you must release a fresh patch version (`v0.2.1`). Don't publish breaking changes under a patch.

## Versioning policy

Pre-1.0 we follow `0.<minor>.<patch>` where:
- `<minor>` bumps for new features or breaking changes (we're in 0.x — breakages are allowed but documented in `CHANGELOG.md`).
- `<patch>` bumps for fixes only.

Post-1.0 we follow strict [semver](https://semver.org).
