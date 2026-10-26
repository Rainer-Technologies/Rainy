/**
 * Listen together — a host's playback, heard in sync by the friends who joined.
 *
 * A host invites friends from the chat. The session is bound to the device the
 * host plays on, and that device's Connect beat carries its playback to the
 * server. The server pushes every change of a session the account is part of
 * on the chat stream (`listen` events), and this module keeps the latest view
 * of each one, shows the banner, and, for a friend who joined, keeps the local
 * player on the host's song and place.
 *
 * Following is soft: a seek, a pause or a skip made by the friend stays theirs
 * until the host changes something (the snapshot's state_seq moves). The
 * banner's "Sync" brings them back. Leaving keeps whatever is playing.
 */
import { Utils } from './utils.js';
import { t } from '../i18n/index.js';
import { useListenService } from '../services/listen.js';

/** Seconds a friend may drift from the host before they are moved. */
const DRIFT_SECONDS = 2;

const esc = (value) => Utils.escapeHtml(value);

export class ListenModule {
    constructor(app) {
        this.app = app;
        /** @type {Map<number, import('../services/listen.js').ListenSessionModel>} */
        this.sessions = new Map();
        this.followedId = null;
        this.followedSeq = null;
        this._bindStatic();
    }

    /** Forget every session (logout / session expiry). */
    stop() {
        this.sessions.clear();
        this.followedId = null;
        this.followedSeq = null;
        this._paint();
    }

    // ── Snapshots from the stream ───────────────────────────────────

    /**
     * A session as the server sees it for this account (the stream's `listen`
     * event, or the answer to one of our own requests).
     * @param {import('../services/listen.js').ListenSessionModel} snapshot
     */
    onSnapshot(snapshot) {
        const previous = this.sessions.get(snapshot.id);
        if (snapshot.status === 'ended' && !this.sessions.has(snapshot.id) && snapshot.state === 'left') {
            // Ended before we heard of it: nothing to show.
            return;
        }
        this.sessions.set(snapshot.id, snapshot);
        this._announce(previous, snapshot);

        if (snapshot.role === 'guest' && snapshot.state === 'joined' && snapshot.status === 'live') {
            this._follow(snapshot);
        } else if (this.followedId === snapshot.id) {
            this._unfollow(snapshot);
        }

        window.chatModule?.onListenChanged(snapshot);
        this._paint();
        // Whether the song playing can be added to the library may have changed.
        window.player?.updateKeepButtons?.();
    }

    /** The session the account is listening to with someone, if any. */
    get following() {
        const session = this.sessions.get(this.followedId);
        return session && session.state === 'joined' && session.status === 'live' ? session : null;
    }

    /** The live session the account hosts, if any. */
    get hosting() {
        for (const session of this.sessions.values()) {
            if (session.role === 'host' && session.status === 'live') return session;
        }
        return null;
    }

    /**
     * Whether the listener may not start playback: they hear the host, and the
     * host has paused. The player then stays paused until the host resumes.
     */
    get blocksPlayback() {
        const session = this.following;
        return !!session && !session.playing;
    }

    /** The listener tried to start playback while the host is paused. */
    onPlayBlocked() {
        Utils.showToast(t('The host has paused'), 'info', 3000);
    }

    /**
     * Whether the song with this id is the one the listener hears with the host
     * and is not in their library yet: the player then offers to add it. Only
     * while listening, since the server lets a song be kept only while playable.
     * @param {number} songId
     */
    keepable(songId) {
        const song = this.following?.song;
        return !!song && song.id === songId && song.in_library === false;
    }

    /** The listener added the song they hear to their library. */
    markKept(songId) {
        const session = this.following;
        if (!session?.song || session.song.id !== songId) return;
        this.sessions.set(session.id, { ...session, song: { ...session.song, in_library: true } });
        this._paint();
        window.player?.updateKeepButtons?.();
    }

    _announce(previous, snapshot) {
        if (snapshot.role === 'host' && previous) {
            const before = new Map((previous.members || []).map(m => [m.id, m.state]));
            for (const member of snapshot.members || []) {
                if (member.state === 'joined' && before.get(member.id) !== 'joined') {
                    Utils.showToast(t('{name} is listening with you', { name: member.username }), 'info', 4000);
                }
            }
            for (const [id, state] of before) {
                if (state === 'joined' && !(snapshot.members || []).some(m => m.id === id && m.state === 'joined')) {
                    const name = previous.members.find(m => m.id === id)?.username || '';
                    Utils.showToast(t('{name} stopped listening', { name }), 'info', 4000);
                }
            }
        }
        if (snapshot.role === 'guest' && previous?.state === 'joined'
            && snapshot.status === 'ended') {
            Utils.showToast(t('{name} ended the listening session', { name: snapshot.host.username }), 'info', 4000);
        }
    }

    // ── Following ───────────────────────────────────────────────────

    _follow(snapshot) {
        if (this.followedId === snapshot.id && this.followedSeq === snapshot.state_seq) {
            this._correct(snapshot);
            return;
        }
        this.followedId = snapshot.id;
        this.followedSeq = snapshot.state_seq;
        this._apply(snapshot);
    }

    _unfollow(snapshot) {
        if (this.followedId !== snapshot.id) return;
        this.followedId = null;
        this.followedSeq = null;
    }

    /** Put the local player on the host's song, place and play state. */
    async _apply(snapshot) {
        const player = window.player;
        if (!player?.audio) return;
        const seq = snapshot.state_seq;
        const song = snapshot.song;
        if (!song) {
            this._playState(false);
            return;
        }
        if (player.currentSong?.id !== song.id) {
            await player._connectPlaySongById(song.id, snapshot.position);
            // A newer state took over while the song was being fetched.
            if (this.followedSeq !== seq) return;
        } else {
            this._seek(snapshot.position);
        }
        this._playState(snapshot.playing);
    }

    /** A plain tick from the host: only fix the place, never the play state. */
    _correct(snapshot) {
        const player = window.player;
        const audio = player?.audio;
        if (!audio || !snapshot.song || player.currentSong?.id !== snapshot.song.id) return;
        if (snapshot.playing && !audio.paused
            && Math.abs(audio.currentTime - snapshot.position) > DRIFT_SECONDS) {
            this._seek(snapshot.position);
        }
    }

    _seek(position) {
        const audio = window.player?.audio;
        if (!audio || !Number.isFinite(position)) return;
        try { audio.currentTime = Math.max(0, position); } catch (e) { /* not seekable yet */ }
    }

    _playState(playing) {
        const audio = window.player?.audio;
        if (!audio) return;
        if (playing && audio.paused) audio.play().catch(() => {});
        else if (!playing && !audio.paused) audio.pause();
    }

    /** Bring a friend who drifted off the host back in line. */
    sync() {
        const session = this.following;
        if (!session) return;
        this.followedSeq = null;
        this._follow(session);
    }

    // ── Actions ─────────────────────────────────────────────────────

    /** Host: invite a friend to listen with what this device plays. */
    async invite(friendId) {
        const deviceId = window.player?._connectDeviceId;
        if (!deviceId) return Utils.showToast(t('Start playing something first'), 'error');
        const res = await useListenService().invite(friendId, deviceId);
        if (res.error) return Utils.showToast(res.error.error || t('Could not send the invitation'), 'error');
        this.onSnapshot(res.value.session);
        Utils.showToast(t('Invitation sent'));
    }

    /** Friend: take up an invitation. */
    async join(sessionId) {
        const res = await useListenService().join(sessionId);
        if (res.error) return Utils.showToast(res.error.error || t('Could not join'), 'error');
        this.onSnapshot(res.value.session);
        Utils.showToast(t('Listening with {name}', { name: res.value.session.host.username }));
    }

    /** Friend: leave, or decline. The invitation closes. */
    async leave(sessionId) {
        const res = await useListenService().leave(sessionId);
        if (res.error) return Utils.showToast(res.error.error || t('Could not leave'), 'error');
        await this._refresh(sessionId);
    }

    /** Host: end the session for everyone. */
    async end(sessionId) {
        const res = await useListenService().end(sessionId);
        if (res.error) return Utils.showToast(res.error.error || t('Could not end the session'), 'error');
        await this._refresh(sessionId);
    }

    async _refresh(sessionId) {
        const res = await useListenService().get(sessionId);
        if (!res.error) this.onSnapshot(res.value.session);
    }

    // ── Banner ──────────────────────────────────────────────────────

    _bindStatic() {
        const banner = document.getElementById('listen-banner');
        banner?.addEventListener('click', (e) => {
            const button = e.target.closest('[data-action]');
            if (!button) return;
            const session = button.dataset.session ? this.sessions.get(parseInt(button.dataset.session)) : null;
            if (button.dataset.action === 'sync') this.sync();
            else if (button.dataset.action === 'leave' && session) this.leave(session.id);
            else if (button.dataset.action === 'end' && session) this.end(session.id);
        });
    }

    _paint() {
        const banner = document.getElementById('listen-banner');
        if (!banner) return;
        const following = this.following;
        const hosting = this.hosting;
        const session = following || hosting;
        banner.classList.toggle('hidden', !session);
        if (!session) return;

        if (hosting && !following) {
            const heard = (hosting.members || []).filter(m => m.state === 'joined').map(m => m.username);
            const who = heard.length ? heard.join(', ') : t('nobody yet');
            banner.innerHTML = `
                <div class="listen-banner-info">
                    <span class="listen-banner-title">${esc(t('Listening together'))}</span>
                    <span class="listen-banner-sub">${esc(t('With {name}', { name: who }))}</span>
                </div>
                <div class="listen-banner-actions">
                    <button type="button" class="btn btn-sm" data-action="end" data-session="${session.id}">${esc(t('End'))}</button>
                </div>`;
            return;
        }

        const song = following.song;
        const place = song ? `${song.title} – ${song.artist}` : t('Waiting for the host to play');
        banner.innerHTML = `
            <div class="listen-banner-info">
                <span class="listen-banner-title">${esc(t('Listening with {name}', { name: following.host.username }))}</span>
                <span class="listen-banner-sub">${esc(place)}</span>
            </div>
            <div class="listen-banner-actions">
                <button type="button" class="btn btn-sm" data-action="sync" data-session="${following.id}">${esc(t('Sync'))}</button>
                <button type="button" class="btn btn-sm" data-action="leave" data-session="${following.id}">${esc(t('Leave'))}</button>
            </div>`;
    }
}

let __singleton = null;

/**
 * @returns {ListenModule}
 */
export function useListenModule(app) {
    if (!__singleton && app) __singleton = new ListenModule(app);
    return __singleton;
}
