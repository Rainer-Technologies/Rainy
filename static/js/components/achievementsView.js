import { Logger } from "../helper/logger.js";
import { Utils } from "../modules/utils.js";
import { useAchievementsService } from "../services/achievements.js";
import { a, Component, h, on, s, useRef } from "./index.js";

/** Ordered category metadata for grouping + section headers. */
const CATEGORIES = [
    { id: 'listening', label: 'Listening', icon: '🎧' },
    { id: 'discovery', label: 'Discovery', icon: '🧭' },
    { id: 'engagement', label: 'Engagement', icon: '❤️' },
    { id: 'dedication', label: 'Dedication', icon: '🔥' },
];

const RING_RADIUS = 52;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const CHECK_PATH = 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z';
const REFRESH_PATH = 'M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z';

const formatNumber = (n) => Number(n ?? 0).toLocaleString();

const formatDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

export class AchievementsView extends Component {
    static componentName = 'rainy-achievements-view';

    created() {
        this.set('achievements', [], { silent: true });
        this.set('summary', { unlocked: 0, total: 0, unlocked_ids: [] }, { silent: true });
        this.set('loading', false, { silent: true });
        this.set('evaluating', false, { silent: true });

        this._bodyRef = useRef(null);
        this._heroBigRef = useRef(null);
        this._heroOfRef = useRef(null);
        this._heroPctRef = useRef(null);
        this._ringFillRef = useRef(null);
        this._reevalBtnRef = useRef(null);

        this.watch('achievements', () => this._renderAll());
        this.watch('summary', () => this._renderHero());
        this.watch('loading', (_p, _o, v) => this._renderLoading(v));
        this.watch('evaluating', (_p, _o, v) => {
            this._reevalBtnRef.value?.classList.toggle('loading', v);
        });
    }

    /** Public: re-fetch and re-render (called by app.js on view switch). */
    refresh() {
        this.load();
    }

    async load() {
        this.set('loading', true);
        let data = null;
        try {
            const res = await useAchievementsService().getAchievements();
            if (res.error) {
                Logger.error('Failed to load achievements:', res.error);
            } else {
                data = res.value || {};
            }
        } catch (e) {
            Logger.error('Achievements load error:', e);
        }

        // Clear loading before publishing data so _renderAll isn't skipped.
        this.set('loading', false);
        if (data) {
            this.set('summary', data.summary || { unlocked: 0, total: 0, unlocked_ids: [] });
            this.set('achievements', data.achievements || []);
        }
    }

    async evaluate() {
        if (this.get('evaluating')) return;
        this.set('evaluating', true);
        try {
            const res = await useAchievementsService().evaluate();
            if (res.error) {
                Logger.error('Achievement evaluation failed:', res.error);
                Utils.showToast('Failed to re-evaluate achievements', 'error');
            } else {
                const count = res.value?.count ?? 0;
                Utils.showToast(
                    count > 0
                        ? `🎉 ${count} achievement${count === 1 ? '' : 's'} unlocked!`
                        : 'No new achievements unlocked',
                    count > 0 ? 'success' : 'info'
                );
                await this.load();
            }
        } catch (e) {
            Logger.error('Achievement evaluation error:', e);
            Utils.showToast('Failed to re-evaluate achievements', 'error');
        } finally {
            this.set('evaluating', false);
        }
    }

    // --- Rendering ---

    _renderLoading(isLoading) {
        const body = this._bodyRef.value;
        if (!body) return;
        if (isLoading) {
            body.replaceChildren(
                h.div(a.class('achievements-loading'),
                    h.div(a.class('loading-spinner')),
                    h.p('Loading your achievements…')
                )
            );
        }
    }

    _renderHero() {
        const summary = this.get('summary') || {};
        const achievements = this.get('achievements') || [];
        const unlocked = summary.unlocked ?? 0;
        const total = summary.total ?? achievements.length ?? 0;
        const pct = total > 0 ? Math.round((unlocked / total) * 100) : 0;

        if (this._heroBigRef.value) this._heroBigRef.value.textContent = String(unlocked);
        if (this._heroOfRef.value) this._heroOfRef.value.textContent = `of ${formatNumber(total)}`;
        if (this._heroPctRef.value) this._heroPctRef.value.textContent = `${pct}%`;

        const ring = this._ringFillRef.value;
        if (ring) {
            ring.style.strokeDasharray = String(RING_CIRCUMFERENCE);
            ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - pct / 100));
        }
    }

    _renderAll() {
        const body = this._bodyRef.value;
        if (!body) return;
        if (this.get('loading')) return;

        const achievements = this.get('achievements') || [];
        this._renderHero();

        if (!achievements.length) {
            body.replaceChildren(
                h.div(a.class('achievements-empty'),
                    h.div(a.class('empty-icon'), '🏆'),
                    h.h3('No Achievements Yet'),
                    h.p('Start listening to music to unlock your first trophy.')
                )
            );
            return;
        }

        const pendingFills = [];
        const sections = [];
        for (const cat of CATEGORIES) {
            const items = achievements.filter((x) => x.category === cat.id);
            if (!items.length) continue;
            sections.push(this._buildCategory(cat, items, pendingFills));
        }
        // Any achievements in unexpected categories still get shown.
        const known = new Set(CATEGORIES.map((c) => c.id));
        const others = achievements.filter((x) => !known.has(x.category));
        if (others.length) {
            sections.push(this._buildCategory({ id: 'other', label: 'Other', icon: '✨' }, others, pendingFills));
        }

        body.replaceChildren(...sections);

        // Animate progress bars from 0 to their target width after paint.
        requestAnimationFrame(() => {
            for (const { el, pct } of pendingFills) {
                el.style.width = `${pct}%`;
            }
        });
    }

    _buildCategory(cat, items, pendingFills) {
        const unlockedCount = items.filter((x) => x.unlocked).length;
        const complete = unlockedCount === items.length;

        return h.section(a.class('achievements-category'), a['data-category'](cat.id),
            h.div(a.class('achievements-category-header'),
                h.div(a.class('achievements-category-icon'), cat.icon),
                h.h2(a.class('achievements-category-title'), cat.label),
                h.span(a.class('achievements-category-count', complete ? 'complete' : ''),
                    `${unlockedCount}/${items.length}`),
                h.div(a.class('achievements-category-rule'))
            ),
            h.div(a.class('achievements-grid'),
                ...items.map((item, i) => this._buildCard(item, i, pendingFills))
            )
        );
    }

    _buildCard(ach, index, pendingFills) {
        const unlocked = !!ach.unlocked;
        const pct = Math.min(100, Math.round((ach.progress ?? 0) * 100));

        const icon = h.div(a.class('achievement-icon'), ach.icon || '🏆');

        const status = unlocked
            ? h.span(a.class('achievement-badge'),
                this._icon(CHECK_PATH, 14),
                'Unlocked')
            : null;

        const progressMeta = unlocked
            ? h.div(a.class('achievement-progress-meta'),
                h.span(a.class('frac'), 'Complete'),
                h.span(a.class('achievement-unlock-date'), formatDate(ach.unlocked_at)))
            : h.div(a.class('achievement-progress-meta'),
                h.span(a.class('frac'), `${formatNumber(ach.current)} / ${formatNumber(ach.threshold)}`),
                h.span(`${pct}%`));

        const fillRef = useRef(null);
        const fill = h.div(fillRef, a.class('achievement-progress-fill'));
        pendingFills.push({ el: fill, pct });

        return h.div(a.class('achievement-card', unlocked ? 'unlocked' : 'locked'),
            a.style(`--i:${index}`),
            a.title(ach.description || ''),
            h.div(a.class('card-top'), icon, status),
            h.div(a.class('achievement-name'), ach.name || ''),
            h.div(a.class('achievement-desc'), ach.description || ''),
            h.div(a.class('achievement-progress'),
                h.div(a.class('achievement-progress-track'), fill),
                progressMeta
            )
        );
    }

    _icon(pathD, size) {
        return s.svg(a.viewBox('0 0 24 24'), a.fill('currentColor'),
            a.width(String(size)), a.height(String(size)),
            s.path(a.d(pathD))
        );
    }

    render() {
        return h.div(a.class('achievements-view'),
            // Summary hero
            h.div(a.class('achievements-hero'),
                h.div(a.class('achievements-ring'),
                    s.svg(a.viewBox('0 0 120 120'),
                        s.defs(
                            s.linearGradient(a.id('achRingGradient'),
                                a.x1('0%'), a.y1('0%'), a.x2('100%'), a.y2('100%'),
                                s.stop(a.offset('0%'), a['stop-color']('#fa586a')),
                                s.stop(a.offset('100%'), a['stop-color']('#ff2d55'))
                            )
                        ),
                        s.circle(a.class('ring-track'),
                            a.cx('60'), a.cy('60'), a.r(String(RING_RADIUS))),
                        s.circle(this._ringFillRef, a.class('ring-fill'),
                            a.cx('60'), a.cy('60'), a.r(String(RING_RADIUS)))
                    ),
                    h.div(a.class('achievements-ring-label'),
                        h.span(this._heroPctRef, a.class('achievements-ring-pct'), '0%'),
                        h.span(a.class('achievements-ring-sub'), 'done')
                    )
                ),
                h.div(a.class('achievements-hero-info'),
                    h.span(a.class('achievements-hero-kicker'), 'Achievements'),
                    h.div(a.class('achievements-hero-count'),
                        h.span(this._heroBigRef, a.class('big'), '0'),
                        h.span(this._heroOfRef, a.class('of'), 'of 0')
                    ),
                    h.p(a.class('achievements-hero-desc'),
                        'Earn trophies as you listen, discover, and curate. Progress updates as you use Rainy.')
                ),
                h.div(a.class('achievements-hero-actions'),
                    h.button(this._reevalBtnRef, a.class('achievements-reeval-btn'),
                        a.title('Re-check all achievements'),
                        on.click(() => this.evaluate()),
                        this._icon(REFRESH_PATH, 16),
                        h.span('Re-evaluate'))
                )
            ),
            // Dynamic body (categories + cards, or loading/empty state)
            h.div(this._bodyRef, a.class('achievements-body'))
        );
    }
}

customElements.define(AchievementsView.componentName, AchievementsView);
