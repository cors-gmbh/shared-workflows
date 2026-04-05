#!/usr/bin/env python3
"""
Buchungsbericht PDF — CORS-interner Everhour-Zeitbericht fuer Rutar Group PIM/DAM.

Usage:
    python generate_buchungsbericht.py \
        --everhour-token TOKEN \
        --project-id ev:195337863425313 \
        --output ./output \
        --logo scripts/assets/cors-logo.png \
        [--month 2026-03]   # optional, default = Vormonat

Generates a CORS-branded PDF: Buchungsbericht_Rutar_YYYY-MM.pdf
"""

import argparse
import json
import os
import sys
import datetime
import urllib.request
from collections import defaultdict

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.enums import TA_JUSTIFY, TA_LEFT, TA_CENTER, TA_RIGHT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, HRFlowable,
    Image as RLImage, Table, TableStyle,
)
from reportlab.lib.colors import HexColor, white
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# ── Font Setup ──────────────────────────────────────────────────────────────
try:
    pdfmetrics.registerFont(TTFont('DejaVuSans', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'))
    pdfmetrics.registerFont(TTFont('DejaVuSans-Bold', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'))
    pdfmetrics.registerFont(TTFont('DejaVuSans-Oblique', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf'))
    from reportlab.lib.fonts import addMapping
    addMapping('DejaVuSans', 0, 0, 'DejaVuSans')
    addMapping('DejaVuSans', 1, 0, 'DejaVuSans-Bold')
    addMapping('DejaVuSans', 0, 1, 'DejaVuSans-Oblique')
    BASE_FONT = 'DejaVuSans'
    BOLD_FONT = 'DejaVuSans-Bold'
except Exception:
    BASE_FONT = 'Helvetica'
    BOLD_FONT = 'Helvetica-Bold'

# ── CORS Corporate Colors ──────────────────────────────────────────────────
CORS_RED = HexColor('#CD151A')
CORS_DARK = HexColor('#1a1a1a')
GREY_LIGHT = HexColor('#F5F5F5')
GREY_MED = HexColor('#CCCCCC')
GREY_TEXT = HexColor('#444444')
GREEN = HexColor('#27AE60')
YELLOW = HexColor('#F39C12')
RED = HexColor('#E74C3C')

MONTH_NAMES_DE = {
    1: "Januar", 2: "Februar", 3: "Maerz", 4: "April", 5: "Mai", 6: "Juni",
    7: "Juli", 8: "August", 9: "September", 10: "Oktober", 11: "November", 12: "Dezember",
}


# ── Everhour API ────────────────────────────────────────────────────────────
def fetch_everhour(endpoint, token):
    url = f"https://api.everhour.com{endpoint}"
    req = urllib.request.Request(url, headers={"X-Api-Key": token})
    resp = urllib.request.urlopen(req)
    return json.loads(resp.read())


def get_report_data(token, project_id, date_from, date_to):
    """Fetch and aggregate Everhour time data for the given period."""
    # Team users
    users_raw = fetch_everhour("/team/users", token)
    user_map = {u["id"]: u.get("name", f"User {u['id']}") for u in users_raw}

    # Time entries
    entries = fetch_everhour(f"/team/time?from={date_from}&to={date_to}", token)

    # Aggregate: Epic -> User -> hours
    epic_data = defaultdict(lambda: {
        "users": defaultdict(float),
        "total_hours": 0,
        "estimate_hours": 0,
    })
    unassigned_hours = defaultdict(float)

    for entry in entries:
        user_name = user_map.get(entry.get("user"), f"User {entry.get('user')}")
        hours = entry.get("time", 0) / 3600
        task = entry.get("task")

        if task and task.get("parentName"):
            epic_name = task["parentName"]
            epic_data[epic_name]["users"][user_name] += hours
            epic_data[epic_name]["total_hours"] += hours
        elif task:
            task_name = task.get("name", "Unbekannt")
            epic_data[f"Sonstige: {task_name}"]["users"][user_name] += hours
            epic_data[f"Sonstige: {task_name}"]["total_hours"] += hours
        else:
            unassigned_hours[user_name] += hours

    # Estimates from project tasks
    try:
        tasks = fetch_everhour(f"/projects/{project_id}/tasks", token)
        for t in tasks:
            iteration = t.get("iteration", "")
            est = t.get("estimate", {})
            est_h = est.get("total", 0) / 3600 if est else 0
            if iteration:
                key = f"[Epic] {iteration}"
                epic_data[key]["estimate_hours"] += est_h
    except Exception as e:
        print(f"Warning: Could not fetch estimates: {e}", file=sys.stderr)

    return epic_data, unassigned_hours, user_map


# ── Budget Status ───────────────────────────────────────────────────────────
def budget_status(actual, estimate):
    if not estimate or estimate == 0:
        return ("--", GREY_TEXT)
    pct = (actual / estimate) * 100
    if pct <= 80:
        return (f"{pct:.0f}%", GREEN)
    elif pct <= 100:
        return (f"{pct:.0f}%", YELLOW)
    else:
        return (f"{pct:.0f}%", RED)


# ── PDF Styles ──────────────────────────────────────────────────────────────
def create_styles():
    s = {}
    s['Title'] = ParagraphStyle(
        'Title', fontName=BOLD_FONT, fontSize=16, leading=20,
        spaceAfter=3*mm, textColor=CORS_RED,
    )
    s['Subtitle'] = ParagraphStyle(
        'Subtitle', fontName=BASE_FONT, fontSize=10, leading=13,
        spaceAfter=5*mm, textColor=GREY_TEXT,
    )
    s['SectionHeading'] = ParagraphStyle(
        'SectionHeading', fontName=BOLD_FONT, fontSize=11, leading=14,
        spaceBefore=5*mm, spaceAfter=2*mm, textColor=CORS_RED,
    )
    s['Body'] = ParagraphStyle(
        'Body', fontName=BASE_FONT, fontSize=9, leading=12,
        spaceAfter=1*mm, textColor=GREY_TEXT, alignment=TA_JUSTIFY,
    )
    s['TableHeader'] = ParagraphStyle(
        'TableHeader', fontName=BOLD_FONT, fontSize=8, leading=10,
        textColor=white, alignment=TA_CENTER,
    )
    s['TableCell'] = ParagraphStyle(
        'TableCell', fontName=BASE_FONT, fontSize=8, leading=10,
        textColor=CORS_DARK, alignment=TA_LEFT,
    )
    s['TableCellRight'] = ParagraphStyle(
        'TableCellRight', fontName=BASE_FONT, fontSize=8, leading=10,
        textColor=CORS_DARK, alignment=TA_RIGHT,
    )
    s['TableCellBold'] = ParagraphStyle(
        'TableCellBold', fontName=BOLD_FONT, fontSize=8, leading=10,
        textColor=CORS_DARK, alignment=TA_LEFT,
    )
    s['Footer'] = ParagraphStyle(
        'Footer', fontName=BASE_FONT, fontSize=7, leading=9,
        textColor=HexColor('#999999'), alignment=TA_CENTER,
    )
    return s


# ── Table Helper ────────────────────────────────────────────────────────────
def styled_table(data, col_widths, header_bg=CORS_RED):
    tbl = Table(data, colWidths=col_widths)
    tbl.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), header_bg),
        ('TEXTCOLOR', (0, 0), (-1, 0), white),
        ('ALIGN', (1, 0), (-1, -1), 'RIGHT'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('BACKGROUND', (0, -1), (-1, -1), GREY_LIGHT),
        ('LINEBELOW', (0, 0), (-1, -2), 0.5, GREY_MED),
        ('LINEBELOW', (0, -1), (-1, -1), 1, CORS_RED),
        ('ROWBACKGROUNDS', (0, 1), (-1, -2), [white, GREY_LIGHT]),
    ]))
    return tbl


# ── PDF Generation ──────────────────────────────────────────────────────────
def generate_pdf(epic_data, unassigned_hours, output_path, logo_path, period_label, date_range):
    styles = create_styles()

    doc = SimpleDocTemplate(
        output_path, pagesize=A4,
        leftMargin=18*mm, rightMargin=18*mm,
        topMargin=18*mm, bottomMargin=18*mm,
    )
    story = []

    # Logo
    if logo_path and os.path.exists(logo_path):
        logo_w = 50*mm
        logo_h = logo_w / 4.49
        story.append(RLImage(logo_path, width=logo_w, height=logo_h, hAlign='LEFT'))
        story.append(Spacer(1, 5*mm))

    # Title
    story.append(Paragraph(f"Buchungsbericht {period_label}", styles['Title']))
    story.append(Paragraph(f"Projekt: Rutar Group PIM/DAM | Zeitraum: {date_range}", styles['Subtitle']))
    story.append(HRFlowable(width="100%", thickness=1, color=CORS_RED))
    story.append(Spacer(1, 5*mm))

    # ── Summary: Hours per Employee ──
    story.append(Paragraph("Zusammenfassung: Stunden pro Mitarbeiter", styles['SectionHeading']))

    user_totals = defaultdict(float)
    total_all = 0
    for data in epic_data.values():
        for user, hrs in data["users"].items():
            user_totals[user] += hrs
            total_all += hrs
    for user, hrs in unassigned_hours.items():
        user_totals[user] += hrs
        total_all += hrs

    rows = [[Paragraph("<b>Mitarbeiter</b>", styles['TableHeader']),
             Paragraph("<b>Stunden</b>", styles['TableHeader']),
             Paragraph("<b>Anteil</b>", styles['TableHeader'])]]
    for user in sorted(user_totals):
        hrs = user_totals[user]
        pct = (hrs / total_all * 100) if total_all > 0 else 0
        rows.append([
            Paragraph(user, styles['TableCell']),
            Paragraph(f"{hrs:.2f}h", styles['TableCellRight']),
            Paragraph(f"{pct:.0f}%", styles['TableCellRight']),
        ])
    rows.append([
        Paragraph("<b>Gesamt</b>", styles['TableCellBold']),
        Paragraph(f"<b>{total_all:.2f}h</b>", styles['TableCellRight']),
        Paragraph("<b>100%</b>", styles['TableCellRight']),
    ])
    story.append(styled_table(rows, [80*mm, 40*mm, 40*mm]))
    story.append(Spacer(1, 8*mm))

    # ── Epic Details ──
    story.append(Paragraph("Aufwaende pro Epic", styles['SectionHeading']))
    story.append(Spacer(1, 2*mm))

    for epic_name, data in sorted(epic_data.items()):
        if data["total_hours"] == 0:
            continue

        actual = data["total_hours"]
        estimate = data["estimate_hours"]
        label, color = budget_status(actual, estimate)
        color_hex = color.hexval() if hasattr(color, 'hexval') else '#444444'
        budget_tag = f'  <font color="{color_hex}">[{label}]</font>' if estimate > 0 else ''
        display = epic_name.replace("[Epic] ", "")

        story.append(Paragraph(f'<b>{display}</b>{budget_tag}', styles['SectionHeading']))

        parts = [f"Actual: {actual:.2f}h"]
        if estimate > 0:
            parts.append(f"Estimate: {estimate:.1f}h")
            parts.append(f"Rest: {max(0, estimate - actual):.1f}h")
        story.append(Paragraph(" | ".join(parts), styles['Body']))

        rows = [[Paragraph("<b>Mitarbeiter</b>", styles['TableHeader']),
                 Paragraph("<b>Stunden</b>", styles['TableHeader'])]]
        for user in sorted(data["users"]):
            rows.append([
                Paragraph(user, styles['TableCell']),
                Paragraph(f"{data['users'][user]:.2f}h", styles['TableCellRight']),
            ])
        rows.append([
            Paragraph(f"<b>Summe {display[:35]}</b>", styles['TableCellBold']),
            Paragraph(f"<b>{actual:.2f}h</b>", styles['TableCellRight']),
        ])
        story.append(styled_table(rows, [120*mm, 40*mm]))
        story.append(Spacer(1, 4*mm))

    # ── Unassigned ──
    if unassigned_hours:
        story.append(Spacer(1, 3*mm))
        story.append(Paragraph("Nicht zugeordnete Buchungen", styles['SectionHeading']))
        story.append(Paragraph("Folgende Buchungen sind keinem Task zugeordnet:", styles['Body']))

        rows = [[Paragraph("<b>Mitarbeiter</b>", styles['TableHeader']),
                 Paragraph("<b>Stunden</b>", styles['TableHeader'])]]
        total_un = 0
        for user in sorted(unassigned_hours):
            hrs = unassigned_hours[user]
            total_un += hrs
            rows.append([
                Paragraph(user, styles['TableCell']),
                Paragraph(f"{hrs:.2f}h", styles['TableCellRight']),
            ])
        rows.append([
            Paragraph("<b>Summe</b>", styles['TableCellBold']),
            Paragraph(f"<b>{total_un:.2f}h</b>", styles['TableCellRight']),
        ])
        story.append(styled_table(rows, [120*mm, 40*mm], header_bg=HexColor('#7f8c8d')))

    # ── Footer ──
    today = datetime.date.today()
    story.append(Spacer(1, 10*mm))
    story.append(HRFlowable(width="100%", thickness=0.5, color=GREY_MED))
    story.append(Spacer(1, 2*mm))
    story.append(Paragraph(
        f"Generiert am {today.strftime('%d.%m.%Y')} | CORS GmbH | Quelle: Everhour",
        styles['Footer'],
    ))

    doc.build(story)
    return output_path


# ── Main ────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description='Buchungsbericht PDF aus Everhour')
    parser.add_argument('--everhour-token', required=True, help='Everhour API token')
    parser.add_argument('--project-id', default='ev:195337863425313', help='Everhour project ID')
    parser.add_argument('--output', default='.', help='Output directory')
    parser.add_argument('--logo', default=None, help='Path to CORS logo PNG')
    parser.add_argument('--month', default=None, help='Report month YYYY-MM (default: previous month)')
    args = parser.parse_args()

    # Determine report period
    today = datetime.date.today()
    if args.month:
        year, month = map(int, args.month.split('-'))
    else:
        first_this = today.replace(day=1)
        last_prev = first_this - datetime.timedelta(days=1)
        year, month = last_prev.year, last_prev.month

    date_from = datetime.date(year, month, 1)
    if month == 12:
        date_to = datetime.date(year + 1, 1, 1) - datetime.timedelta(days=1)
    else:
        date_to = datetime.date(year, month + 1, 1) - datetime.timedelta(days=1)

    period_label = f"{MONTH_NAMES_DE.get(month, str(month))} {year}"
    date_range = f"{date_from.strftime('%d.%m.%Y')} - {date_to.strftime('%d.%m.%Y')}"

    print(f"Buchungsbericht: {period_label} ({date_range})")
    print(f"Fetching Everhour data...")

    epic_data, unassigned_hours, user_map = get_report_data(
        args.everhour_token, args.project_id, date_from, date_to
    )

    epics_with_time = sum(1 for d in epic_data.values() if d["total_hours"] > 0)
    print(f"  {len(user_map)} Team-Mitglieder")
    print(f"  {epics_with_time} Epics mit Buchungen")

    os.makedirs(args.output, exist_ok=True)
    filename = f"Buchungsbericht_Rutar_{year}-{month:02d}.pdf"
    output_path = os.path.join(args.output, filename)

    print(f"Generating: {output_path}")
    generate_pdf(epic_data, unassigned_hours, output_path, args.logo, period_label, date_range)
    print(f"Done: {filename}")


if __name__ == '__main__':
    main()
