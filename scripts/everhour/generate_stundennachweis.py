#!/usr/bin/env python3
"""
Kunden-Stundennachweis PDF — CORS-gebrandeter Leistungsnachweis aus Everhour.

Generates a client-facing PDF matching the CORS Stundennachweis format:
- Grouped by Epic (numbered sections with total hours)
- Task title + description + ticket reference per entry
- No employee names (only aggregated hours)
- Summary with percentage breakdown per category

Usage:
    python generate_stundennachweis.py \
        --everhour-token TOKEN \
        --project-id ev:195337863425313 \
        --customer "Rutar Group" \
        --output ./output \
        --logo /tmp/cors_logo.png \
        [--month 2026-04]
"""

import argparse
import json
import os
import re
import sys
import datetime
import urllib.request
from collections import defaultdict, OrderedDict

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.enums import TA_JUSTIFY, TA_LEFT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, HRFlowable,
    Image as RLImage,
)
from reportlab.lib.colors import HexColor, white
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# ── Font Setup ──────────────────────────────────────────────────────────────
try:
    pdfmetrics.registerFont(TTFont('DejaVuSans', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'))
    pdfmetrics.registerFont(TTFont('DejaVuSans-Bold', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'))
    pdfmetrics.registerFont(TTFont('DejaVuSans-Oblique', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf'))
    pdfmetrics.registerFont(TTFont('DejaVuSans-BoldOblique', '/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf'))
    from reportlab.lib.fonts import addMapping
    addMapping('DejaVuSans', 0, 0, 'DejaVuSans')
    addMapping('DejaVuSans', 1, 0, 'DejaVuSans-Bold')
    addMapping('DejaVuSans', 0, 1, 'DejaVuSans-Oblique')
    addMapping('DejaVuSans', 1, 1, 'DejaVuSans-BoldOblique')
    BASE_FONT = 'DejaVuSans'
    BOLD_FONT = 'DejaVuSans-Bold'
    ITALIC_FONT = 'DejaVuSans-Oblique'
except Exception:
    BASE_FONT = 'Helvetica'
    BOLD_FONT = 'Helvetica-Bold'
    ITALIC_FONT = 'Helvetica-Oblique'

# ── CORS Corporate Colors ──────────────────────────────────────────────────
CORS_RED = HexColor('#CD151A')
GREY_TEXT = HexColor('#444444')
GREY_TICKET = HexColor('#7f8c8d')
GREY_LINE = HexColor('#CCCCCC')
DARK_TEXT = HexColor('#333333')

MONTH_NAMES_DE = {
    1: "Januar", 2: "Februar", 3: "M\u00e4rz", 4: "April", 5: "Mai", 6: "Juni",
    7: "Juli", 8: "August", 9: "September", 10: "Oktober", 11: "November", 12: "Dezember",
}


# ── Everhour API ────────────────────────────────────────────────────────────
def fetch_everhour(endpoint, token):
    url = f"https://api.everhour.com{endpoint}"
    req = urllib.request.Request(url, headers={"X-Api-Key": token})
    resp = urllib.request.urlopen(req)
    return json.loads(resp.read())


def format_hours_de(hours):
    """Format hours in German style: 3,5 Stunden."""
    if hours == int(hours):
        return f"{int(hours)} Stunden" if hours != 1 else "1 Stunde"
    return f"{hours:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".").rstrip("0").rstrip(",") + " Stunden"


def format_hours_short(hours):
    """Format hours as short German number: 3,5."""
    if hours == int(hours):
        return str(int(hours))
    return f"{hours:.2f}".replace(".", ",").rstrip("0").rstrip(",")


def escape_xml(text):
    """Escape XML special characters for reportlab."""
    text = text.replace('&', '&amp;')
    text = text.replace('<', '&lt;')
    text = text.replace('>', '&gt;')
    text = text.replace('"', '&quot;')
    return text


def get_report_data(token, project_id, date_from, date_to):
    """Fetch Everhour data and structure for Stundennachweis."""
    entries = fetch_everhour(f"/team/time?from={date_from}&to={date_to}", token)

    # Structure: Epic -> Tasks -> {title, description, hours, ticket}
    epics = defaultdict(lambda: {
        "tasks": defaultdict(lambda: {
            "title": "",
            "description": "",
            "hours": 0,
            "ticket": "",
            "url": "",
        }),
        "total_hours": 0,
    })

    unassigned_total = 0

    for entry in entries:
        hours = entry.get("time", 0) / 3600
        task = entry.get("task")
        comment = entry.get("comment", "")

        if task and task.get("parentName"):
            epic_name = task["parentName"].replace("[Epic] ", "")
            task_id = task.get("id", "unknown")
            task_name = task.get("name", "Unbekannte Aufgabe")
            # Clean task name: remove [Story], [Task] etc. prefixes
            clean_name = re.sub(r'^\[(Story|Task|Bug|Feature)\]\s*', '', task_name)
            task_number = task.get("number", "")
            task_url = task.get("url", "")

            t = epics[epic_name]["tasks"][task_id]
            t["title"] = clean_name
            t["hours"] += hours
            if task_number:
                t["ticket"] = f"#{task_number}"
            if task_url:
                t["url"] = task_url
            # Append Everhour comments as description
            if comment and comment != "Getting started with Everhour":
                if t["description"]:
                    t["description"] += " "
                t["description"] += comment

            epics[epic_name]["total_hours"] += hours
        elif task:
            task_name = task.get("name", "Sonstige Aufgabe")
            clean_name = re.sub(r'^\[(Story|Task|Bug|Feature|Epic)\]\s*', '', task_name)
            epic_name = "Sonstige Leistungen"
            task_id = task.get("id", "unknown")

            t = epics[epic_name]["tasks"][task_id]
            t["title"] = clean_name
            t["hours"] += hours
            if comment and comment != "Getting started with Everhour":
                if t["description"]:
                    t["description"] += " "
                t["description"] += comment
            epics[epic_name]["total_hours"] += hours
        else:
            unassigned_total += hours

    # Add unassigned as a generic entry if significant
    if unassigned_total >= 0.25:
        epics["Allgemeine Projektarbeit"]["tasks"]["unassigned"] = {
            "title": "Allgemeine Projektarbeit und Koordination",
            "description": "Projektbezogene Abstimmungen, Reviews und organisatorische Aufgaben.",
            "hours": unassigned_total,
            "ticket": "",
            "url": "",
        }
        epics["Allgemeine Projektarbeit"]["total_hours"] += unassigned_total

    return epics


# ── PDF Styles (matching Greiner format) ────────────────────────────────────
def create_styles():
    s = {}
    s['Title'] = ParagraphStyle(
        'Title', fontName=BOLD_FONT, fontSize=15, leading=19,
        spaceAfter=5*mm, textColor=CORS_RED,
    )
    s['Meta'] = ParagraphStyle(
        'Meta', fontName=BASE_FONT, fontSize=10, leading=14,
        spaceBefore=0.5*mm, spaceAfter=0.5*mm, textColor=DARK_TEXT,
    )
    s['SectionTitle'] = ParagraphStyle(
        'SectionTitle', fontName=BASE_FONT, fontSize=12, leading=15,
        spaceBefore=4*mm, spaceAfter=2*mm, textColor=CORS_RED,
    )
    s['TaskTitle'] = ParagraphStyle(
        'TaskTitle', fontName=BOLD_FONT, fontSize=9.5, leading=13,
        spaceBefore=2*mm, textColor=HexColor('#1a1a1a'),
    )
    s['Body'] = ParagraphStyle(
        'Body', fontName=BASE_FONT, fontSize=9, leading=12,
        spaceAfter=1*mm, textColor=GREY_TEXT, alignment=TA_JUSTIFY,
    )
    s['Ticket'] = ParagraphStyle(
        'Ticket', fontName=ITALIC_FONT, fontSize=8, leading=11,
        spaceAfter=1*mm, textColor=GREY_TICKET,
    )
    s['Summary'] = ParagraphStyle(
        'Summary', fontName=BOLD_FONT, fontSize=10, leading=14,
        spaceBefore=3*mm, spaceAfter=1*mm, textColor=HexColor('#1a1a1a'),
    )
    s['Bullet'] = ParagraphStyle(
        'Bullet', fontName=BASE_FONT, fontSize=9, leading=12,
        textColor=GREY_TEXT, leftIndent=10*mm, bulletIndent=4*mm,
        spaceAfter=1*mm,
    )
    s['Closing'] = ParagraphStyle(
        'Closing', fontName=ITALIC_FONT, fontSize=8.5, leading=12,
        spaceBefore=3*mm, textColor=GREY_TEXT, alignment=TA_JUSTIFY,
    )
    return s


# ── PDF Generation ──────────────────────────────────────────────────────────
def generate_pdf(epics, customer, period_label, output_path, logo_path):
    styles = create_styles()

    doc = SimpleDocTemplate(
        output_path, pagesize=A4,
        leftMargin=20*mm, rightMargin=20*mm,
        topMargin=20*mm, bottomMargin=20*mm,
    )
    story = []

    # ── Logo ──
    if logo_path and os.path.exists(logo_path):
        logo_w = 50*mm
        logo_h = logo_w / 4.49
        story.append(RLImage(logo_path, width=logo_w, height=logo_h, hAlign='LEFT'))
        story.append(Spacer(1, 4*mm))

    # ── Title ──
    story.append(Paragraph(
        f'<b>Stundennachweis {escape_xml(period_label)} &ndash; {escape_xml(customer)}</b>',
        styles['Title']
    ))

    # ── Meta ──
    total_hours = sum(e["total_hours"] for e in epics.values())
    story.append(Paragraph(f'<b>Kunde:</b> {escape_xml(customer)}', styles['Meta']))
    story.append(Paragraph(f'<b>Zeitraum:</b> {escape_xml(period_label)}', styles['Meta']))
    story.append(Paragraph(
        f'<b>Gesamtaufwand:</b> {format_hours_de(round(total_hours * 4) / 4)}',
        styles['Meta']
    ))
    story.append(Spacer(1, 3*mm))

    # ── Section heading ──
    story.append(Paragraph(
        '<b>Aufstellung der erbrachten Leistungen</b>',
        ParagraphStyle('LeistungTitle', fontName=BOLD_FONT, fontSize=11,
                        leading=14, textColor=CORS_RED, spaceBefore=2*mm, spaceAfter=3*mm)
    ))

    # ── Epic sections (sorted, numbered) ──
    sorted_epics = sorted(
        [(name, data) for name, data in epics.items() if data["total_hours"] > 0],
        key=lambda x: x[1]["total_hours"],
        reverse=True
    )

    for idx, (epic_name, epic_data) in enumerate(sorted_epics, 1):
        epic_hours = round(epic_data["total_hours"] * 4) / 4  # Round to nearest 0.25
        display_name = epic_name.replace("[Epic] ", "").replace("LP-", "LP-")

        # Section heading: "1. Epic Name (X Stunden)"
        story.append(Paragraph(
            f'<b>{idx}. {escape_xml(display_name)} ({format_hours_de(epic_hours)})</b>',
            styles['SectionTitle']
        ))

        # Tasks within this epic
        sorted_tasks = sorted(
            epic_data["tasks"].values(),
            key=lambda t: t["hours"],
            reverse=True
        )

        for task in sorted_tasks:
            if task["hours"] < 0.01:
                continue

            task_hours = round(task["hours"] * 4) / 4

            # Task title (bold)
            story.append(Paragraph(
                f'<b>{escape_xml(task["title"])}</b>',
                styles['TaskTitle']
            ))

            # Task description
            if task["description"]:
                story.append(Paragraph(
                    escape_xml(task["description"]),
                    styles['Body']
                ))

            # Ticket reference + hours (italic, grey)
            ticket_parts = []
            if task["ticket"]:
                ticket_parts.append(f'Tickets: {task["ticket"]}')
            ticket_parts.append(f'Aufwand: {format_hours_de(task_hours)}')
            story.append(Paragraph(
                ' | '.join(ticket_parts),
                styles['Ticket']
            ))

        # Separator between sections
        story.append(Spacer(1, 3*mm))
        story.append(HRFlowable(width="100%", thickness=0.5, color=GREY_LINE))
        story.append(Spacer(1, 3*mm))

    # ── Summary ──
    total_rounded = round(total_hours * 4) / 4
    story.append(Paragraph(
        f'<b>Gesamtaufwand: {format_hours_de(total_rounded)}</b>',
        styles['Summary']
    ))
    story.append(Paragraph(
        '<b>Aufschl\u00fcsselung nach Leistungsart:</b>',
        styles['Summary']
    ))

    for epic_name, epic_data in sorted_epics:
        epic_hours = round(epic_data["total_hours"] * 4) / 4
        pct = (epic_hours / total_rounded * 100) if total_rounded > 0 else 0
        display_name = epic_name.replace("[Epic] ", "")
        story.append(Paragraph(
            f'\u2022 {escape_xml(display_name)}: {format_hours_de(epic_hours)} ({pct:.1f}%)',
            styles['Bullet']
        ))

    # ── Closing text ──
    story.append(Spacer(1, 2*mm))
    story.append(HRFlowable(width="100%", thickness=0.5, color=GREY_LINE))

    # Determine focus area (largest epic)
    if sorted_epics:
        main_epic = sorted_epics[0][0].replace("[Epic] ", "")
        month_name = period_label.split(" ")[0] if " " in period_label else period_label
        story.append(Paragraph(
            f'Alle Leistungen wurden gem\u00e4\u00df Projektplan durchgef\u00fchrt, '
            f'erfolgreich abgenommen und dokumentiert. '
            f'Der Schwerpunkt im {escape_xml(month_name)} lag auf '
            f'{escape_xml(main_epic)}.',
            styles['Closing']
        ))

    doc.build(story)
    return output_path


# ── Main ────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description='Kunden-Stundennachweis PDF aus Everhour')
    parser.add_argument('--everhour-token', required=True, help='Everhour API token')
    parser.add_argument('--project-id', default='ev:195337863425313', help='Everhour project ID')
    parser.add_argument('--customer', required=True, help='Customer name (e.g. "Rutar Group")')
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

    print(f"Stundennachweis: {period_label} - {args.customer}")
    print(f"Zeitraum: {date_from} bis {date_to}")
    print(f"Fetching Everhour data...")

    epics = get_report_data(args.everhour_token, args.project_id, date_from, date_to)

    total = sum(e["total_hours"] for e in epics.values())
    task_count = sum(len(e["tasks"]) for e in epics.values())
    print(f"  {len(epics)} Kategorien, {task_count} Aufgaben, {total:.2f}h gesamt")

    os.makedirs(args.output, exist_ok=True)

    # Safe customer name for filename
    safe_customer = args.customer.replace(" ", "_").replace("/", "-")
    filename = f"{safe_customer}_Stundennachweis_{month:02d}.pdf"
    output_path = os.path.join(args.output, filename)

    print(f"Generating: {output_path}")
    generate_pdf(epics, args.customer, period_label, output_path, args.logo)
    print(f"Done: {filename}")


if __name__ == '__main__':
    main()
