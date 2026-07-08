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

For bundles that ship a compiled Pimcore Studio frontend. Type-checks, builds
and commits the produced public assets back to the branch.

```yaml
name: Studio Frontend Build

on:
  push:
    paths:
      - 'bundles/*/Resources/assets/pimcore-studio/**'
      - 'package.json'
      - 'package-lock.json'
      - 'studio-build.ts'
      - 'rsbuild.*.ts'

permissions:
  contents: read

jobs:
  build:
    permissions:
      contents: write
    uses: cors-gmbh/shared-workflows/.github/workflows/frontend-build.yaml@main
    with:
      file-pattern: 'bundles/*/Resources/public/studio/*/**'
      commit-message: "Build Pimcore Legacy Studio bundles [skip ci]"
```

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
