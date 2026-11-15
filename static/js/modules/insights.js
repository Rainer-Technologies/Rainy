/**
 * Insights View — a single coherent listening dashboard.
 *
 * Layout (top to bottom):
 *   1. An animated streak hero banner (always visible) that evolves with the streak.
 *   2. A single-month calendar navigator (prev/next arrows) — the interactive
 *      protagonist. Click days to multi-select; every stat below filters to them.
 *   3. Selection-driven stats (totals, clock, trend, top artists/songs/genres/albums).
 *   4. On-this-day + recently played (only when nothing is selected).
 *
 * A "Wrapped" year-in-review is planned separately (backend /api/insights/wrapped
 * and InsightsService.getWrapped already exist for it).
 * No external chart library: charts are HTML flex bars; colours are theme tokens.
 */
import { Logger } from '../helper/logger.js';
import { Utils } from './utils.js';
import { useContext } from '../helper/context.js';
import { useInsightsService } from '../services/insights.js';
import { usePlaybackService } from '../services/playback.js';
import { getLanguage, t } from '../i18n/index.js';

const esc = Utils.escapeHtml;

function toISO(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

export class InsightsView {
    constructor(app, player) {
        this.app = app;
        this.player = player;
        this.currentView = null;
        this.selected = new Set();
        this.history = [];
        this.viewMonth = null;      // {y, m} currently displayed calendar month
        this._generalToken = 0;
        this.init();
    }

    init() {
        document.getElementById('nav-insights')?.addEventListener('click', (e) => {
            if (!this.app.shouldHandleInternalClick(e)) return;
            e.preventDefault();
            this.switchToInsights();
        });
        window.addEventListener('rainy:plays-recorded', () => {
            const view = document.getElementById('insights-view');
            if (this.currentView === 'insights' && view && !view.classList.contains('hidden')) {
                this.refresh();
            }
        });
    }

    async switchToInsights({ updateUrl = true } = {}) {
        if (updateUrl) return this.app.navigateTo('/insights');
        this.currentView = 'insights';
        useContext().set('current-view-type', 'insights');
        window.newViews?.hideAllViews();
        document.getElementById('insights-view')?.classList.remove('hidden');
        window.newViews?.updateNav('nav-insights');
        document.querySelector('.section-title').textContent = t('Insights');
        document.getElementById('library-subtitle').textContent = t('Your listening story and streaks');
        document.querySelector('.view-toggle')?.classList.add('hidden');
        document.getElementById('library-stats')?.classList.add('hidden');
        document.getElementById('playlist-menu-container')?.classList.add('hidden');
        document.querySelector('.section-header')?.classList.remove('hidden');
        this.selected = new Set();
        this.renderShell();
        await this.loadAll();
    }

    renderShell() {
        const container = document.getElementById('insights-view');
        if (!container) return;
        container.innerHTML = `
            <div class="insights-page">
                <div id="insights-streak-hero"></div>
                <section class="insights-calendar-section">
                    <div class="insights-calendar-head">
                        <div class="insights-calendar-titles">
                            <h2>${t('Listening calendar')}</h2>
                            <p>${t('Click days to filter your stats — click again to deselect.')}</p>
                        </div>
                        <div class="insights-selection">
                            <span class="insights-selection-label" id="insights-selection-label">${t('All time')}</span>
                            <button class="insights-clear-btn hidden" id="insights-clear-selection">${t('Clear')}</button>
                        </div>
                    </div>
                    <div id="insights-calendar"></div>
                </section>
                <section id="insights-stats" class="insights-stats"></section>
                <div id="insights-general-bottom"></div>
                <div class="insights-tooltip hidden" id="insights-tooltip" role="tooltip"></div>
            </div>
        `;
        document.getElementById('insights-clear-selection')?.addEventListener('click', () => this.clearSelection());
        this.wireTooltip(container);
    }

    wireTooltip(container) {
        const tip = document.getElementById('insights-tooltip');
        if (!tip) return;
        const move = (e) => {
            const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
            const y = Math.min(e.clientY + 16, window.innerHeight - tip.offsetHeight - 8);
            tip.style.left = `${Math.max(8, x)}px`;
            tip.style.top = `${Math.max(8, y)}px`;
        };
        container.addEventListener('mouseover', (e) => {
            const el = e.target.closest('[data-tip]');
            if (!el) return;
            tip.textContent = el.dataset.tip;
            tip.classList.remove('hidden');
            move(e);
        });
        container.addEventListener('mousemove', (e) => {
            if (!tip.classList.contains('hidden')) move(e);
        });
        container.addEventListener('mouseout', (e) => {
            if (e.target.closest('[data-tip]')) tip.classList.add('hidden');
        });
    }

    async loadAll() {
        const cal = document.getElementById('insights-calendar');
        if (cal) cal.innerHTML = `<div class="insights-loading">${t('Loading your insights…')}</div>`;
        try {
            const res = await useInsightsService().getSummary();
            if (res.error) {
                Logger.error('Insights load error:', res.error);
                if (cal) cal.innerHTML = `<div class="empty-state"><h3>${t('Could not load insights')}</h3></div>`;
                return;
            }
            this.history = res.value.history || [];
            this.renderStreakHero(res.value.streak || {});
            this.renderCalendar();
            this.renderStats(res.value);
            this.renderGeneral(res.value);
            this.updateSelectionBar();
        } catch (e) {
            Logger.error('Insights error:', e);
        }
    }

    async refresh() {
        try {
            const res = await useInsightsService().getSummary([...this.selected]);
            if (res.error) return Logger.error('Insights refresh error:', res.error);
            this.renderStreakHero(res.value.streak || {});
            this.renderStats(res.value);
            this.renderGeneral(res.value);
        } catch (e) {
            Logger.error('Insights refresh error:', e);
        }
    }

    // --- Streak hero (always first, animated, evolving) ---

    streakTier(current) {
        if (current <= 0) return { tier: 0, label: t('No streak yet') };
        if (current < 3) return { tier: 1, label: t('Spark') };
        if (current < 7) return { tier: 2, label: t('Flame') };
        if (current < 14) return { tier: 3, label: t('Blaze') };
        if (current < 30) return { tier: 4, label: t('Inferno') };
        return { tier: 5, label: t('Legend') };
    }

    flameSVG() {
        return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8C20 8.61 17.41 3.8 13.5.67zM11.71 19c-1.78 0-3.22-1.4-3.22-3.14 0-1.62 1.05-2.76 2.81-3.12 1.77-.36 3.6-1.21 4.62-2.58.39 1.29.59 2.65.59 4.04 0 2.65-2.15 4.8-4.8 4.8z"/></svg>`;
    }

    noteSVG() {
        return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>`;
    }

    renderStreakHero(streak) {
        const slot = document.getElementById('insights-streak-hero');
        if (!slot) return;
        const current = streak.current || 0;
        const longest = streak.longest || 0;
        const { tier, label } = this.streakTier(current);
        const icon = tier === 0 ? this.noteSVG() : this.flameSVG();
        slot.innerHTML = `
            <div class="streak-banner tier-${tier} ${streak.at_risk ? 'at-risk' : ''}">
                <div class="streak-banner-glow"></div>
                <div class="streak-banner-flame"><span class="streak-flame-anim">${icon}</span></div>
                <div class="streak-banner-main">
                    <div class="streak-banner-top">
                        <span class="streak-banner-number">${current}</span>
                        <span class="streak-banner-unit">${t('day streak')}</span>
                        <span class="streak-tier-badge">${esc(label)}</span>
                    </div>
                    <div class="streak-banner-message">${esc(this.streakMessage(streak))}</div>
                </div>
                <div class="streak-banner-best">
                    <span class="streak-banner-best-num">${longest}</span>
                    <span class="streak-banner-best-label">${t('best streak')}</span>
                </div>
            </div>
        `;
    }

    streakMessage(streak) {
        const current = streak.current || 0;
        const longest = streak.longest || 0;
        if (streak.today_active && current >= 7) return t("You're on fire! {n} days straight.", { n: current });
        if (streak.today_active) return t('Nice! {n} days in a row — keep it going.', { n: current });
        if (streak.at_risk) return t('Your {n}-day streak is at risk. Play something today to keep it!', { n: current });
        if (longest > 0) return t('Your best streak was {n} days. Start a new one today!', { n: longest });
        return t('Play a song to start your first listening streak.');
    }

    // --- Single-month calendar navigator (large, multi-select) ---

    monthKey(y, m) { return `${y}-${String(m).padStart(2, '0')}`; }

    renderCalendar() {
        const slot = document.getElementById('insights-calendar');
        if (!slot) return;
        const history = this.history;
        if (!history.length) {
            slot.innerHTML = `<div class="insights-empty">${t('No listening yet')}</div>`;
            return;
        }
        const map = {};
        history.forEach(h => { map[h.date] = h; });
        const max = Math.max(1, ...history.map(h => h.seconds || 0));
        const firstKey = history[0].date.slice(0, 7);
        const lastKey = history[history.length - 1].date.slice(0, 7);
        if (!this.viewMonth) {
            const [ly, lm] = lastKey.split('-').map(Number);
            this.viewMonth = { y: ly, m: lm };
        }
        let vk = this.monthKey(this.viewMonth.y, this.viewMonth.m);
        if (vk < firstKey) { const [a, b] = firstKey.split('-').map(Number); this.viewMonth = { y: a, m: b }; vk = firstKey; }
        if (vk > lastKey) { const [a, b] = lastKey.split('-').map(Number); this.viewMonth = { y: a, m: b }; vk = lastKey; }
        const { y, m } = this.viewMonth;
        const todayIso = toISO(new Date());
        const firstDay = new Date(y, m - 1, 1);
        const offset = (firstDay.getDay() + 6) % 7;
        const daysInMonth = new Date(y, m, 0).getDate();
        const monthLabel = new Intl.DateTimeFormat(getLanguage(), { month: 'long', year: 'numeric' }).format(firstDay);
        const canPrev = vk > firstKey;
        const canNext = vk < lastKey;
        const wd = this.weekdayNames();
        let cells = '';
        for (let i = 0; i < offset; i++) cells += '<span class="cal-blank"></span>';
        for (let d = 1; d <= daysInMonth; d++) {
            const iso = `${vk}-${String(d).padStart(2, '0')}`;
            const rec = map[iso];
            const secs = rec ? (rec.seconds || 0) : 0;
            const level = secs > 0 ? Math.max(1, Math.min(4, Math.ceil((secs / max) * 4))) : 0;
            const sel = this.selected.has(iso) ? ' selected' : '';
            const today = iso === todayIso ? ' today' : '';
            const future = iso > todayIso;
            const tip = `${iso} · ${Utils.formatHumanDuration(secs)}`;
            cells += `<button class="cal-day level-${level}${sel}${today}${future ? ' future' : ''}" data-date="${iso}" data-tip="${esc(tip)}" aria-pressed="${this.selected.has(iso)}"${future ? ' disabled' : ''}><span class="cal-day-num">${d}</span></button>`;
        }
        const chev = (dir) => `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${dir === 'prev' ? 'M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z' : 'M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z'}"/></svg>`;
        slot.innerHTML = `
            <div class="cal-nav">
                <button class="cal-arrow" id="cal-prev" ${canPrev ? '' : 'disabled'} aria-label="${esc(t('Previous month'))}">${chev('prev')}</button>
                <div class="cal-nav-label">${esc(monthLabel)}</div>
                <button class="cal-arrow" id="cal-next" ${canNext ? '' : 'disabled'} aria-label="${esc(t('Next month'))}">${chev('next')}</button>
            </div>
            <div class="cal-single">
                <div class="cal-weekdays">${wd.map(n => `<span>${esc(n)}</span>`).join('')}</div>
                <div class="cal-grid">${cells}</div>
            </div>
            <div class="cal-legend">
                <span>${t('Less')}</span>
                <span class="cal-sw level-0"></span><span class="cal-sw level-1"></span>
                <span class="cal-sw level-2"></span><span class="cal-sw level-3"></span>
                <span class="cal-sw level-4"></span>
                <span>${t('More')}</span>
            </div>
        `;
        document.getElementById('cal-prev')?.addEventListener('click', () => this.changeMonth(-1));
        document.getElementById('cal-next')?.addEventListener('click', () => this.changeMonth(1));
        slot.querySelectorAll('.cal-day[data-date]:not([disabled])').forEach(cell => {
            cell.addEventListener('click', () => this.toggleDay(cell.dataset.date));
        });
    }

    changeMonth(delta) {
        if (!this.viewMonth) return;
        let { y, m } = this.viewMonth;
        m += delta;
        if (m < 1) { m = 12; y--; }
        if (m > 12) { m = 1; y++; }
        this.viewMonth = { y, m };
        this.renderCalendar();   // clamped to the available range inside renderCalendar
    }

    toggleDay(dateIso) {
        if (this.selected.has(dateIso)) this.selected.delete(dateIso);
        else this.selected.add(dateIso);
        const cell = document.querySelector(`.cal-day[data-date="${dateIso}"]`);
        if (cell) {
            cell.classList.toggle('selected', this.selected.has(dateIso));
            cell.setAttribute('aria-pressed', String(this.selected.has(dateIso)));
        }
        this.updateSelectionBar();
        this.refresh();
    }

    clearSelection() {
        this.selected.clear();
        document.querySelectorAll('.cal-day.selected').forEach(c => {
            c.classList.remove('selected');
            c.setAttribute('aria-pressed', 'false');
        });
        this.updateSelectionBar();
        this.refresh();
    }

    updateSelectionBar() {
        const label = document.getElementById('insights-selection-label');
        const clear = document.getElementById('insights-clear-selection');
        const n = this.selected.size;
        if (label) label.textContent = n ? t('{n} days selected', { n }) : t('All time');
        if (clear) clear.classList.toggle('hidden', n === 0);
    }

    // --- Selection-driven stats ---

    renderStats(data) {
        const slot = document.getElementById('insights-stats');
        if (!slot) return;
        const ov = data.overview || {};
        const selected = this.selected.size > 0;
        slot.innerHTML = `
            <div class="insights-overview-grid">
                ${this.statTile(ov.total_plays || 0, t('Total Plays'))}
                ${this.statTile(ov.unique_songs || 0, t('Unique Songs'))}
                ${this.statTile(Utils.formatHumanDuration(ov.total_seconds || 0), t('Listening Time'))}
                ${this.statTile(ov.active_days || 0, t('Active Days'))}
            </div>
            <div class="insights-clock-row">
                ${this.clockCard(data.clock || {})}
                ${this.trendCard(data.trends || [], selected)}
            </div>
            <div class="insights-tops">
                ${this.topList(t('Top Artists'), (data.top_artists || []).map(a => ({ name: a.name, sub: t('{count} songs', { count: a.song_count }), count: a.play_count })))}
                ${this.topSongs(data.top_songs || [])}
                ${this.topList(t('Top Genres'), (data.top_genres || []).map(g => ({ name: g.name, count: g.play_count })))}
                ${this.topList(t('Top Albums'), (data.top_albums || []).map(a => ({ name: a.name, sub: a.secondary, count: a.play_count })))}
            </div>
        `;
        slot.querySelectorAll('.insights-song-row').forEach(row => {
            row.addEventListener('click', () => {
                const idx = parseInt(row.dataset.index);
                this.player.playSong(idx, data.top_songs || [], { type: 'insights', id: null });
            });
        });
    }

    statTile(value, label) {
        return `<div class="insights-stat"><div class="insights-stat-value">${esc(String(value))}</div><div class="insights-stat-label">${esc(label)}</div></div>`;
    }

    clockCard(clock) {
        const hours = clock.hours || new Array(24).fill(0);
        const weekdays = clock.weekdays || new Array(7).fill(0);
        const peakHour = hours.indexOf(Math.max(...hours));
        const hourLabels = hours.map((_, i) => `${i}`);
        const peakLabel = Math.max(...hours) > 0
            ? t('You listen most around {hour}:00', { hour: String(peakHour).padStart(2, '0') })
            : t('No listening yet');
        return `
            <div class="insights-card insights-clock">
                <h3>${t('Your listening clock')}</h3>
                <p class="insights-card-sub">${esc(peakLabel)}</p>
                ${this.barChart(hours, { height: 120, labelEvery: 6, labels: hourLabels, peak: true })}
                <div class="insights-weekday">
                    ${this.barChart(weekdays, { height: 64, labels: this.weekdayNames(), labelEvery: 1, peak: true })}
                </div>
            </div>
        `;
    }

    trendCard(trends, selected) {
        if (!trends.length) return '';
        const values = trends.map(d => d.seconds || 0);
        const labels = trends.map(d => d.date.slice(5));
        const total = values.reduce((a, b) => a + b, 0);
        const title = selected ? t('Selected days') : t('Last 30 days');
        const every = selected ? Math.max(1, Math.ceil(trends.length / 8)) : 7;
        return `
            <div class="insights-card insights-trend">
                <h3>${title}</h3>
                <p class="insights-card-sub">${t('{time} of listening', { time: Utils.formatHumanDuration(total) })}</p>
                ${this.barChart(values, { height: 150, labels, labelEvery: every, peak: true })}
            </div>
        `;
    }

    barChart(values, { height = 120, labelEvery = 0, labels = null, peak = false } = {}) {
        const n = values.length;
        if (!n) return '';
        const max = Math.max(1, ...values);
        const peakIdx = peak ? values.indexOf(Math.max(...values)) : -1;
        const bars = values.map((v, i) => {
            const pct = Math.max(v > 0 ? 3 : 0, (v / max) * 100);
            const label = labels ? labels[i] : String(i);
            return `<div class="insights-bar-col" data-tip="${esc(label)}: ${Utils.formatHumanDuration(v)}">
                <div class="insights-bar ${i === peakIdx ? 'peak' : ''}" style="height:${pct.toFixed(1)}%"></div>
            </div>`;
        }).join('');
        const labelRow = labelEvery
            ? `<div class="insights-bar-labels">${values.map((v, i) =>
                `<span>${i % labelEvery === 0 ? esc(labels ? labels[i] : String(i)) : ''}</span>`).join('')}</div>`
            : '';
        return `<div class="insights-chart" style="height:${height}px">${bars}</div>${labelRow}`;
    }

    weekdayNames() {
        try {
            const fmt = new Intl.DateTimeFormat(getLanguage(), { weekday: 'short' });
            return [0, 1, 2, 3, 4, 5, 6].map(d => fmt.format(new Date(2026, 10, 9 + d)));
        } catch (e) { return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; }
    }

    topList(title, items) {
        const rows = items.length ? items.map((it, i) => `
            <div class="insights-rank-row">
                <span class="insights-rank">${i + 1}</span>
                <span class="insights-rank-name">${esc(it.name || '')}${it.sub ? `<span class="insights-sub">${esc(it.sub)}</span>` : ''}</span>
                <span class="insights-rank-count">${t('{count} plays', { count: it.count })}</span>
            </div>`).join('')
            : `<div class="insights-empty">${t('Nothing yet')}</div>`;
        return `<div class="insights-card insights-top"><h3>${esc(title)}</h3><div class="insights-rank-list">${rows}</div></div>`;
    }

    topSongs(songs) {
        const rows = songs.length ? songs.map((s, i) => `
            <div class="insights-song-row" data-index="${i}">
                <span class="insights-rank">${i + 1}</span>
                <span class="insights-song-cover">${s.cover_path
                    ? `<img src="/api/music/cover/${encodeURIComponent(s.cover_path)}" alt="" loading="lazy">`
                    : '<span class="insights-no-cover">♪</span>'}</span>
                <span class="insights-song-info">
                    <span class="insights-song-title">${esc(s.title)}</span>
                    <span class="insights-song-artist">${esc(s.artist)}</span>
                </span>
                <span class="insights-rank-count">${t('{count} plays', { count: s.play_count })}</span>
            </div>`).join('')
            : `<div class="insights-empty">${t('Nothing yet')}</div>`;
        return `<div class="insights-card insights-top"><h3>${t('Top Songs')}</h3><div class="insights-rank-list">${rows}</div></div>`;
    }

    // --- General cards (only when nothing is selected) ---

    renderGeneral(data) {
        const bottom = document.getElementById('insights-general-bottom');
        if (!bottom) return;
        const hide = this.selected.size > 0;
        bottom.classList.toggle('hidden', hide);
        if (hide) { bottom.innerHTML = ''; return; }
        const token = ++this._generalToken;
        bottom.innerHTML = `
            <div class="insights-general-grid">
                ${this.onThisDay(data.on_this_day || [])}
                <div class="insights-card insights-recent" id="insights-recent-card">
                    <h3>${t('Recently Played')}</h3><div class="insights-loading">${t('Loading…')}</div>
                </div>
            </div>
        `;
        this.fillRecent(token);
    }

    async fillRecent(token) {
        try {
            const res = await usePlaybackService().getRecentlyPlayed(12);
            if (token !== this._generalToken) return;
            const card = document.getElementById('insights-recent-card');
            if (!card) return;
            const songs = res.value?.songs || [];
            const rows = songs.map((s, i) => `
                <div class="insights-song-row" data-index="${i}">
                    <span class="insights-song-cover">${s.cover_path
                        ? `<img src="/api/music/cover/${encodeURIComponent(s.cover_path)}" alt="" loading="lazy">`
                        : '<span class="insights-no-cover">♪</span>'}</span>
                    <span class="insights-song-info">
                        <span class="insights-song-title">${esc(s.title)}</span>
                        <span class="insights-song-artist">${esc(s.artist)}</span>
                    </span>
                    <span class="insights-recent-time">${this.timeAgo(s.played_at)}</span>
                </div>`).join('');
            card.innerHTML = `<h3>${t('Recently Played')}</h3><div class="insights-rank-list">${rows || `<div class="insights-empty">${t('No History Yet')}</div>`}</div>`;
            card.querySelectorAll('.insights-song-row').forEach(row => {
                row.addEventListener('click', () => {
                    const idx = parseInt(row.dataset.index);
                    this.player.playSong(idx, songs, { type: 'recent', id: null });
                });
            });
        } catch (e) { Logger.error('Recent error:', e); }
    }

    onThisDay(groups) {
        if (!groups.length) return '';
        const blocks = groups.map(g => `
            <div class="insights-otd-year">
                <div class="insights-otd-label">${g.year}</div>
                <div class="insights-otd-songs">
                    ${g.songs.slice(0, 4).map(s => `<span class="insights-otd-song">${esc(s.title)} <span class="insights-sub">${esc(s.artist)}</span></span>`).join('')}
                </div>
            </div>`).join('');
        return `<div class="insights-card insights-otd"><h3>${t('On this day')}</h3>${blocks}</div>`;
    }

    timeAgo(isoString) {
        if (!isoString) return '';
        const date = new Date(isoString);
        const diff = Math.floor((new Date() - date) / 1000);
        if (diff < 60) return t('just now');
        const rtf = new Intl.RelativeTimeFormat(getLanguage(), { style: 'short' });
        if (diff < 3600) return rtf.format(-Math.floor(diff / 60), 'minute');
        if (diff < 86400) return rtf.format(-Math.floor(diff / 3600), 'hour');
        if (diff < 604800) return rtf.format(-Math.floor(diff / 86400), 'day');
        return date.toLocaleDateString();
    }
}