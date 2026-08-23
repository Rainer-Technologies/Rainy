#!/usr/bin/env python3
"""Generate testing PDF for the Keyboard Shortcut Cheat Sheet feature."""
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
)

OUT = "/opt/data/Rainy/docs/testing_keyboard_shortcut_overlay.pdf"
ACCENT = colors.HexColor("#fa586a")
DARK = colors.HexColor("#1a1a1a")
GREY = colors.HexColor("#6e6e6e")

styles = getSampleStyleSheet()
title = ParagraphStyle("title", parent=styles["Title"], fontSize=22,
                       textColor=ACCENT, spaceAfter=4)
subtitle = ParagraphStyle("subtitle", parent=styles["Normal"], fontSize=11,
                          textColor=GREY, spaceAfter=10)
h2 = ParagraphStyle("h2", parent=styles["Heading2"], fontSize=14,
                    textColor=DARK, spaceBefore=14, spaceAfter=6)
body = ParagraphStyle("body", parent=styles["Normal"], fontSize=10.5,
                      leading=15, alignment=TA_LEFT, spaceAfter=6)
step = ParagraphStyle("step", parent=body, leftIndent=14, bulletIndent=2)

doc = SimpleDocTemplate(OUT, pagesize=A4,
                        leftMargin=20*mm, rightMargin=20*mm,
                        topMargin=18*mm, bottomMargin=18*mm)
story = []

story.append(Paragraph("Keyboard Shortcut Cheat Sheet Overlay", title))
story.append(Paragraph("Rainy Music Player &mdash; Feature Testing Document", subtitle))
story.append(HRFlowable(width="100%", thickness=1, color=ACCENT, spaceAfter=10))

story.append(Paragraph("Feature Description", h2))
story.append(Paragraph(
    "A full-screen overlay that lists every keyboard shortcut available in Rainy, "
    "organized into logical groups (Playback, Volume, Player, Speed, Search &amp; "
    "Navigation, General). It is toggled by pressing the <b>?</b> key and can be "
    "dismissed with <b>Esc</b>, a backdrop click, the close button, or pressing "
    "<b>?</b> again. The overlay is built as a self-contained module "
    "(<font face='Courier'>static/js/modules/shortcutOverlay.js</font>) following the "
    "same pattern as the existing Global Search overlay.", body))

story.append(Paragraph("Why It Was Added (User Benefit)", h2))
story.append(Paragraph(
    "Rainy has accumulated many keyboard shortcuts (play/pause, seek, volume, mute, "
    "fullscreen, like, A-B repeat, playback speed, equalizer, search). New and casual "
    "users have no way to discover them without reading source code. A discoverable, "
    "always-available cheat sheet lowers the learning curve, speeds up power-user "
    "workflows, and reduces the need to memorize keys &mdash; improving the overall "
    "listening experience.", body))

story.append(Paragraph("Step-by-Step Testing Instructions", h2))
steps = [
    ("Open Rainy in a browser and log in so the player loads.",
     "The app loads to the library view with no console errors."),
    ("Press the <b>?</b> key (Shift+/ on most keyboards).",
     "The shortcut overlay appears centered on screen with a dimmed, blurred backdrop and a smooth slide-in animation."),
    ("Verify the overlay shows six groups: Playback, Volume, Player, Speed, Search &amp; Navigation, General.",
     "All groups render in a two-column grid, each with an icon, uppercase title, and a list of key/action rows."),
    ("Confirm specific shortcuts are listed correctly (e.g. Space = Play/Pause, M = Mute, F = Fullscreen, º or / = Global search, ? = Toggle this sheet).",
     "Each row shows styled <font face='Courier'>&lt;kbd&gt;</font> key caps and a right-aligned action description; multi-key combos show a '+' between caps."),
    ("Press <b>?</b> again while the overlay is open.",
     "The overlay closes (toggles off)."),
    ("Reopen with <b>?</b>, then press <b>Esc</b>.",
     "The overlay closes via the Escape handler."),
    ("Reopen with <b>?</b>, then click the dimmed backdrop outside the panel.",
     "The overlay closes via the backdrop click handler."),
    ("Reopen with <b>?</b>, then click the X close button in the header.",
     "The overlay closes."),
    ("Click into the search input (or any text field) and press <b>?</b>.",
     "The '?' is typed into the field and the overlay does NOT open (shortcut is suppressed while typing)."),
    ("Open the Global Search overlay (º or /) and the shortcut overlay, then press Esc.",
     "Esc closes the top-most overlay first without errors."),
    ("Resize the browser window to a narrow width (under ~600px).",
     "The overlay switches to a single-column layout and remains fully readable / scrollable."),
    ("Reload the page and press <b>?</b> again.",
     "The overlay still works after a fresh load (module re-initializes on DOMContentLoaded)."),
]
for i, (instr, expect) in enumerate(steps, 1):
    story.append(Paragraph(f"<b>{i}.</b> {instr}", step))
    story.append(Paragraph(f"<i>Expected:</i> {expect}",
                 ParagraphStyle("exp", parent=step, leftIndent=28,
                                textColor=GREY, fontSize=10, spaceAfter=8)))

story.append(Paragraph("Edge Cases to Check", h2))
edges = [
    "Rapidly pressing ? multiple times should cleanly toggle open/closed with no duplicate overlays in the DOM (only one #shortcut-overlay element).",
    "Opening the overlay while a popup menu (sleep timer / speed / equalizer) is open should not break either; both should coexist or close gracefully.",
    "The overlay must not capture focus away from an active audio playback &mdash; pressing Space while the overlay is open should still toggle play/pause (verify no regression).",
    "On a keyboard where ? requires Shift, ensure the key event is still detected (e.key === '?').",
    "Verify no horizontal overflow / clipping on the panel at various zoom levels (50%-200%).",
    "Confirm the overlay z-index (4000) sits above player menus (z-index 3000) but does not block the login/setup screens on first load.",
    "Check that the backdrop blur renders on supported browsers and degrades gracefully (solid dark overlay) where unsupported.",
]
for e in edges:
    story.append(Paragraph(f"&bull;&nbsp; {e}", body))

doc.build(story)
print(f"PDF written to {OUT}")
