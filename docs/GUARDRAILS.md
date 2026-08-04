# PR Guardrails

Zentraler Qualitäts-Check für Pull Requests in allen CORS Projekt- und
Bundle-Repos. Der Guardrail läuft als Reusable Workflow aus diesem Repo und
wird per File-Sync in die Ziel-Repos verteilt — dort liegt nur ein kleiner
Caller (`.github/workflows/pr-guardrail.yml`), die Logik bleibt zentral.

- Reusable Workflows: [`pr-guardrail.yml`](../.github/workflows/pr-guardrail.yml), [`pr-to-project.yml`](../.github/workflows/pr-to-project.yml)
- Regel-Logik + Tests: [`scripts/guardrails/`](../scripts/guardrails/)
- Verteilung: [`sync-files.yml`](../.github/workflows/sync-files.yml) mit Konfiguration in [`.github/sync.yml`](../.github/sync.yml)

## Die Regeln

| Regel | Prüft | Bei Verstoß |
|---|---|---|
| **R1** | Branch heißt `issue/<nummer>` (case-insensitive, Suffix erlaubt: `issue/123-dam-import`) | Verstoß |
| **R2** | Das Issue `<nummer>` existiert in **diesem** Repo und ist offen (`require-issue-open`, Default: an). Eine PR-Nummer zählt nicht als Issue. | Verstoß |
| **R3** | Titel-Autofix: Besteht der PR-Titel nur aus dem Branchnamen, wird er durch `#<nummer> <Issue-Titel>` ersetzt. Andere Titel werden **nie** angefasst. | Reparatur, kein Verstoß |
| **R4** | Die PR-Beschreibung enthält echten Fließtext (Default: mind. 50 Zeichen). HTML-Kommentare, Markdown-Überschriften und leere Checkboxen zählen nicht. | Verstoß |
| **R5** | Alle Check-Runs und Commit-Statuses am Head-Commit sind grün, keine Merge-Konflikte. Laufende Checks lösen **nichts** aus — nur ein endgültiger Fehlschlag (`failure`, `cancelled`, `timed_out`) oder ein Konflikt zählt. | Verstoß |
| **R6** | Fehlt eine Closing-Reference auf das Issue aus R1, hängt der Guardrail `Closes #<nummer>` an den PR-Body an (GitHub-Verknüpfung: Development-Sidebar, Projects-Automation). | Reparatur, kein Verstoß |

## Was passiert bei einem Verstoß?

Das hängt vom `enforce`-Input im Caller ab:

- **`enforce: true` (Standard in den verteilten Callern):** Der PR wird auf
  **Draft** zurückgesetzt, der Sticky-Kommentar listet genau die verletzten
  Regeln mit je einem konkreten Handlungssatz, und der Guardrail-Job schlägt
  fehl.
- **`enforce: false` (Hinweismodus):** Der Guardrail schreibt einen
  Sticky-Kommentar, der klar als Hinweismodus gekennzeichnet ist. Der Job
  bleibt **grün**, nichts wird blockiert.

Der Kommentar ist immer derselbe (Marker `<!-- pr-guardrail -->`) und wird
aktualisiert statt neu angelegt. Sind alle Regeln erfüllt, schrumpft er auf
eine kurze Erfolgsmeldung. Identischer Inhalt erzeugt keinen neuen
API-Schreibzugriff — es gibt also keine Benachrichtigungs-Flut.

### Re-Check auslösen

- Nach einer Draft-Konvertierung: Mängel beheben und **„Ready for review“**
  klicken — der Guardrail prüft dann erneut.
- Titel/Beschreibung editieren löst ebenfalls einen Lauf aus.
- CI-Ergebnisse (R5) werden automatisch erneut geprüft, sobald ein
  Check-Suite-Lauf abschließt oder ein Commit-Status eintrifft.

### Draft-PRs

Draft-PRs werden übersprungen — einzige Ausnahme ist der Titel-Autofix (R3),
der auch im Draft läuft. Die volle Prüfung startet mit „Ready for review“.

### Bot-PRs

PRs von `renovate[bot]`, `dependabot[bot]` und `github-actions[bot]`
(konfigurierbar über den Input `bots`) haben keine `issue/`-Branches und
keine Tickets: Für sie werden **R1–R3 und R6 übersprungen**. Die CI-Regel
(**R5**) gilt weiterhin. Ob R4 (Beschreibung) für Bots gilt, steuert der
Input `bot-require-body` (Default: aus).

Der CORS CD Bot selbst (Absender der File-Sync-PRs) wird zur Laufzeit
automatisch in die Bot-Liste aufgenommen — der Guardrail verschluckt sich
nicht an seinen eigenen Sync-PRs.

## Admin-Bypass

Es gibt genau **einen** Bypass-Mechanismus: das Label **`guardrail-bypass`**.

1. Jemand setzt das Label. Der Guardrail prüft über die Collaborator-API,
   welche Berechtigung diese Person auf dem Repo hat.
2. **`admin` oder `maintain`:** Der Guardrail wird übersprungen und ein
   dauerhafter Audit-Kommentar dokumentiert Person, Rolle und Zeitpunkt.
   Solange das Label gesetzt ist, bleibt der Guardrail aus.
3. **Alle anderen:** Das Label wird sofort wieder entfernt, ein Kommentar
   („Bypass nur für Admins“) erklärt das, und der Guardrail läuft normal
   weiter.

Es gibt **keinen** anderen Bypass — weder per Commit-Message noch per
Body-Keyword oder Umgebungsvariable. Label entfernen ⇒ nächstes Event prüft
wieder normal.

## Enforce-Modus zentral umstellen

Die synchronisierten Caller stehen auf `enforce: true` — Verstöße blockieren
also von Anfang an. Umgestellt wird **zentral** in
`templates/pr-guardrail.yml` in diesem Repo — der nächste Sync verteilt die
Änderung. Einzelne Repos oder Gruppen können abweichen, indem man ihnen in
`.github/sync.yml` ein eigenes Template mit anderen Inputs zuweist.

### Öffentliche OSS-Repos: `templates/pr-guardrail-oss.yml`

Für **öffentliche** Repos mit externen Contributors (Gruppe 5 in
`.github/sync.yml`, z. B. `pimcore-data-definitions`) gibt es einen zweiten
Caller mit `enforce: false` und `require-issue-open: false`. Grund: Fork-
Contributors branchen nicht nach `issue/<nummer>` (R1) und legen oft kein
Issue an (R2) — im Enforce-Modus würde jeder Community-PR sofort auf Draft
gesetzt. Der Guardrail kommentiert dort also nur, der Check bleibt grün.
Ansonsten ist die Datei inhaltlich identisch (gleiche Trigger, gleiche
Concurrency, `pr-to-project` aktiv).

Dazu gehört `templates/pull_request_template-oss.md` — dieselbe Struktur wie
das interne Template, aber **auf Englisch** (die Contributors sind
international) und mit der in OSS-Repos üblichen Q/A-Tabelle
(Bug fix / BC breaks / Fixed tickets).

## Secrets und App-Permissions

Beide Workflows authentifizieren sich als **CORS CD Bot** (GitHub App) über
`actions/create-github-app-token`. Die Credentials liegen als
**Org-Secrets** `GH_APP_ID` und `GH_APP_PRIVATE_KEY`; die Caller geben sie
mit `secrets: inherit` weiter.

> **Wichtig:** Die Org-Secrets müssen für jedes Ziel-Repo sichtbar sein
> (Org-Settings → Secrets → Repository access), und die GitHub App muss in
> jedem Ziel-Repo **installiert** sein — sonst schlägt schon die
> Token-Erzeugung fehl.

Benötigte Permissions der App:

| Ebene | Permission | Zugriff | Wofür |
|---|---|---|---|
| Repository | Metadata | Read | Basis (implizit), Collaborator-Permission-Check |
| Repository | Contents | Read & Write | File-Sync schreibt Dateien/Branches; Guardrail liest nur (Checkout der Skripte) |
| Repository | Workflows | Read & Write | File-Sync verteilt Dateien nach `.github/workflows/` |
| Repository | Pull requests | Read & Write | Titel/Body-Autofix, Draft-Konvertierung, Sync-PRs |
| Repository | Issues | Read & Write | Issue-Lookup (R2), Sticky-/Audit-Kommentare, Label entfernen |
| Repository | Checks | Read | Check-Runs lesen (R5, Loop-Schutz) |
| Repository | Commit statuses | Read | Commit-Statuses lesen (R5) |
| Organization | Projects | Read & Write | Nur für `pr-to-project.yml` (Projects V2) |

Falls der Collaborator-Permission-Check (`GET
/repos/{owner}/{repo}/collaborators/{user}/permission`) mit 403 antwortet,
zusätzlich **Repository → Administration: Read** ergänzen.

### File-Sync: App-Token statt PAT

`BetaHuhn/repo-file-sync-action` funktioniert laut Doku **nicht** mit dem
Standard-`GITHUB_TOKEN`. Seit v1.21 akzeptiert die Action aber ein GitHub-App-
Installation-Token über den Input `GH_INSTALLATION_TOKEN` — genau das nutzen
wir mit dem CD-Bot-Token. Ein zusätzlicher Machine-User-PAT (`SYNC_PAT`) ist
**nicht** nötig. Einzige Auflage: `GIT_USERNAME` und `GIT_EMAIL` müssen bei
Installation-Tokens explizit gesetzt werden (macht `sync-files.yml`
automatisch aus dem App-Slug).

## Neues Repo in den Sync aufnehmen

1. Prüfen, dass die **App im Ziel-Repo installiert** ist und die Org-Secrets
   `GH_APP_ID`/`GH_APP_PRIVATE_KEY` dort sichtbar sind (siehe oben).
2. In [`.github/sync.yml`](../.github/sync.yml) das Repo in die passende
   Gruppe eintragen (Projekt-Repos, Bundle-Repos, Dev-/Infrastruktur-Repos,
   sonstige Anwendungs-Repos oder öffentliche OSS-Repos). Achtung: innerhalb
   der `repos: |`-Blöcke sind keine Kommentare möglich.
3. Falls das Repo schon ein eigenes `PULL_REQUEST_TEMPLATE.md` im Root oder in
   `docs/` hat: dieses **löschen**, sonst konkurriert es mit dem gesyncten
   `.github/pull_request_template.md`. Der File-Sync kann nur schreiben, nicht
   löschen — das braucht einen separaten PR im Ziel-Repo.
4. Auf `main` mergen (oder `sync-files.yml` per `workflow_dispatch` starten).
5. Im Ziel-Repo den Sync-PR (`repo-sync/...`, Label `file-sync`) mergen.
6. Optional: das Label `guardrail-bypass` im Ziel-Repo anlegen (Farbe/Text
   frei), damit es in der Label-Auswahl auftaucht.

## `pr-to-project.yml`

Der zweite Reusable Workflow legt PRs automatisch in die Projects-V2-Boards,
in denen ihre verknüpften Issues liegen (aufgelöst über
`closingIssuesReferences`, deshalb spielt R6 gut zu). Er ist in allen
verteilten Callern (Projekte, Bundles, Dev-Repos) **standardmäßig aktiv**,
läuft aber unabhängig vom Guardrail — zum Deaktivieren den Job
`pr-to-project` im Caller-Template auskommentieren. Ohne verknüpfte Projekte
tut der Job nichts und bleibt grün (idempotent). Voraussetzung: Die App hat
die Organization-Permission **Projects: Read & Write**.

## Versionierung

Die Caller referenzieren `cors-gmbh/shared-workflows/...@v1` — ein **Tag**,
kein Branch. Breaking Changes an Inputs oder Verhalten ⇒ neues Major-Tag
(`v2`) und Umstellung über die Templates. Kompatible Fixes ⇒ `v1`-Tag auf den
neuen Commit verschieben. Das Checkout der Skripte im Reusable Workflow hängt
über `github.job_workflow_sha` am selben Commit wie das Tag — Workflow und
Skripte sind damit immer konsistent versioniert.

> Damit andere Repos die Reusable Workflows überhaupt aufrufen dürfen, muss
> in diesem Repo unter **Settings → Actions → General → Access** die Option
> „Accessible from repositories in the `cors-gmbh` organization“ aktiv sein.

## Troubleshooting

| Symptom | Ursache / Lösung |
|---|---|
| Guardrail läuft gar nicht | Caller-Datei im Ziel-Repo vorhanden? `v1`-Tag existiert? Access-Setting (s. o.) aktiv? |
| „Create app token“ schlägt fehl | App nicht im Repo installiert oder Org-Secrets nicht freigegeben. |
| Kommentar erscheint nicht, Job grün | PR ist Draft (wird übersprungen) oder CI läuft noch (R5 wartet). |
| Bypass-Label wird sofort entfernt | Absender hat weder `admin` noch `maintain` — so soll es sein. |
| Collaborator-Check antwortet 403 | App-Permission „Administration: Read“ ergänzen. |
| Sync-PR fehlt im Ziel-Repo | Repo in `.github/sync.yml` eingetragen? Lauf von `sync-files.yml` prüfen (Push auf `main` mit Template-Änderung oder `workflow_dispatch`). |
