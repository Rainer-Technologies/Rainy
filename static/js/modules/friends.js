/**
 * Friends Module — the social layer.
 *
 * Renders the Friends view (tabs: Friends / Messages / Requests / Invites),
 * the playlist sharing modal (invite friends, revoke access), and keeps the
 * sidebar badge in sync (incoming friend requests + pending playlist invites).
 */
import { Logger } from '../helper/logger.js';
import { Utils } from './utils.js';
import { t } from '../i18n/index.js';
import { useFriendsService } from '../services/friends.js';
import { usePlaylistService } from '../services/playlist.js';

const TABS = ['friends', 'messages', 'requests', 'invites'];

export class FriendsModule {
    constructor(app) {
        this.app = app;
        this._badgeTimer = null;
        this._pending = 0;
        this._chatUnread = 0;
        this._bindStatic();
        this.refreshBadges();
        // Keep the badge fresh while the app is open.
        this._badgeTimer = setInterval(() => {
            // Skip while signed out (login screen) — it would only 401.
            if (this.app?.user) this.refreshBadges();
        }, 60000);
    }

    /** Stop background polling (called on logout / session expiry). */
    stop() {
        clearInterval(this._badgeTimer);
        this._badgeTimer = null;
    }

    // ── Static bindings (page-level elements) ──────────────────────

    _bindStatic() {
        // View tabs
        document.querySelectorAll('.friends-tab').forEach(tab => {
            tab.addEventListener('click', () => this.activateTab(tab.dataset.tab));
        });

        // Add-friend form
        document.getElementById('friends-add-form')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.sendFriendRequest();
        });

        // Invite modal
        document.getElementById('close-playlist-share-modal')?.addEventListener('click', () => {
            document.getElementById('playlist-share-modal')?.classList.add('hidden');
        });
        document.getElementById('playlist-share-modal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                document.getElementById('playlist-share-modal')?.classList.add('hidden');
            }
        });
    }

    // ── View switching ─────────────────────────────────────────────

    openView(tab = 'friends') {
        // The nav item and /friends route go through app.openFriendsView();
        // this is the tab activation + data refresh half.
        this.activateTab(tab);
        this.refresh();
    }

    activateTab(tab) {
        if (!TABS.includes(tab)) tab = 'friends';
        document.querySelectorAll('.friends-tab').forEach(t => {
            const active = t.dataset.tab === tab;
            t.classList.toggle('active', active);
            t.setAttribute('aria-selected', String(active));
        });
        this.showTab(tab);
    }

    showTab(tab) {
        // Messages is a full-height view: give the conversation the page
        // head's room instead of squeezing it under the add-friend field.
        document.querySelector('.friends-header')?.classList.toggle('hidden', tab === 'messages');
        TABS.forEach(id => {
            const el = document.getElementById(`friends-${id}-panel`);
            if (el) el.classList.toggle('hidden', id !== tab);
        });
        if (tab === 'friends') this.renderFriends();
        if (tab === 'messages') window.chatModule?.onTabShown();
        if (tab === 'requests') this.renderRequests();
        if (tab === 'invites') this.renderInvites();
    }

    // ── Data ────────────────────────────────────────────────────────

    async refresh() {
        const [friends, requests, invites] = await Promise.all([
            useFriendsService().friends(),
            useFriendsService().requests(),
            useFriendsService().playlistInvites(),
        ]);
        this.friends = friends.error ? [] : (friends.value.friends || []);
        this.requests = requests.error ? { incoming: [], outgoing: [] } : requests.value;
        this.invites = invites.error ? [] : (invites.value.invites || []);
        this.renderAll();
        this.refreshBadges();
        window.chatModule?.loadSettings();
    }

    async refreshBadges() {
        try {
            const [requests, invites] = await Promise.all([
                useFriendsService().requests(),
                useFriendsService().playlistInvites(),
            ]);
            const reqCount = requests.error ? 0 : (requests.value.incoming || []).length;
            const invCount = invites.error ? 0 : (invites.value.invites || []).length;
            this._pending = reqCount + invCount;
            this._paintBadge();

            const reqBadge = document.getElementById('requests-tab-badge');
            if (reqBadge) {
                reqBadge.textContent = String(reqCount);
                reqBadge.classList.toggle('hidden', reqCount === 0);
            }
            const invBadge = document.getElementById('invites-tab-badge');
            if (invBadge) {
                invBadge.textContent = String(invCount);
                invBadge.classList.toggle('hidden', invCount === 0);
            }
        } catch (e) {
            // Silent: badge is cosmetic.
        }
    }

    /** Unread chat messages, counted in the sidebar badge with the rest. */
    setChatUnread(count) {
        this._chatUnread = count;
        this._paintBadge();
    }

    _paintBadge() {
        const count = this._pending + this._chatUnread;
        const badge = document.getElementById('friends-badge');
        if (!badge) return;
        badge.textContent = String(count);
        badge.classList.toggle('hidden', count === 0);
        // Friends lives inside the foldable More section: flag the header too.
        document.getElementById('nav-more-toggle')?.classList.toggle('has-badge', count > 0);
    }

    renderAll() {
        this.renderFriends();
        this.renderRequests();
        this.renderInvites();
    }

    // ── Rendering ───────────────────────────────────────────────────

    renderFriends() {
        const container = document.getElementById('friends-list');
        if (!container) return;
        const friends = this.friends || [];
        const chat = window.chatModule;
        const presenceOf = (id) => chat?.conversations?.get(id)?.presence;

        const countBadge = document.getElementById('friends-count-badge');
        if (countBadge) countBadge.textContent = String(friends.length);
        const tabCount = document.getElementById('friends-tab-count');
        if (tabCount) tabCount.textContent = String(friends.length);

        const onlineCount = friends.filter(f => presenceOf(f.id)?.online).length;
        const meta = document.getElementById('friends-heading-meta');
        if (meta) {
            meta.replaceChildren();
            if (friends.length === 0) {
                meta.textContent = t('Add friends by email or username.');
            } else {
                const total = document.createElement('span');
                total.textContent = t('{count} friends', { count: friends.length });
                meta.append(total);
                if (onlineCount > 0) {
                    const sep = document.createElement('span');
                    sep.className = 'friends-meta-sep';
                    sep.textContent = '·';
                    const online = document.createElement('span');
                    online.className = 'friends-meta-online';
                    const dot = document.createElement('span');
                    dot.className = 'friends-online-dot';
                    online.append(dot, t('{count} online', { count: onlineCount }));
                    meta.append(sep, online);
                }
            }
        }

        // "Listening Now" — only friends whose presence carries a song.
        const listeningSection = document.getElementById('friends-listening-section');
        const listeningGrid = document.getElementById('friends-listening-grid');
        if (listeningSection && listeningGrid) {
            const listeningFriends = friends.filter(f => {
                const presence = presenceOf(f.id);
                return presence?.online && presence?.listening;
            });

            if (listeningFriends.length > 0) {
                listeningGrid.innerHTML = listeningFriends.map(f => {
                    const song = presenceOf(f.id)?.listening;
                    if (!song) return '';
                    // A friend's current song only streams for you when it is in
                    // your library; otherwise the play button would just 404.
                    const songId = song.song_id || song.id;
                    const playable = !!window.app?.librarySongs?.some(s => String(s.id) === String(songId));
                    const cover = song.cover_path
                        ? `<img src="/api/music/cover/${encodeURIComponent(song.cover_path)}" alt="" loading="lazy" onerror="window.Utils.handleCoverError(this)">`
                        : `<svg data-icon="music-note" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;
                    const artist = song.artist
                        ? `<span class="listening-sep">·</span><span class="listening-artist" title="${Utils.escapeHtml(song.artist)}">${Utils.escapeHtml(song.artist)}</span>`
                        : '';
                    return `
                    <div class="listening-card" data-friend-id="${f.id}" data-song-id="${song.song_id || song.id || ''}">
                        <div class="listening-cover">${cover}</div>
                        <div class="listening-info">
                            <div class="listening-user">
                                <span class="listening-eq" aria-hidden="true"><i></i><i></i><i></i></span>
                                <span class="listening-user-name">${Utils.escapeHtml(f.username)}</span>
                            </div>
                            <div class="listening-line">
                                <span class="listening-title" title="${Utils.escapeHtml(song.title || '')}">${Utils.escapeHtml(song.title || t('A song'))}</span>
                                ${artist}
                            </div>
                        </div>
                        ${playable ? `<button type="button" class="listening-play" data-action="play-listening"
                            title="${t('Play')}" aria-label="${t('Play')} ${Utils.escapeHtml(song.title || '')}">
                            <svg data-icon="play" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
                        </button>` : ''}
                    </div>`;
                }).join('');

                listeningGrid.querySelectorAll('[data-action="play-listening"]').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const card = btn.closest('.listening-card');
                        const friendId = parseInt(card?.dataset.friendId);
                        const song = presenceOf(friendId)?.listening;
                        if (song) {
                            window.player?.playSong(0, [{
                                id: song.song_id || song.id,
                                title: song.title,
                                artist: song.artist,
                                album: song.album,
                                cover_path: song.cover_path
                            }], { type: 'library', id: null });
                        }
                    });
                });

                listeningSection.classList.remove('hidden');
            } else {
                listeningSection.classList.add('hidden');
                listeningGrid.innerHTML = '';
            }
        }

        if (friends.length === 0) {
            container.innerHTML = `
                <div class="friends-empty">
                    <span class="friends-empty-icon">
                        <svg data-icon="group" viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
                            <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
                        </svg>
                    </span>
                    <div class="friends-empty-title">${t('No friends yet')}</div>
                    <div class="friends-empty-subtitle">${t('Once they accept, you can invite them to edit your playlists together.')}</div>
                </div>`;
            return;
        }

        container.innerHTML = friends.map(f => {
            const presence = presenceOf(f.id);
            const isListening = !!presence?.listening;
            const isOnline = !!presence?.online;
            const presenceText = chat?.presenceLine(f.id) || t('Offline');
            const statusHtml = isListening
                ? `<span class="friend-status-listening"><svg data-icon="equalizer" viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M10 20h4V4h-4v16zm-6 0h4v-8H4v8zM16 9v11h4V9h-4z"/></svg> ${Utils.escapeHtml(presenceText)}</span>`
                : isOnline
                    ? `<span class="friend-status-online">${Utils.escapeHtml(presenceText)}</span>`
                    : `<span class="friend-status-offline">${Utils.escapeHtml(presenceText)}</span>`;
            return `
            <div class="friend-row" data-id="${f.id}">
                <div class="friend-avatar" aria-hidden="true">${Utils.escapeHtml((f.username || '?')[0].toUpperCase())}${chat?.presenceDot(f.id) || ''}</div>
                <div class="friend-info">
                    <div class="friend-name">${Utils.escapeHtml(f.username)}</div>
                    <div class="friend-email">${statusHtml}</div>
                </div>
                <div class="friend-actions">
                    <button type="button" class="friends-btn" data-action="message" data-id="${f.id}" aria-label="${t('Message')}">
                        <svg data-icon="description" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/></svg>
                        <span class="friends-btn-label">${t('Message')}</span>
                    </button>
                    <button type="button" class="friends-icon-btn friends-icon-btn-danger" data-action="unfriend" data-id="${f.id}"
                        title="${t('Unfriend')}" aria-label="${t('Unfriend')}">
                        <svg data-icon="close" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/></svg>
                    </button>
                </div>
            </div>`;
        }).join('');

        container.querySelectorAll('[data-action="message"]').forEach(btn => {
            btn.addEventListener('click', () => window.chatModule?.openChat(parseInt(btn.dataset.id)));
        });
        container.querySelectorAll('[data-action="unfriend"]').forEach(btn => {
            btn.addEventListener('click', () => this.unfriend(parseInt(btn.dataset.id)));
        });
    }

    renderRequests() {
        const container = document.getElementById('friends-requests-list');
        if (!container) return;
        const incoming = this.requests?.incoming || [];
        const outgoing = this.requests?.outgoing || [];

        const incomingRows = incoming.map(r => `
                <div class="friend-row" data-id="${r.id}">
                    <div class="friend-avatar" aria-hidden="true">${Utils.escapeHtml((r.username || '?')[0].toUpperCase())}</div>
                    <div class="friend-info">
                        <div class="friend-name">${Utils.escapeHtml(r.username)}</div>
                        <div class="friend-email">${Utils.escapeHtml(r.email)}</div>
                    </div>
                    <div class="friend-actions">
                        <button type="button" class="friends-btn friends-btn-primary" data-action="accept-req" data-id="${r.id}">${t('Accept')}</button>
                        <button type="button" class="friends-btn" data-action="decline-req" data-id="${r.id}">${t('Decline')}</button>
                    </div>
                </div>`).join('');

        const outgoingRows = outgoing.map(r => `
                <div class="friend-row" data-id="${r.id}">
                    <div class="friend-avatar" aria-hidden="true">${Utils.escapeHtml((r.username || '?')[0].toUpperCase())}</div>
                    <div class="friend-info">
                        <div class="friend-name">${Utils.escapeHtml(r.username)}</div>
                        <div class="friend-email">${Utils.escapeHtml(r.email)}</div>
                    </div>
                    <div class="friend-actions">
                        <span class="friend-chip friend-chip-warn">${t('Pending')}</span>
                        <button type="button" class="friends-btn" data-action="withdraw-req" data-id="${r.id}">${t('Withdraw')}</button>
                    </div>
                </div>`).join('');

        const group = (title, count, rowsHtml, emptyCopy) => `
            <section class="friends-group">
                <div class="friends-group-head">
                    <h2 class="friends-group-title">${title}</h2>
                    <span class="friends-count">${count}</span>
                </div>
                ${count > 0
                    ? `<div class="friends-list">${rowsHtml}</div>`
                    : `<div class="friends-empty-line">${emptyCopy}</div>`}
            </section>`;

        container.innerHTML =
            group(t('Incoming'), incoming.length, incomingRows, t('No incoming requests.')) +
            group(t('Sent'), outgoing.length, outgoingRows, t('No pending requests you sent.'));

        container.querySelectorAll('[data-action="accept-req"]').forEach(btn => {
            btn.addEventListener('click', () => this.acceptRequest(parseInt(btn.dataset.id)));
        });
        container.querySelectorAll('[data-action="decline-req"]').forEach(btn => {
            btn.addEventListener('click', () => this.declineRequest(parseInt(btn.dataset.id)));
        });
        container.querySelectorAll('[data-action="withdraw-req"]').forEach(btn => {
            btn.addEventListener('click', () => this.declineRequest(parseInt(btn.dataset.id)));
        });
    }

    renderInvites() {
        const container = document.getElementById('friends-invites-list');
        if (!container) return;
        const invites = this.invites || [];
        if (invites.length === 0) {
            container.innerHTML = `
                <div class="friends-empty">
                    <span class="friends-empty-icon">
                        <svg data-icon="library-music" viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
                            <path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 5h-3v5.5c0 1.38-1.12 2.5-2.5 2.5S10 13.88 10 12.5s1.12-2.5 2.5-2.5c.57 0 1.08.19 1.5.51V5h4v2zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6z"/>
                        </svg>
                    </span>
                    <div class="friends-empty-title">${t('No playlist invitations')}</div>
                    <div class="friends-empty-subtitle">${t('When a friend shares a playlist with you, it shows up here — accept it to add it to your library.')}</div>
                </div>`;
            return;
        }
        container.innerHTML = `
            <section class="friends-group">
                <div class="friends-group-head">
                    <h2 class="friends-group-title">${t('Playlist invites')}</h2>
                    <span class="friends-count">${invites.length}</span>
                </div>
                <div class="friends-list">
                    ${invites.map(i => `
                    <div class="friend-row" data-id="${i.id}">
                        <div class="friend-avatar friend-avatar-square" aria-hidden="true">${Utils.escapeHtml((i.playlist_name || '?')[0].toUpperCase())}</div>
                        <div class="friend-info">
                            <div class="friend-name">${Utils.escapeHtml(i.playlist_name)}</div>
                            <div class="friend-email">${t('invited by {name}', { name: Utils.escapeHtml(i.invited_by_username) })}</div>
                        </div>
                        <div class="friend-actions">
                            <button type="button" class="friends-btn friends-btn-primary" data-action="accept-invite" data-id="${i.id}">${t('Accept')}</button>
                            <button type="button" class="friends-btn" data-action="decline-invite" data-id="${i.id}">${t('Decline')}</button>
                        </div>
                    </div>`).join('')}
                </div>
            </section>`;

        container.querySelectorAll('[data-action="accept-invite"]').forEach(btn => {
            btn.addEventListener('click', () => this.acceptPlaylistInvite(parseInt(btn.dataset.id)));
        });
        container.querySelectorAll('[data-action="decline-invite"]').forEach(btn => {
            btn.addEventListener('click', () => this.declinePlaylistInvite(parseInt(btn.dataset.id)));
        });
    }

    // ── Actions ─────────────────────────────────────────────────────

    async sendFriendRequest() {
        const input = document.getElementById('friends-add-input');
        const identifier = (input?.value || '').trim();
        if (!identifier) return;
        const res = await useFriendsService().sendRequest(identifier);
        if (res.error) {
            window.showToast?.(res.error.error || 'Could not send request', 'error');
            return;
        }
        window.showToast?.(res.value.message || 'Request sent');
        input.value = '';
        this.refresh();
    }

    async unfriend(friendId) {
        const res = await useFriendsService().removeFriend(friendId);
        if (res.error) return window.showToast?.(res.error.error, 'error');
        window.showToast?.(res.value.message || 'Friend removed');
        this.refresh();
    }

    async acceptRequest(requestId) {
        const res = await useFriendsService().acceptRequest(requestId);
        if (res.error) return window.showToast?.(res.error.error, 'error');
        window.showToast?.(res.value.message || 'Friend added');
        this.refresh();
    }

    async declineRequest(requestId) {
        const res = await useFriendsService().declineRequest(requestId);
        if (res.error) return window.showToast?.(res.error.error, 'error');
        window.showToast?.('Request removed');
        this.refresh();
    }

    async acceptPlaylistInvite(shareId) {
        const res = await useFriendsService().acceptPlaylistInvite(shareId);
        if (res.error) return window.showToast?.(res.error.error, 'error');
        window.showToast?.(res.value.message || 'Playlist added');
        this.app?.loadPlaylists?.();
        this.refresh();
    }

    async declinePlaylistInvite(shareId) {
        const res = await useFriendsService().declinePlaylistInvite(shareId);
        if (res.error) return window.showToast?.(res.error.error, 'error');
        window.showToast?.('Invitation declined');
        this.refresh();
    }

    // ── Invite modal ────────────────────────────────────────────────

    async openInviteModal(playlistId, playlistName) {
        const modal = document.getElementById('playlist-share-modal');
        if (!modal) return;
        document.getElementById('playlist-share-modal-title').textContent =
            t('Invite friends — {name}', { name: playlistName });

        const [sharesRes, friendsRes] = await Promise.all([
            usePlaylistService().shares(playlistId),
            useFriendsService().friends(),
        ]);
        const shares = sharesRes.error ? [] : (sharesRes.value.shares || []);
        const friends = friendsRes.error ? [] : (friendsRes.value.friends || []);

        const sharedIds = new Set(shares.map(s => s.user_id));
        const available = friends.filter(f => !sharedIds.has(f.id));

        const friendsList = document.getElementById('share-friends-list');
        if (available.length === 0) {
            friendsList.innerHTML = `<div class="friends-empty-line">${t("No friends left to invite — everyone's in!")}</div>`;
        } else {
            friendsList.innerHTML = available.map(f => `
                <div class="friend-row" data-id="${f.id}">
                    <div class="friend-avatar">${Utils.escapeHtml((f.username || '?')[0].toUpperCase())}</div>
                    <div class="friend-info">
                        <div class="friend-name">${Utils.escapeHtml(f.username)}</div>
                        <div class="friend-email">${Utils.escapeHtml(f.email)}</div>
                    </div>
                    <button type="button" class="btn btn-sm btn-primary" data-action="invite" data-id="${f.id}">
                        ${t('Invite')}
                    </button>
                </div>`).join('');
            friendsList.querySelectorAll('[data-action="invite"]').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const role = document.getElementById('share-role-select')?.value || 'admin';
                    const res = await usePlaylistService().inviteFriend(
                        playlistId, parseInt(btn.dataset.id), role);
                    if (res.error) return window.showToast?.(res.error.error, 'error');
                    window.showToast?.(res.value.message || 'Invited');
                    this.openInviteModal(playlistId, playlistName);
                });
            });
        }

        const currentList = document.getElementById('share-current-list');
        if (shares.length === 0) {
            currentList.innerHTML = `<div class="friends-empty-line">${t('No collaborators yet.')}</div>`;
        } else {
            currentList.innerHTML = shares.map(s => `
                <div class="friend-row" data-id="${s.id}">
                    <div class="friend-avatar">${Utils.escapeHtml((s.username || '?')[0].toUpperCase())}</div>
                    <div class="friend-info">
                        <div class="friend-name">${Utils.escapeHtml(s.username)}</div>
                        <div class="friend-email">
                            ${s.status === 'pending' ? `<span class="friend-chip friend-chip-warn">${t('invited')}</span>` : ''}
                        </div>
                    </div>
                    <div class="friend-actions">
                        <select class="share-role-change" data-share-id="${s.id}" title="${t('Change role')}">
                            <option value="admin" ${s.role === 'admin' ? 'selected' : ''}>${t('Admin')}</option>
                            <option value="viewer" ${s.role === 'viewer' ? 'selected' : ''}>${t('Viewer')}</option>
                        </select>
                        <button type="button" class="btn btn-sm btn-danger" data-action="revoke" data-id="${s.id}">
                            ${t('Revoke')}
                        </button>
                    </div>
                </div>`).join('');
            currentList.querySelectorAll('[data-action="revoke"]').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const res = await usePlaylistService().revokeShare(playlistId, parseInt(btn.dataset.id));
                    if (res.error) return window.showToast?.(res.error.error, 'error');
                    window.showToast?.(res.value.message || 'Access revoked');
                    this.openInviteModal(playlistId, playlistName);
                });
            });
            currentList.querySelectorAll('.share-role-change').forEach(sel => {
                sel.addEventListener('change', async () => {
                    const res = await usePlaylistService().changeRole(
                        playlistId, parseInt(sel.dataset.shareId), sel.value);
                    if (res.error) {
                        window.showToast?.(res.error.error || 'Could not change role', 'error');
                        this.openInviteModal(playlistId, playlistName);
                        return;
                    }
                    window.showToast?.(res.value.message || 'Role updated');
                    this.openInviteModal(playlistId, playlistName);
                });
            });
        }

        modal.classList.remove('hidden');
    }

    // ── Leave playlist (collaborators) ──────────────────────────────

    async leavePlaylist(playlistId, playlistName) {
        if (!window.confirm?.(t('Leave "{name}"? It will be removed from your library.', { name: playlistName }))) return;
        const res = await usePlaylistService().leavePlaylist(playlistId);
        if (res.error) return window.showToast?.(res.error.error, 'error');
        window.showToast?.(res.value.message || 'Playlist removed');
        this.app?.loadPlaylists?.();
        this.app?.switchToLibraryView?.();
        this.refresh();
    }
}

let __singleton = null;

/**
 * @returns {FriendsModule}
 */
export function useFriendsModule(app) {
    if (!__singleton && app) __singleton = new FriendsModule(app);
    return __singleton;
}