#!/usr/bin/env python3
"""Generate testing PDF for Playback Speed Control feature."""

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, ListFlowable, ListItem
from reportlab.lib.enums import TA_LEFT

# Output path
OUTPUT_PATH = "/opt/data/Rainy/docs/testing_playback_speed.pdf"

# Create document
doc = SimpleDocTemplate(
    OUTPUT_PATH,
    pagesize=letter,
    rightMargin=0.75*inch,
    leftMargin=0.75*inch,
    topMargin=0.75*inch,
    bottomMargin=0.75*inch
)

# Styles
styles = getSampleStyleSheet()
title_style = ParagraphStyle(
    'CustomTitle',
    parent=styles['Heading1'],
    fontSize=20,
    textColor=HexColor('#fa586a'),
    spaceAfter=12,
    alignment=TA_LEFT
)
heading_style = ParagraphStyle(
    'CustomHeading',
    parent=styles['Heading2'],
    fontSize=14,
    textColor=HexColor('#333333'),
    spaceAfter=8,
    spaceBefore=12
)
body_style = ParagraphStyle(
    'CustomBody',
    parent=styles['Normal'],
    fontSize=10,
    leading=14,
    spaceAfter=6
)

# Content
story = []

# Title
story.append(Paragraph("Playback Speed Control — Testing Guide", title_style))
story.append(Spacer(1, 0.2*inch))

# Description
story.append(Paragraph("Feature Description", heading_style))
story.append(Paragraph(
    "Playback Speed Control allows users to adjust the playback rate of audio tracks from 0.25x to 3x. "
    "The feature includes a popup menu with preset speeds (0.5x, 0.75x, 1x, 1.25x, 1.5x, 1.75x, 2x) and a "
    "fine-tune slider for precise control. The selected speed persists across page reloads via localStorage. "
    "Keyboard shortcuts: [ (decrease by 0.25x), ] (increase by 0.25x), 0 (reset to 1x).",
    body_style
))
story.append(Spacer(1, 0.1*inch))

# Why it was added
story.append(Paragraph("User Benefit", heading_style))
story.append(Paragraph(
    "Musicians practicing along with songs can slow down complex passages to learn them note-by-note. "
    "Language learners can slow down audio to catch pronunciation details. Podcast listeners can speed up "
    "content to save time. The feature enhances Rainy's utility for practice, learning, and efficient listening.",
    body_style
))
story.append(Spacer(1, 0.1*inch))

# Testing instructions
story.append(Paragraph("Testing Instructions", heading_style))

test_steps = [
    "Open Rainy in a browser (http://localhost:6969) and log in.",
    "Play any song from your library.",
    "Locate the speed button (gauge icon with '1x' label) in the bottom player bar, next to the A-B repeat button.",
    "Click the speed button. A popup menu should appear with preset buttons (0.5x–2x) and a fine-tune slider.",
    "Click the '1.5x' preset button. The audio should immediately play faster, and the button label should update to '1.5x'.",
    "Click the speed button again. The '1.5x' preset should be highlighted (accent color background).",
    "Use the fine-tune slider to set speed to 1.25x. The slider value display should show '1.25x' and audio should adjust.",
    "Click 'Reset to 1x' button. Speed should return to normal (1x) and the label should show '1x'.",
    "Refresh the page. The speed setting should persist (if you set it to something other than 1x before refresh).",
    "Open the fullscreen player (click the now-playing bar or press F). Verify the speed button appears in the fullscreen controls.",
    "Test keyboard shortcuts: press ] to increase speed by 0.25x, [ to decrease, and 0 to reset to 1x. A toast notification should confirm each change.",
    "Try extreme values: use the slider to set 0.25x (minimum) and 3x (maximum). Audio should play at those speeds without errors.",
    "Switch to a different song. The speed setting should carry over to the new track.",
    "Test on mobile viewport (resize browser to narrow width). The speed button should remain accessible in the player bar."
]

story.append(ListFlowable(
    [ListItem(Paragraph(step, body_style), leftIndent=20) for step in test_steps],
    bulletType='1',
    leftIndent=0
))
story.append(Spacer(1, 0.1*inch))

# Expected results
story.append(Paragraph("Expected Results", heading_style))

expected = [
    "Speed button is visible and clickable in both bottom bar and fullscreen player.",
    "Popup menu appears above the button with correct positioning (no overflow off-screen).",
    "Preset buttons apply speed instantly; active preset is visually highlighted.",
    "Fine-tune slider updates speed in real-time as you drag.",
    "Speed label (e.g., '1.5x') updates on both bottom bar and fullscreen buttons.",
    "Speed setting persists in localStorage and restores on page reload.",
    "Keyboard shortcuts [ ] 0 work and show toast notifications.",
    "Speed applies to all subsequent songs until changed or reset.",
    "No JavaScript errors in browser console during speed changes.",
    "UI remains responsive and styled correctly at all speeds."
]

story.append(ListFlowable(
    [ListItem(Paragraph(item, body_style), leftIndent=20) for item in expected],
    bulletType='bullet',
    leftIndent=0
))
story.append(Spacer(1, 0.1*inch))

# Edge cases
story.append(Paragraph("Edge Cases to Check", heading_style))

edge_cases = [
    "Rapidly click speed presets — no UI glitches or duplicate menus.",
    "Click speed button while menu is already open — menu should close or reposition correctly.",
    "Click outside the menu — it should close.",
    "Set speed to 3x, then switch songs — speed should persist.",
    "Use keyboard shortcuts while typing in a search box — shortcuts should NOT trigger (input guard).",
    "Test with very short songs (< 10 seconds) — speed changes should still work smoothly.",
    "Clear localStorage manually, then reload — speed should default to 1x gracefully.",
    "Test in different browsers (Chrome, Firefox, Safari) — slider and menu should render consistently."
]

story.append(ListFlowable(
    [ListItem(Paragraph(item, body_style), leftIndent=20) for item in edge_cases],
    bulletType='bullet',
    leftIndent=0
))

# Build PDF
doc.build(story)
print(f"PDF generated: {OUTPUT_PATH}")
