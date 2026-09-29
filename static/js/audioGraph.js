/**
 * One WebAudio graph per <audio> element.
 *
 * createMediaElementSource() may only be called ONCE per element, so the
 * equalizer and the light show's live analyser must share a single context
 * and source. Topology:
 *
 *     source ─▶ [insert chain, e.g. EQ filters] ─▶ output ─▶ destination
 *                                                    └──▶ analyser (tap)
 *
 * Built lazily: nothing touches WebAudio until a feature actually needs it,
 * because once the element is routed through a context, a suspended context
 * means silence (callers resume it on play — see player.js).
 */
const graphs = new WeakMap();

/** Existing graph for an element, or null (never creates one). */
export function peekAudioGraph(audioEl) {
    return (audioEl && graphs.get(audioEl)) || null;
}

/** Get (or lazily build) the shared graph for an element. Null if unsupported. */
export function getAudioGraph(audioEl) {
    if (!audioEl) return null;
    const existing = graphs.get(audioEl);
    if (existing) return existing;

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;

    let ctx;
    let source;
    try {
        ctx = new Ctx();
        source = ctx.createMediaElementSource(audioEl);
    } catch (e) {
        if (ctx) ctx.close().catch(() => {});
        return null;
    }
    const output = ctx.createGain();
    output.connect(ctx.destination);
    source.connect(output);

    const graph = {
        ctx,
        source,
        output,
        analyser: null,

        /** Route source → first … last → output (replaces any previous chain). */
        setChain(first, last) {
            source.disconnect();
            if (first && last) {
                source.connect(first);
                last.connect(output);
            } else {
                source.connect(output);
            }
        },

        /** Post-chain analyser tap (created once, shared). */
        tapAnalyser() {
            if (!graph.analyser) {
                const a = ctx.createAnalyser();
                a.fftSize = 2048;
                a.smoothingTimeConstant = 0.4;
                output.connect(a);
                graph.analyser = a;
            }
            return graph.analyser;
        },

        resume() {
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        },
    };
    graphs.set(audioEl, graph);
    if (ctx.state === 'suspended' && !audioEl.paused) graph.resume();
    return graph;
}
