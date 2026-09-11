# CORS Shared GitHub Workflows

Reusable GitHub Actions workflows for CORS Pimcore projects and bundles.

**Replaces:** `.project-gitlab-ci.yml`, `.bundle-gitlab-ci.yml`

## Workflows

| Workflow | Replaces (GitLab) | Description |
|---|---|---|
| `project-ci.yaml` | `.project-gitlab-ci.yml` include | Test → Build → Manifest für Pimcore-Projekte in einem Aufruf. Der Caller `ci.yaml` ist in allen Projekt-Repos identisch (File-Sync); Registry-Pfad und Manifest-Repo werden aus dem Repo-Namen abgeleitet, Overrides per Repo-Variablen `GCP_REGISTRY_PATH`, `CD_REPO`, `NGINX_VERSION` |
| `php-test.yaml` | `test` stage (project + bundle) | ECS, PHPStan, Psalm, Twig/YAML/Container lint, Helm lint |
| `containerize.yaml` | `build_and_push` stage | Multi-target Docker build, GHCR or GCP registry |
| `update-manifest.yaml` | `update_manifest` stage | CD repo update via yq or helm template (GitOps) |
| `frontend-build.yaml` | — | Build Pimcore Studio frontend (Rsbuild), type-check, commit assets |
| `pr-guardrail.yml` | — | PR guardrails: branch/issue conventions, description, CI state ([docs](docs/GUARDRAILS.md)) |
| `pr-to-project.yml` | — | Add PRs to the Projects-V2 boards of their linked issues |
| `sync-files.yml` | — | Lebt in [`shared-workflows-private`](https://github.com/cors-gmbh/shared-workflows-private): verteilt Guardrail-Caller, PR-Template, CI-Caller (`ci.yaml`) und Dependency-Update-Caller in die Org-Repos (Konfiguration und Templates dort — die Repo-Liste bleibt privat) |

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
to the release branch (`commit: true`, the default).

The Studio bundle repos do not write this caller themselves: the file sync in
`shared-workflows-private` distributes one `frontend-build.yaml` to every repo of
the Studio bundle group. That caller fits every layout because the workflow
resolves the npm project directory itself (`working-directory`: repository root
or `assets/`) and stages the build archives with the default pathspec
`*build-dist/*`. A repo only has to provide `npm run build` that produces
`Resources/build-dist/build-<id>.zip` (see below).

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
- **Prefer the build archive model.** Since `@pimcore/studio-ui-bundle` 2026.2
  (and 2025.4.12) Pimcore ships `studio-package-build`, which packages a build
  directory carrying a `.build-id` file into `Resources/build-dist/build-<id>.zip`
  and keeps the archive of an unchanged id untouched. The expanded build under
  `Resources/public/studio` stays gitignored and is extracted at cache warmup
  by Pimcore's `BuildArchiveExtractor`: the bundle's `WebpackEntryPointProvider`
  implements `BuildArchiveProviderInterface` through `BuildArchiveExtractionTrait`
  and points at the archive glob and the target directory. With that model the
  repository tracks one small zip per bundle instead of hundreds of asset files,
  and this workflow commits only when a build id actually changed. Call it with
  `file-pattern: 'src/Resources/build-dist/*'` (a git pathspec — `*` also
  matches `/`, so a monorepo can pass `bundles/*/Resources/build-dist/*`) and
  list only the Studio sources and the build configuration under `paths` of the
  `push` trigger, so the archive commit never starts another run. Reference:
  [cors-gmbh/pimcore-legacy-bundles](https://github.com/cors-gmbh/pimcore-legacy-bundles)
  and the CoreShop bundles.
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

## Migration scripts

`scripts/migrations/` holds one-off migrations that are applied per project repo and open a PR there.

### `pimcore-docker-10.py` — pimcore-docker 9.x → 10.x

pimcore-docker 10.0 ships one `pimcore` image instead of php-fpm / php-cli / php-supervisord /
php-fpm-blackfire, and pimcore-chart ≥ 6.1 runs the messenger consumers as one Deployment per queue
group. The script rewrites a project and its manifest repo accordingly (Dockerfile stages, `.env`,
`supervisord.conf`, `Chart.yaml`, `values*.yaml`) and generates `consumers.workers` from the project's
`.docker/supervisord.conf`. Line based, dry run by default, refuses to write when the project is on a
PHP version 10.x does not ship.

```sh
scripts/migrations/pimcore-docker-10.py ../bellaflora --manifest ../bellaflora-manifest            # dry run
scripts/migrations/pimcore-docker-10.py ../bellaflora --manifest ../bellaflora-manifest --write
```

Anything that does not match the skeleton layout is listed under `MANUAL` instead of being guessed.
Merge the manifest PR first (chart 6.1 works with the old image), then the project PR on `staging`.

## Repo access

For **private** repos calling these workflows, enable access in this repo:

Settings → Actions → General → Access → "Accessible from repositories in the `cors-gmbh` organization"

No GitHub Teams plan required.

## Examples

See `examples/` for complete caller workflow files:

- `project-ci.yaml` — Standard Pimcore project (GHCR)
- `project-ci-gcp.yaml` — Pimcore project with GCP Artifact Registry
- `bundle-ci.yaml` — Pimcore bundle (test only)
