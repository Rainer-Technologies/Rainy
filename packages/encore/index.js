/**
 * Encore's ambient wash: the colours of the song playing, washed over the top
 * of the page and tinting the player bar, the way streaming apps light up
 * behind the music. Everything is drawn in the theme's own layer behind the
 * app (ctx.layers.back) and through one variable (--theme-ambient); Rainy's
 * markup is left alone (docs/THEMES.md).
 */
export default class EncoreAmbient {
    mount(ctx) {
        this.ctx = ctx;
        this.wash = document.createElement('div');
        this.wash.className = 'theme-encore-wash';
        if (ctx.reducedMotion) this.wash.classList.add('is-still');
        ctx.layers.back.appendChild(this.wash);
        this.paint(ctx.state.get().track);
        ctx.on('track', (track) => this.paint(track));
    }

    async paint(track) {
        const mine = (this.turn = (this.turn || 0) + 1);
        const colors = track && track.cover ? await this.ctx.colors(track.cover) : null;
        if (this.ctx.signal.aborted || mine !== this.turn) return;
        const c = colors && (colors.vivid || colors.average);
        // A colour too dark to show anything is no colour at all.
        const usable = c && Math.max(...c) > 40;
        this.ctx.setVar('--theme-ambient', usable ? c.map(Math.round).join(' ') : null);
        this.wash.classList.toggle('is-on', !!usable);
    }

    unmount() {
        this.turn = -1;
        this.wash?.remove();
    }
}
