#!/usr/bin/env python3
"""Generate testing PDF for the Playlist Export (M3U/CSV) feature."""
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, ListFlowable, ListItem, HRFlowable

OUTPUT = "/opt/data/Rainy/docs/testing_playlist_export.pdf"

doc = SimpleDocTemplate(
    OUTPUT,
    pagesize=A4,
    topMargin=20*mm,
    bottomMargin=20*mm,
    leftMargin=18*mm,
    rightMargin=18*mm,
)

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name='FeatureTitle', parent=styles['Title'], fontSize=22, textColor=HexColor('#fa586a')))
styles.add(ParagraphStyle(name='SectionHead', parent=styles['Heading2'], fontSize=14, textColor=HexColor('#fa586a'), spaceBefore=14))
styles.add(ParagraphStyle(name='BodyText2', parent=styles['BodyText'], fontSize=10, leading=14))
styles.add(ParagraphStyle(name='StepText', parent=styles['BodyText'], fontSize=10, leading=14, leftIndent=8))

elements = []

elements.append(Paragraph("Playlist Export (M3U / CSV)", styles['FeatureTitle']))
elements.append(Spacer(1, 6))
elements.append(HRFlowable(width="100%", thickness=1, color=HexColor('#fa586a')))
elements.append(Spacer(1, 10))

# Description
elements.append(Paragraph("Feature Description", styles['SectionHead']))
elements.append(Paragraph(
    "Adds two new options to the playlist settings dropdown: <b>Export as M3U</b> and "
    "<b>Export as CSV</b>. M3U export produces an extended M3U file (#EXTM3U with #EXTINF "
    "metadata) containing full file paths, compatible with VLC, foobar2000, Winamp, and most "
    "desktop/mobile players. CSV export produces a spreadsheet-friendly file with columns: "
    "Title, Artist, Album, Duration, Genre, Year, and File Path.",
    styles['BodyText2']
))
elements.append(Spacer(1, 8))

# Why
elements.append(Paragraph("Why It Was Added", styles['SectionHead']))
elements.append(Paragraph(
    "Users often need to move playlists between apps or create backups. M3U is the universal "
    "playlist interchange format — exporting lets users open their Rainy playlists in VLC, "
    "foobar2000, MusicBee, or any other player without manual re-creation. CSV export enables "
    "spreadsheet analysis, sharing track lists, or importing into other services. This fills a "
    "gap where the only existing option was downloading the actual audio files as a ZIP.",
    styles['BodyText2']
))
elements.append(Spacer(1, 8))

# Testing steps
elements.append(Paragraph("Step-by-Step Testing Instructions", styles['SectionHead']))

steps = [
    ("Open Rainy in a browser and log in.", "You see the main library view."),
    ("Navigate to any playlist that contains at least 3 songs.", "The playlist view loads showing the song list."),
    ("Click the three-dot (⋮) playlist settings button in the section header.", "A dropdown menu appears with options: Edit Icon, Rename, Download Playlist, Export as M3U, Export as CSV, Delete."),
    ("Click 'Export as M3U'.", "A file download begins. The file is named after the playlist with a .m3u extension (e.g., 'My Playlist.m3u')."),
    ("Open the downloaded .m3u file in a text editor.", "The first line is '#EXTM3U'. Each song has a '#EXTINF:<duration>,<Artist> - <Title>' line followed by the full file path."),
    ("Open the .m3u file in VLC or another media player.", "The player loads all songs from the playlist in the correct order."),
    ("Go back to Rainy, open the same playlist settings dropdown, and click 'Export as CSV'.", "A file download begins with a .csv extension."),
    ("Open the CSV file in a spreadsheet app or text editor.", "The first row is the header: Title, Artist, Album, Duration, Genre, Year, File Path. Each subsequent row contains the song metadata."),
    ("Test with an empty playlist (create one, don't add songs, try to export).", "An error toast or message appears: 'Playlist is empty'. No file is downloaded."),
    ("Test with a playlist whose name has special characters (e.g., 'My 🎵 Playlist!').", "The downloaded filename is sanitized to only safe characters (e.g., 'My  Playlist.m3u')."),
]

for i, (step, expected) in enumerate(steps, 1):
    elements.append(Paragraph(f"<b>{i}.</b> {step}", styles['StepText']))
    elements.append(Paragraph(f"<i>Expected:</i> {expected}", styles['StepText']))
    elements.append(Spacer(1, 4))

elements.append(Spacer(1, 8))

# Edge cases
elements.append(Paragraph("Edge Cases to Check", styles['SectionHead']))

edge_cases = [
    "Playlist with songs that have missing metadata (no artist, no album, no genre) — CSV should show empty strings, M3U should show 'Unknown Artist - Unknown Title'.",
    "Playlist with a very long name — filename should be truncated/sanitized without breaking the download.",
    "Private playlist owned by another user — export should return 403 Forbidden.",
    "Non-existent playlist ID (manually navigate to /api/playlists/99999/export) — should return 404.",
    "Playlist with songs whose file paths contain spaces or unicode characters — M3U paths should be preserved correctly.",
    "Rapidly clicking export multiple times — should not cause server errors or duplicate downloads.",
    "Export while not logged in (cleared session) — should redirect to login or return 401.",
]

for ec in edge_cases:
    elements.append(Paragraph(f"• {ec}", styles['StepText']))
    elements.append(Spacer(1, 2))

elements.append(Spacer(1, 12))
elements.append(HRFlowable(width="100%", thickness=0.5, color=HexColor('#666666')))
elements.append(Spacer(1, 6))
elements.append(Paragraph("Rainy Music Player — Feature Testing Documentation", styles['BodyText2']))

doc.build(elements)
print(f"PDF generated: {OUTPUT}")
