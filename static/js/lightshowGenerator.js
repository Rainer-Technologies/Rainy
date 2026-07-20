/**
 * Browser-side orchestration for pregenerating a light show:
 * download the song, decode it, run the offline analysis, save the score.
 */
import { Logger } from './helper/logger.js';
import { analyzePcm, cancelError, isLightshowCancel } from './lightshowAnalysis.js';
import { useLightshowService } from './services/lightshow.js';

export { isLightshowCancel };

async function fetchSongFile(songId, onProgress, isCancelled) {
    const res = await fetch(`/api/music/stream/${songId}`);
    if (!res.ok || !res.body) throw new Error(`Failed to download song (${res.status})`);

    const total = parseInt(res.headers.get('content-length') || '0', 10);
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
        if (isCancelled && isCancelled()) {
            reader.cancel().catch(() => {});
            throw cancelError();
        }
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (onProgress && total > 0) onProgress(received / total);
    }
    const buf = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) { buf.set(c, offset); offset += c.length; }
    return buf.buffer;
}

async function decodeAudio(arrayBuffer) {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    try {
        return await ctx.decodeAudioData(arrayBuffer);
    } finally {
        try { await ctx.close(); } catch (e) { /* ignore */ }
    }
}

function mixToMono(audioBuffer) {
    const channels = audioBuffer.numberOfChannels;
    const len = audioBuffer.length;
    const mono = new Float32Array(len);
    for (let c = 0; c < channels; c++) {
        const data = audioBuffer.getChannelData(c);
        for (let i = 0; i < len; i++) mono[i] += data[i];
    }
    const inv = 1 / channels;
    for (let i = 0; i < len; i++) mono[i] *= inv;
    return mono;
}

/**
 * Generate and persist a light show for a song.
 * @param {number} songId
 * @param {object} settings { bias?: 'chill' | 'balanced' | 'hype' }
 * @param {(p: { phase: string, fraction: number }) => void} [onProgress]
 *        fraction is global 0..1 across: download → decode → analyze → save
 * @param {() => boolean} [isCancelled]
 * @returns {Promise<object>} The generated score
 */
export async function generateAndSaveLightshow(songId, settings = {}, onProgress = null, isCancelled = null) {
    const report = (phase, fraction) => { if (onProgress) onProgress({ phase, fraction }); };

    report('download', 0);
    const pcm = await fetchSongFile(songId, f => report('download', f * 0.3), isCancelled);
    if (isCancelled && isCancelled()) throw cancelError();

    report('decode', 0.32);
    const audioBuffer = await decodeAudio(pcm);
    if (isCancelled && isCancelled()) throw cancelError();

    const mono = mixToMono(audioBuffer);
    const show = await analyzePcm(mono, audioBuffer.sampleRate, settings,
        f => report('analyze', 0.35 + f * 0.6), isCancelled);
    if (isCancelled && isCancelled()) throw cancelError();

    report('save', 0.97);
    const res = await useLightshowService().save(songId, show);
    if (res.error) throw new Error((res.error && res.error.error) || 'Failed to save light show');

    report('done', 1);
    Logger.log(`LightShow: generated show for song ${songId} (${Math.round(show.bpm)} BPM, ${show.sections.length} sections).`);
    return show;
}
