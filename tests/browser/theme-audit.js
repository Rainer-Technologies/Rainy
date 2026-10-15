// Real-browser check of a UI theme (docs/THEMES.md#checking-a-theme).
// Sign in to Rainy, put on the theme to check, play a song, then evaluate this
// on Rainy's page (DevTools console or the Browser pane). It visits every view
// and the full player and compares every control with the theme's styles off
// and on; `window.themeAudit` holds the full report afterwards. Run it at a
// desktop width and at a phone width.
(async () => {
    const audit = await import('/js/theme/audit.js?theme-audit=' + Date.now());
    const report = await audit.auditAllViews();
    window.themeAudit = report;
    const lines = audit.describeReport(report);
    console.log(`[theme audit] ${report.theme} at ${report.width}px\n` + lines.join('\n'));
    return { theme: report.theme, width: report.width, problems: report.problems.length, lines };
})();
