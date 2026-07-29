# CORS Shared GitHub Workflows

Reusable GitHub Actions workflows for CORS Pimcore projects and bundles.

**Replaces:** `.project-gitlab-ci.yml`, `.bundle-gitlab-ci.yml`

## Workflows

| Workflow | Replaces (GitLab) | Description |
|---|---|---|
| `php-test.yaml` | `test` stage (project + bundle) | ECS, PHPStan, Psalm, Twig/YAML/Container lint, Helm lint |
| `containerize.yaml` | `build_and_push` stage | Multi-target Docker build, GHCR or GCP registry |
| `update-manifest.yaml` | `update_manifest` stage | CD repo update via yq or helm template (GitOps) |
| `frontend-build.yaml` | — | Build Pimcore Studio frontend (Rsbuild), type-check, commit assets |

## Quick Start

### Project repo (`.github/workflows/ci.yaml`)

```yaml
name: CI/CD

on:
  push:
    branches: [staging, master]
  pull_request:
    branches: [staging, master]

jobs:
  test:
    uses: cors-gmbh/shared-workflows/.github/workflows/php-test.yaml@main
    with:
      php-version: "8.3"
      phpstan: true
    secrets:
      composer_auth: ${{ secrets.COMPOSER_AUTH }}

  build:
    needs: test
    if: github.event_name == 'push'
    uses: cors-gmbh/shared-workflows/.github/workflows/containerize.yaml@main
    with:
      container-tag: ${{ github.ref_name }}-${{ github.sha }}
      app-env: ${{ github.ref_name == 'master' && 'prod' || 'staging' }}
      push-latest: true
      branch-name: ${{ github.ref_name }}
    secrets:
      composer_auth: ${{ secrets.COMPOSER_AUTH }}

  manifest:
    needs: build
    uses: cors-gmbh/shared-workflows/.github/workflows/update-manifest.yaml@main
    with:
      container-tag: ${{ github.ref_name }}-${{ github.sha }}
      cd-repo: my-project-manifest
      cd-repo-branch: ${{ github.ref_name }}
    secrets:
      cd_push_token: ${{ secrets.CD_PUSH_TOKEN }}
```

### Bundle repo (`.github/workflows/ci.yaml`)

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    uses: cors-gmbh/shared-workflows/.github/workflows/php-test.yaml@main
    with:
      php-version: "8.4"
      pimcore: false
      psalm: true
    secrets:
      composer_auth: ${{ secrets.COMPOSER_AUTH }}
```

### Studio frontend build (`.github/workflows/frontend-build.yaml`)

For bundles that ship a compiled Pimcore Studio frontend. Type-checks and builds
the frontend, and commits the produced public assets back to the release branch.

Call it twice: pull requests verify only (`commit: false`), so their diffs stay
limited to the actual source changes, and the assets are committed once per push
to the release branch (`commit: true`).

```yaml
name: Studio Frontend Build

on:
  pull_request:
    branches: [main]
  # `paths-ignore` keeps the asset commit from triggering another (no-op) build
  push:
    branches: [main]
    paths-ignore:
      - 'src/Resources/public/studio/build/**'
  workflow_dispatch:

permissions:
  contents: read

jobs:
  # Gating on `push` rather than on "not a pull request" keeps a manual run on a
  # feature branch from committing assets to that branch.
  verify:
    if: ${{ github.event_name != 'push' }}
    permissions:
      contents: read
    uses: cors-gmbh/shared-workflows/.github/workflows/frontend-build.yaml@main
    with:
      commit: false
      file-pattern: 'src/Resources/public/studio/build/*'

  build:
    if: ${{ github.event_name == 'push' }}
    permissions:
      contents: write
    uses: cors-gmbh/shared-workflows/.github/workflows/frontend-build.yaml@main
    with:
      commit: true
      file-pattern: 'src/Resources/public/studio/build/*'
    secrets:
      gh_app_id: ${{ secrets.GH_APP_ID }}
      gh_app_private_key: ${{ secrets.GH_APP_PRIVATE_KEY }}
```

Two things the consuming repo has to get right:

- **Build id from the sources.** The build has to derive its output directory
  from a hash of the sources, not from a random uuid — otherwise every run
  rewrites every asset path and commits a diff that contains no real change.
- **Push access to the release branch.** Where a ruleset requires pull requests,
  `GITHUB_TOKEN` cannot push. Passing `gh_app_id`/`gh_app_private_key` (the CORS
  CD Bot) makes the commit with the app's installation token instead; the app is
  a bypass actor on those rulesets. Without them the job falls back to the default
  token and fails loudly if the push is refused.

## Migration from GitLab

### Variable mapping

| GitLab Variable | GitHub Input | Default |
|---|---|---|
| `PHP_VERSION` | `php-version` | `8.4` |
| `DOCKER_BASE_VERSION` | `docker-base-version` | — |
| `NGINX_VERSION` | `nginx-version` | — |
| `ALPINE_VERSION` | `alpine-version` | — |
| `APP_ENV` | `app-env` | `staging` |
| `PROD_BRANCH` / `STAGING_BRANCH` | Use `github.ref_name` in caller | — |
| `TEST_PHPSTAN` | `phpstan` | `false` |
| `TEST_PSALM` | `psalm` | `false` |
| `TEST_LINT_TWIG` | `lint-twig` | `true` |
| `TEST_LINT_YAML` | `lint-yaml` | `true` |
| `TEST_LINT_CONTAINER` | `lint-container` | `true` |
| `GCP_URL` / `REGISTRY_URL` | `gcp-registry-url` / `gcp-registry-path` | GHCR by default |
| `CD_CHART_REPO` | `cd-repo` | — |
| `COMPOSER_AUTH` | `secrets.composer_auth` | — |
| `GOOGLE_ARTIFACT_REGISTRY` | `secrets.gcp_credentials` | — |
| `CD_PUSH_TOKEN` | `secrets.cd_push_token` | — |

### Migration steps

1. Create `.github/workflows/ci.yaml` in your project using the examples
2. Set required secrets in GitHub repo settings (Settings → Secrets → Actions)
3. Remove the GitLab CI include from `.gitlab-ci.yml`
4. If using GCP registry: set `registry: gcp` and pass `gcp_credentials`
5. If migrating to GHCR: set `registry: ghcr` (default), no extra credentials needed

### Secrets to configure

**All projects:**
- `COMPOSER_AUTH` — Composer auth.json for private packages

**Projects with GCP registry:**
- `GOOGLE_ARTIFACT_REGISTRY` — Base64-encoded GCP service account key

**Projects with manifest update:**
- `CD_PUSH_TOKEN` — PAT with write access to the CD/manifest repo
- OR: configure a GitHub App and set `GH_APP_ID` (variable) + `GH_APP_PRIVATE_KEY` (secret)

## Repo access

For **private** repos calling these workflows, enable access in this repo:

Settings → Actions → General → Access → "Accessible from repositories in the `cors-gmbh` organization"

No GitHub Teams plan required.

## Examples

See `examples/` for complete caller workflow files:

- `project-ci.yaml` — Standard Pimcore project (GHCR)
- `project-ci-gcp.yaml` — Pimcore project with GCP Artifact Registry
- `bundle-ci.yaml` — Pimcore bundle (test only)
