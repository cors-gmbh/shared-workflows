#!/usr/bin/env python3
"""Move a CORS Pimcore project from pimcore-docker 9.x to 10.x.

pimcore-docker 10.0 ships ONE image (`pimcore`) instead of php-fpm, php-cli,
php-supervisord and php-fpm-blackfire. cli, queue workers and the blackfire
probe are selected at container start (command / BLACKFIRE_ENABLED), and the
pimcore-chart >= 6.1 runs the messenger consumers as one Deployment per queue
group (`consumers`) instead of a supervisord pod.

What this script changes

  project repo (required argument)
    Dockerfile               drop the cors_php_supervisord / cors_php_cli /
                             cors_php_blackfire stages, build cors_php from the
                             `pimcore` image, keep the supervisord.conf COPY in
                             cors_php (local supervisord mode still works)
    .env                     DOCKER_BASE_IMAGE=<--base-version>
    .docker/supervisord.conf stopwaitsecs=120 per program (was 10s by default)

  manifest repo (--manifest DIR, optional)
    Chart.yaml               pimcore dependency >= 6.1.0
    values.yaml              supervisord -> consumers (workers generated from
                             the project's supervisord.conf), pimcore.cli and
                             supervisord.image removed
    values-*.yaml            pimcore.cli.image and supervisord.image tags removed

Everything is line based so comments and formatting survive. Anything that
does not look like the skeleton layout is reported under MANUAL instead of
being guessed. Dry run by default; --write applies.

Usage:
    pimcore-docker-10.py path/to/project [--manifest path/to/project-manifest] [--base-version 10.0.0] [--write]
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REMOVED_STAGES = ("cors_php_supervisord", "cors_php_cli", "cors_php_blackfire")
# lines that may appear in a removed stage without making it "custom"
BOILERPLATE = re.compile(
    r"^\s*$|^\s*#|^ARG APP_ENV|^ENV APP_ENV|^ENV APP_DEBUG|^USER www-data"
    r"|^COPY --from=cors_php /var/www/html /var/www/html"
    r"|^COPY \.docker/supervisord[^ ]* /etc/supervisor/conf\.d/"
)
SUPERVISORD_COPY = re.compile(r"^COPY \.docker/supervisord[^ ]* /etc/supervisor/conf\.d/\S+\s*$")
FROM_RE = re.compile(r"^FROM\s+(\S+)(?:\s+AS\s+(\S+))?\s*$", re.IGNORECASE)
SUPPORTED_PHP = ("8.4", "8.5")


class Report:
    def __init__(self) -> None:
        self.changes: list[str] = []
        self.manual: list[str] = []
        self.errors: list[str] = []

    def change(self, msg: str) -> None:
        self.changes.append(msg)

    def todo(self, msg: str) -> None:
        self.manual.append(msg)

    def error(self, msg: str) -> None:
        self.errors.append(msg)


# --------------------------------------------------------------------------
# project repo
# --------------------------------------------------------------------------

def migrate_dockerfile(text: str, rep: Report) -> str:
    lines = text.splitlines(keepends=True)

    # split into (header, [stage blocks]); a block starts at a FROM line
    starts = [i for i, l in enumerate(lines) if FROM_RE.match(l)]
    if not starts:
        rep.error("Dockerfile: no FROM found")
        return text
    blocks = []
    for n, s in enumerate(starts):
        e = starts[n + 1] if n + 1 < len(starts) else len(lines)
        m = FROM_RE.match(lines[s])
        blocks.append({"image": m.group(1), "stage": (m.group(2) or "").lower(), "lines": lines[s:e]})

    stages = {b["stage"] for b in blocks}
    if "cors_php" not in stages:
        rep.error("Dockerfile: no `AS cors_php` stage, not a skeleton layout")
        return text

    supervisord_copy: list[str] = []
    kept = []
    for b in blocks:
        if b["stage"] in REMOVED_STAGES:
            custom = [l for l in b["lines"][1:] if not BOILERPLATE.match(l)]
            if custom:
                rep.todo(
                    f"Dockerfile: stage {b['stage']} has project specific lines, kept it — merge into cors_php by hand:\n"
                    + "".join("      " + l for l in custom)
                )
                kept.append(b)
                continue
            supervisord_copy += [l for l in b["lines"] if SUPERVISORD_COPY.match(l)]
            rep.change(f"Dockerfile: removed stage {b['stage']}")
        else:
            kept.append(b)

    out: list[str] = lines[: starts[0]]
    for b in kept:
        blines = list(b["lines"])
        if b["stage"] == "cors_php":
            m = re.match(r"^FROM\s+(ghcr\.io/cors-gmbh/pimcore-docker/)php-fpm(:\S+)(\s+AS\s+\S+\s*)$", blines[0], re.IGNORECASE)
            if m:
                blines[0] = f"FROM {m.group(1)}pimcore{m.group(2)}{m.group(3)}"
                rep.change("Dockerfile: cors_php builds from the `pimcore` image")
            elif "pimcore-docker/pimcore:" not in blines[0]:
                rep.todo(f"Dockerfile: cors_php base image not recognised, set it to pimcore-docker/pimcore yourself: {blines[0].strip()}")
            if supervisord_copy and not any(SUPERVISORD_COPY.match(l) for l in blines):
                # right after the FROM line (plus a blank line), before anything else
                insert = ["\n", "# supervisord programs for the local `command: supervisord` mode; in Kubernetes\n",
                          "# the chart runs the consumers as separate Deployments (consumers.workers).\n"]
                insert += supervisord_copy
                blines[1:1] = insert
                rep.change("Dockerfile: supervisord.conf COPY moved into cors_php")
        out += blines
        if not out[-1].endswith("\n"):
            out[-1] += "\n"

    # collapse 3+ blank lines left behind
    result = re.sub(r"\n{3,}", "\n\n", "".join(out))
    return result


def migrate_env(text: str, base_version: str, rep: Report) -> str:
    php = re.search(r"^DOCKER_PHP_VERSION=(\S+)", text, re.M)
    if not php:
        rep.error(".env: DOCKER_PHP_VERSION missing")
    elif php.group(1) not in SUPPORTED_PHP:
        rep.error(f".env: DOCKER_PHP_VERSION={php.group(1)} — pimcore-docker 10.x only ships PHP {', '.join(SUPPORTED_PHP)}; upgrade PHP first")
    new, n = re.subn(r"^(DOCKER_BASE_IMAGE=)\S+", rf"\g<1>{base_version}", text, flags=re.M)
    if n:
        rep.change(f".env: DOCKER_BASE_IMAGE={base_version}")
    else:
        rep.error(".env: DOCKER_BASE_IMAGE missing")
    return new


def migrate_supervisord_conf(text: str, rep: Report) -> str:
    if "stopwaitsecs" in text:
        return text
    new, n = re.subn(r"^(autorestart=true\n)", r"\1stopwaitsecs=120\n", text, flags=re.M)
    if n:
        rep.change(f".docker/supervisord.conf: stopwaitsecs=120 added to {n} program(s)")
    return new


def parse_programs(text: str) -> tuple[dict[str, dict], list[str]]:
    """supervisord programs -> consumers.workers entries (name -> spec) + manual leftovers."""
    workers: dict[str, dict] = {}
    manual: list[str] = []
    for m in re.finditer(r"^\[program:([^\]]+)\]\n(.*?)(?=^\[|\Z)", text, re.M | re.S):
        name, body = m.group(1), m.group(2)
        cmd = re.search(r"^command=(.*)$", body, re.M)
        if not cmd or "messenger:consume" not in cmd.group(1):
            manual.append(f"[program:{name}] {cmd.group(1).strip() if cmd else '(no command)'}")
            continue
        args = cmd.group(1).split("messenger:consume", 1)[1].split()
        queues = [a for a in args if not a.startswith("-")]
        spec: dict = {"queues": queues}
        for a in args:
            if a.startswith("--memory-limit="):
                spec["memoryLimit"] = a.split("=", 1)[1]
            elif a.startswith("--time-limit="):
                spec["timeLimit"] = int(a.split("=", 1)[1])
            elif a.startswith("--limit=") or a.startswith("-"):
                spec.setdefault("extraArgs", []).append(a)
        n = re.search(r"^numprocs=(\d+)", body, re.M)
        if n and int(n.group(1)) > 1:
            spec["replicas"] = int(n.group(1))
        wname = re.sub(r"_consume$", "", re.sub(r"^pimcore_", "", name)).replace("_", "-")
        workers[wname] = spec
    return workers, manual


# --------------------------------------------------------------------------
# manifest repo
# --------------------------------------------------------------------------

def indent_of(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def find_block(lines: list[str], path: list[str]) -> tuple[int, int] | None:
    """(start, end) of the mapping key at `path` incl. its nested lines, or None."""
    i, depth_indent = 0, -1
    start = None
    for key in path:
        found = False
        while i < len(lines):
            l = lines[i]
            s = l.strip()
            if s and not s.startswith("#"):
                ind = indent_of(l)
                if ind <= depth_indent and start is not None:
                    return None  # left the parent block
                if ind > depth_indent and re.match(rf"^{re.escape(key)}\s*:", s):
                    depth_indent, start, found = ind, i, True
                    i += 1
                    break
            i += 1
        if not found:
            return None
    # end: first non-blank, non-deeper line
    j = start + 1
    while j < len(lines):
        l = lines[j]
        if l.strip() and indent_of(l) <= depth_indent:
            break
        j += 1
    # do not swallow trailing blank lines
    while j - 1 > start and not lines[j - 1].strip():
        j -= 1
    return start, j


def remove_block(lines: list[str], path: list[str], rep: Report, label: str) -> bool:
    b = find_block(lines, path)
    if not b:
        return False
    del lines[b[0]:b[1]]
    rep.change(f"{label}: removed {'.'.join(path)}")
    return True


def render_consumers(workers: dict[str, dict], indent: int) -> list[str]:
    pad = " " * indent
    out = [
        f"{pad}# Messenger consumers: one Deployment per worker (pimcore-chart >= 6.1),\n",
        f"{pad}# generated from .docker/supervisord.conf of the project.\n",
        f"{pad}supervisord:\n",
        f"{pad}  enabled: false\n",
        f"{pad}consumers:\n",
        f"{pad}  enabled: true\n",
        f"{pad}  workers:\n",
    ]
    for name, spec in workers.items():
        out.append(f"{pad}    {name}:\n")
        out.append(f"{pad}      queues: [{', '.join(spec['queues'])}]\n")
        for k in ("replicas", "timeLimit", "memoryLimit"):
            if k in spec:
                out.append(f"{pad}      {k}: {spec[k]}\n")
        if spec.get("extraArgs"):
            out.append(f"{pad}      extraArgs: [{', '.join(repr(a) for a in spec['extraArgs'])}]\n")
    return out


def migrate_values_base(text: str, workers: dict[str, dict], rep: Report) -> str:
    lines = text.splitlines(keepends=True)
    root = ["pimcore"] if find_block(lines, ["pimcore", "pimcore"]) else []
    remove_block(lines, root + ["pimcore", "cli"], rep, "values.yaml")
    if find_block(lines, root + ["consumers"]):
        return "".join(lines)
    b = find_block(lines, root + ["supervisord"])
    if b:
        indent = indent_of(lines[b[0]])
        block = render_consumers(workers, indent) if workers else [" " * indent + "supervisord:\n", " " * indent + "  enabled: false\n"]
        lines[b[0]:b[1]] = block
        rep.change("values.yaml: supervisord replaced by consumers" + ("" if workers else " (no workers found, ADD THEM)"))
    elif workers:
        rep.todo("values.yaml: no supervisord block found — add this:\n" + "".join(render_consumers(workers, 2 if root else 0)))
    return "".join(lines)


def migrate_values_env(text: str, rep: Report, label: str) -> str:
    lines = text.splitlines(keepends=True)
    root = ["pimcore"] if find_block(lines, ["pimcore", "pimcore"]) or find_block(lines, ["pimcore", "supervisord"]) else []
    remove_block(lines, root + ["pimcore", "cli"], rep, label)
    remove_block(lines, root + ["supervisord"], rep, label)
    return "".join(lines)


def migrate_chart_yaml(text: str, rep: Report) -> str:
    m = re.search(r"^(\s*-\s*name:\s*pimcore\s*\n(?:.*\n)*?\s*version:\s*)(\S.*)$", text, re.M)
    if not m:
        rep.todo("Chart.yaml: pimcore dependency not found, set its version to '>=6.1.0 <7.0.0-0'")
        return text
    new = text[: m.start(2)] + '">=6.1.0 <7.0.0-0"' + text[m.end(2):]
    rep.change(f"Chart.yaml: pimcore dependency {m.group(2).strip()} -> >=6.1.0 <7.0.0-0")
    return new


# --------------------------------------------------------------------------

def apply(path: Path, new: str, old: str, write: bool, touched: list[tuple[Path, str]]) -> None:
    if new != old:
        touched.append((path, new))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", type=Path, help="project repo checkout")
    ap.add_argument("--manifest", type=Path, help="manifest (CD) repo checkout")
    ap.add_argument("--base-version", default="10.0.0", help="DOCKER_BASE_IMAGE to set (default: 10.0.0)")
    ap.add_argument("--write", action="store_true", help="apply changes (default: dry run)")
    a = ap.parse_args()

    rep = Report()
    touched: list[tuple[Path, str]] = []
    workers: dict[str, dict] = {}

    df = a.project / "Dockerfile"
    env = a.project / ".env"
    sv = a.project / ".docker" / "supervisord.conf"
    for p in (df, env):
        if not p.is_file():
            rep.error(f"{p} not found")
    if rep.errors:
        print("\n".join("ERROR: " + e for e in rep.errors))
        return 2

    apply(df, migrate_dockerfile(df.read_text(), rep), df.read_text(), a.write, touched)
    apply(env, migrate_env(env.read_text(), a.base_version, rep), env.read_text(), a.write, touched)
    if sv.is_file():
        txt = sv.read_text()
        apply(sv, migrate_supervisord_conf(txt, rep), txt, a.write, touched)
        workers, leftovers = parse_programs(txt)
        for l in leftovers:
            if "pimcore:maintenance" in l:
                rep.change("supervisord.conf: pimcore:maintenance program dropped from consumers — the chart's maintenance CronJob (pimcore.maintenance) runs it once supervisord is off")
            else:
                rep.todo(f"supervisord.conf: not a messenger:consume program, needs a CronJob or its own worker: {l}")
    else:
        rep.todo(".docker/supervisord.conf not found — consumers.workers must be written by hand")

    if a.manifest:
        chart = a.manifest / "Chart.yaml"
        if chart.is_file():
            apply(chart, migrate_chart_yaml(chart.read_text(), rep), chart.read_text(), a.write, touched)
        else:
            rep.error(f"{chart} not found")
        base = a.manifest / "values.yaml"
        if base.is_file():
            apply(base, migrate_values_base(base.read_text(), workers, rep), base.read_text(), a.write, touched)
        for vf in sorted(a.manifest.glob("values-*.yaml")):
            apply(vf, migrate_values_env(vf.read_text(), rep, vf.name), vf.read_text(), a.write, touched)
        rep.todo("manifest: run `helm dependency update` once chart 6.1.0 is published, and drop any leftover "
                 "`.pimcore.supervisord.image.tag` / `.pimcore.pimcore.cli.image.tag` from the project's update-manifest yq expressions")

    write = a.write and not rep.errors
    if write:
        for path, new in touched:
            path.write_text(new)
    mode = "APPLIED" if write else "DRY RUN"
    print(f"== {mode}: {len(touched)} file(s) {'changed' if write else 'would change'}")
    for path, _ in touched:
        print(f"   {path}")
    if rep.changes:
        print("\n== Changes")
        print("\n".join("  - " + c for c in rep.changes))
    if rep.manual:
        print("\n== MANUAL")
        print("\n".join("  - " + m for m in rep.manual))
    if rep.errors:
        print("\n== ERRORS (nothing written for these)")
        print("\n".join("  - " + e for e in rep.errors))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
