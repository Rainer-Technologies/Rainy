#!/usr/bin/env python3
"""Generate testing PDF for the Crossfade feature."""
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT

ACCENT = HexColor("#fa586a")
BG_DARK = HexColor("#1a1a1a")
TEXT_PRIMARY = HexColor("#ffffff")
TEXT_SECONDARY = HexColor("#a1a1a1")
GREEN = HexColor("#34c759")

styles = getSampleStyleSheet()

title_style = ParagraphStyle(
    "FeatureTitle", parent=styles["Title"],
    fontSize=22, textColor=ACCENT, spaceAfter=6, alignment=TA_LEFT,
)
subtitle_style = ParagraphStyle(
    "Subtitle", parent=styles["Normal"],
    fontSize=11, textColor=TEXT_SECONDARY, spaceAfter=16,
)
h2_style = ParagraphStyle(
    "H2", parent=styles["Heading2"],
    fontSize=14, textColor=ACCENT, spaceBefore=16, spaceAfter=8,
)
body_style = ParagraphStyle(
    "Body", parent=styles["Normal"],
    fontSize=10, leading=15, textColor=TEXT_PRIMARY, spaceAfter=6,
)
step_style = ParagraphStyle(
    "Step", parent=styles["Normal"],
    fontSize=10, leading=15, textColor=TEXT_PRIMARY, spaceAfter=4,
    leftIndent=12,
)
expected_style = ParagraphStyle(
    "Expected", parent=styles["Normal"],
    fontSize=9.5, leading=14, textColor=GREEN, spaceAfter=8,
    leftIndent=24,
)
edge_style = ParagraphStyle(
    "Edge", parent=styles["Normal"],
    fontSize=10, leading=14, textColor=TEXT_PRIMARY, spaceAfter=4,
    leftIndent=12, bulletIndent=0,
)

def build():
    doc = SimpleDocTemplate(
        "/opt/data/Rainy/docs/testing_crossfade.pdf",
        pagesize=A4,
        topMargin=20*mm, bottomMargin=20*mm,
        leftMargin=18*mm, rightMargin=18*mm,
    )
    story = []

    # Title
    story.append(Paragraph("🎵 Crossfade Between Songs", title_style))
    story.append(Paragraph("Rainy Music Player — Feature Testing Document", subtitle_style))
    story.append(HRFlowable(width="100%", thickness=1, color=ACCENT, spaceAfter=12))

    # Description
    story.append(Paragraph("Feature Description", h2_style))
    story.append(Paragraph(
        "Crossfade smoothly blends the end of one song into the start of the next by "
        "overlapping audio playback. A secondary &lt;audio&gt; element fades in the upcoming "
        "track while the current track fades out using an equal-power curve. The feature "
        "includes a toggle button (player bar + fullscreen), adjustable duration (1–12 s), "
        "quick presets (2/4/6/8/10 s), a keyboard shortcut (X), and persistent settings "
        "via localStorage.",
        body_style
    ))

    # Why
    story.append(Paragraph("Why It Was Added", h2_style))
    story.append(Paragraph(
        "Gapless or blended transitions eliminate the jarring silence between tracks, "
        "making album listening, DJ-style mixes, and background music sessions feel "
        "continuous and professional. This is a quality-of-life feature that modern "
        "music apps (Spotify, Apple Music) ship by default.",
        body_style
    ))

    # Testing Steps
    story.append(Paragraph("Step-by-Step Testing Instructions", h2_style))

    steps = [
        ("1. Open Rainy", "Navigate to http://localhost:6969 in a browser. Log in."),
        ("2. Locate the Crossfade button",
         "In the player bar (bottom), find the button with two crossing arrows (⟨⟩) "
         "next to the Equalizer button. It is also available in the fullscreen player controls."),
        ("3. Open the Crossfade menu",
         "Click the Crossfade button. A popup menu should appear above the button."),
        ("4. Enable Crossfade",
         "Click the power button (⏻) in the menu header. The button should turn accent-colored "
         "and a toast should say 'Crossfade on (5s)'."),
        ("5. Adjust duration via slider",
         "Drag the 'Duration' slider to 8s. The value label should update to '8s'."),
        ("6. Use a preset",
         "Click the '4s' preset button. The slider should snap to 4 and the button highlights."),
        ("7. Play a playlist",
         "Start playing a playlist with at least 2 songs. Let the first song play until "
         "within the crossfade window of its end."),
        ("8. Observe the crossfade",
         "As the first song nears its end, the next song should begin playing softly while "
         "the current song fades out. Both overlap for the configured duration."),
        ("9. Check the now-playing info",
         "After the crossfade completes, the title/artist/artwork should update to the new song."),
        ("10. Toggle off via keyboard",
         "Press 'X' on the keyboard. A toast should say 'Crossfade off' and the button "
         "should lose its active color."),
        ("11. Toggle on via keyboard",
         "Press 'X' again. Crossfade re-enables with the previously saved duration."),
        ("12. Verify persistence",
         "Refresh the page (F5). The crossfade button should retain its enabled/disabled "
         "state and duration from before the refresh."),
        ("13. Test in fullscreen player",
         "Open the fullscreen player (click artwork or press F). The crossfade button "
         "should be visible and functional there too."),
        ("14. Manual skip during crossfade",
         "While a crossfade is in progress, click the Next button. The crossfade should "
         "cancel cleanly and the next song should start normally."),
        ("15. Pause during crossfade",
         "While a crossfade is in progress, press Space to pause. The secondary audio "
         "should stop and the crossfade should cancel."),
    ]

    for title, desc in steps:
        story.append(Paragraph(f"<b>{title}</b>", step_style))
        story.append(Paragraph(desc, step_style))

    # Expected Results
    story.append(Paragraph("Expected Results", h2_style))
    expected = [
        "Crossfade menu opens/closes correctly and positions above the anchor button.",
        "Power toggle enables/disables crossfade with visual feedback (button color + toast).",
        "Duration slider and presets update the value in real time and persist to localStorage.",
        "During crossfade: current song volume decreases while next song volume increases "
        "following an equal-power (cos/sin) curve — no abrupt volume jumps.",
        "After crossfade: primary audio takes over seamlessly at the correct position; "
        "secondary audio is stopped and cleaned up.",
        "Now-playing UI (title, artist, artwork, progress bar, media session) updates correctly.",
        "Keyboard shortcut X toggles crossfade on/off from anywhere (except input fields).",
        "Settings survive page refresh (localStorage persistence).",
        "Manual skip or pause during crossfade cancels it cleanly without audio glitches.",
        "Repeat-one mode does NOT trigger crossfade (song loops normally).",
        "End of playlist without repeat-all: no crossfade triggered, playback stops naturally.",
    ]
    for item in expected:
        story.append(Paragraph(f"✓ {item}", expected_style))

    # Edge Cases
    story.append(Paragraph("Edge Cases to Check", h2_style))
    edges = [
        "Very short songs (< crossfade duration + 2s): crossfade should NOT trigger.",
        "Single-song playlist: no crossfade (no next track).",
        "Shuffle mode: crossfade should pick a random next song.",
        "Repeat-all at end of playlist: crossfade wraps to the first song.",
        "Autoplay blocked by browser: crossfade falls back to normal transition gracefully.",
        "Rapid toggling of crossfade on/off: no orphaned audio or animation frames.",
        "Volume at 0: crossfade still runs but both tracks are silent.",
        "EQ enabled simultaneously: crossfade uses the secondary audio element which "
        "bypasses the EQ graph (acceptable — EQ applies to primary only).",
        "Seeking during crossfade window: crossfade may trigger early; should still work.",
        "Multiple browser tabs: each tab has independent crossfade state.",
    ]
    for item in edges:
        story.append(Paragraph(f"• {item}", edge_style))

    doc.build(story)
    print("PDF generated: /opt/data/Rainy/docs/testing_crossfade.pdf")

if __name__ == "__main__":
    build()
