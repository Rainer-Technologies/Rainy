#!/usr/bin/env python3
"""Generate testing PDF for the Equalizer feature."""
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, ListFlowable, ListItem, HRFlowable
)

OUT = "/opt/data/Rainy/docs/testing_equalizer.pdf"

styles = getSampleStyleSheet()
title_style = ParagraphStyle("Title2", parent=styles["Title"], fontSize=22, spaceAfter=6)
h2 = ParagraphStyle("H2", parent=styles["Heading2"], fontSize=14, spaceBefore=14, spaceAfter=6,
                     textColor=HexColor("#1a73e8"))
body = ParagraphStyle("Body2", parent=styles["BodyText"], fontSize=11, leading=15, spaceAfter=6)
step = ParagraphStyle("Step", parent=body, leftIndent=18, spaceAfter=4)
expect = ParagraphStyle("Expect", parent=body, leftIndent=36, fontSize=10,
                        textColor=HexColor("#333333"), spaceAfter=8)

doc = SimpleDocTemplate(OUT, topMargin=0.8*inch, bottomMargin=0.8*inch,
                        leftMargin=0.9*inch, rightMargin=0.9*inch)
story = []

# ── Title ──
story.append(Paragraph("🎵 Equalizer (10-Band EQ)", title_style))
story.append(HRFlowable(width="100%", thickness=1, color=HexColor("#cccccc"), spaceAfter=12))

# ── Description ──
story.append(Paragraph("Feature Description", h2))
story.append(Paragraph(
    "A 10-band graphic equalizer built with the Web Audio API. It inserts ten peaking "
    "BiquadFilter nodes (32 Hz – 16 kHz) between the &lt;audio&gt; element and the output, "
    "letting the user boost or cut each frequency band by ±12 dB. Ten genre/mood presets "
    "(Flat, Bass Boost, Treble Boost, Vocal, Rock, Pop, Jazz, Electronic, Classical, Podcast) "
    "are included, plus a power toggle and a reset-to-flat button. Settings persist in "
    "localStorage across sessions. The EQ button appears in both the bottom player bar and "
    "the fullscreen player, and can be opened with the <b>E</b> keyboard shortcut.",
    body))

# ── Why ──
story.append(Paragraph("Why It Was Added", h2))
story.append(Paragraph(
    "Different music genres, headphones, and room acoustics benefit from frequency shaping. "
    "An equalizer lets listeners tailor the sound to their preference — boosting bass for "
    "workout playlists, lifting vocals for podcasts, or adding sparkle to acoustic tracks — "
    "without needing external system-level EQ software. It makes Rainy a more complete, "
    "self-contained listening experience.",
    body))

# ── Testing Steps ──
story.append(Paragraph("Step-by-Step Testing Instructions", h2))

steps = [
    ("Open Rainy in a browser and log in. Start playing any song.",
     "Audio plays normally through the default output."),
    ("Click the <b>Equalizer button</b> (slider icon) in the bottom player bar, to the right "
     "of the Playback Speed button.",
     "A popup panel titled 'Equalizer' appears above the button, showing 10 vertical sliders "
     "(32 Hz to 16k Hz), a row of preset buttons, a power toggle (⏻), and a 'Reset to Flat' button."),
    ("Click the <b>'Bass Boost'</b> preset button.",
     "The first 3–4 sliders (32–250 Hz) jump upward to +6/+5/+4/+2 dB. The bass in the playing "
     "song becomes noticeably stronger. The 'Bass Boost' button is highlighted."),
    ("Click the <b>'Treble Boost'</b> preset.",
     "The high-frequency sliders (1k–16k Hz) move up; the sound becomes brighter/crisper. "
     "'Treble Boost' is now highlighted and 'Bass Boost' is deselected."),
    ("Manually drag the <b>1000 Hz slider</b> down to −6 dB.",
     "The value label above the slider shows '−6'. All preset buttons deselect (custom curve). "
     "The midrange/vocal presence in the song is reduced."),
    ("Click the <b>power toggle (⏻)</b> to turn the EQ off.",
     "All sliders snap to 0 dB and the audio returns to flat/unprocessed sound. The power "
     "button loses its accent highlight."),
    ("Click the power toggle again to <b>re-enable</b> the EQ.",
     "The previously saved custom curve (including the −6 dB at 1 kHz) is restored and applied."),
    ("Click <b>'Reset to Flat'</b>.",
     "All sliders return to 0 dB, 'Flat' preset is highlighted, and audio is unprocessed."),
    ("Close the EQ menu (click outside it). <b>Reload the page</b> and start a song. "
     "Open the EQ menu again.",
     "The last-used gains and enabled/disabled state are restored from localStorage — "
     "settings survived the reload."),
    ("Open the <b>fullscreen player</b> (press F or click the expand button) and click the "
     "EQ button there.",
     "The same EQ popup appears anchored to the fullscreen EQ button and controls the same "
     "audio graph."),
    ("Press the <b>E key</b> on the keyboard (while not typing in a field).",
     "The EQ popup opens anchored to the bottom-bar EQ button."),
    ("With the EQ open, press <b>Escape</b> or click outside the menu.",
     "The EQ menu closes."),
]

for i, (action, expected) in enumerate(steps, 1):
    story.append(Paragraph(f"<b>Step {i}.</b> {action}", step))
    story.append(Paragraph(f"<i>Expected:</i> {expected}", expect))

# ── Edge Cases ──
story.append(Paragraph("Edge Cases to Check", h2))
edge_cases = [
    "Open the EQ before any song has started playing — the AudioContext should still be "
    "created on the button click (user gesture) without errors.",
    "Rapidly switch between presets while a song plays — audio should not glitch, stutter, "
    "or produce clicks.",
    "Set all sliders to +12 dB (maximum boost) — audio should not clip or distort badly "
    "(some loudness increase is expected).",
    "Set all sliders to −12 dB — audio should become very quiet but not silent or broken.",
    "Open the EQ menu from the bottom bar, then switch to fullscreen and open it there — "
    "only one menu should exist at a time (the first is removed).",
    "Use the EQ while the Sleep Timer or Playback Speed is also active — all three features "
    "should coexist without conflict.",
    "Clear localStorage (DevTools → Application → Local Storage → Clear All), reload, and "
    "open the EQ — it should default to Flat / disabled gracefully.",
    "Test in a browser that does not support AudioContext (rare) — a toast error "
    "'Equalizer not supported' should appear and the app should not crash.",
    "Seek to a different position in the song while the EQ is active — the EQ processing "
    "should continue seamlessly.",
    "Switch to a different song (next/prev) while the EQ is active — the EQ should remain "
    "applied to the new track without needing to re-open the menu.",
]
story.append(ListFlowable(
    [ListItem(Paragraph(ec, body), leftIndent=12) for ec in edge_cases],
    bulletType="bullet", start="•", leftIndent=18
))

doc.build(story)
print(f"PDF written to {OUT}")
