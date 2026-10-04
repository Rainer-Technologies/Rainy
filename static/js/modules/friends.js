/**
 * Friends Module — the social layer.
 *
 * Renders the Friends view (tabs: Friends / Requests / Playlist Invites),
 * the playlist sharing modal (invite friends, revoke access), and keeps the
 * sidebar badge in sync (incoming friend requests + pending playlist invites).
 */
import { Logger } from '../helper/logger.js';
import { Utils } from './utils.js';
import { t } from '../i18n/index.js';
import { useFriendsService } from '../services/friends.js';
import { usePlaylistService } from '../services/playlist.js';

const TABS = ['friends', 'requests', 'invites'];

export class FriendsModule {
    constructor(app) {
        this.app = app;
        this._badgeTimer = null;
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
            tab.addEventListener('click', () => {
                document.querySelectorAll('.friends-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                this.showTab(tab.dataset.tab);
            });
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
            t.classList.toggle('active', t.dataset.tab === tab);
        });
        this.showTab(tab);
    }

    showTab(tab) {
        ['friends', 'requests', 'invites'].forEach(id => {
            const el = document.getElementById(`friends-${id}-panel`);
            if (el) el.classList.toggle('hidden', id !== tab);
        });
        if (tab === 'friends') this.renderFriends();
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
    }

    async refreshBadges() {
        try {
            const [requests, invites] = await Promise.all([
                useFriendsService().requests(),
                useFriendsService().playlistInvites(),
            ]);
            const count = (requests.error ? 0 : (requests.value.incoming || []).length)
                + (invites.error ? 0 : (invites.value.invites || []).length);
            const badge = document.getElementById('friends-badge');
            if (!badge) return;
            badge.textContent = String(count);
            badge.classList.toggle('hidden', count === 0);
            // Friends lives inside the foldable More section: flag the header too.
            document.getElementById('nav-more-toggle')?.classList.toggle('has-badge', count > 0);
        } catch (e) {
            // Silent: badge is cosmetic.
        }
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
        if (friends.length === 0) {
            container.innerHTML = `
                <div class="friends-empty">
                    ${t('No friends yet. Add someone by email or username — once they accept, you can invite them to edit your playlists together.')}
                </div>`;
            return;
        }
        container.innerHTML = `
            <div class="friends-subheader">
                <span>${t('Your friends')}</span>
                <span class="friends-count">${friends.length}</span>
            </div>
            ${friends.map(f => `
            <div class="friend-row" data-id="${f.id}">
                <div class="friend-avatar">${Utils.escapeHtml((f.username || '?')[0].toUpperCase())}</div>
                <div class="friend-info">
                    <div class="friend-name">${Utils.escapeHtml(f.username)}</div>
                    <div class="friend-email">${Utils.escapeHtml(f.email)}</div>
                </div>
                <button type="button" class="btn btn-sm btn-danger" data-action="unfriend" data-id="${f.id}">
                    ${t('Unfriend')}
                </button>
            </div>`).join('')}`;

        container.querySelectorAll('[data-action="unfriend"]').forEach(btn => {
            btn.addEventListener('click', () => this.unfriend(parseInt(btn.dataset.id)));
        });
    }

    renderRequests() {
        const container = document.getElementById('friends-requests-list');
        if (!container) return;
        const incoming = this.requests?.incoming || [];
        const outgoing = this.requests?.outgoing || [];

        const incomingHtml = incoming.length === 0
            ? `<div class="friends-empty">${t('No incoming requests.')}</div>`
            : incoming.map(r => `
                <div class="friend-row" data-id="${r.id}">
                    <div class="friend-avatar">${Utils.escapeHtml((r.username || '?')[0].toUpperCase())}</div>
                    <div class="friend-info">
                        <div class="friend-name">${Utils.escapeHtml(r.username)}</div>
                        <div class="friend-email">${Utils.escapeHtml(r.email)}</div>
                    </div>
                    <div class="friend-actions">
                        <button type="button" class="btn btn-sm btn-primary" data-action="accept-req" data-id="${r.id}">${t('Accept')}</button>
                        <button type="button" class="btn btn-sm btn-danger" data-action="decline-req" data-id="${r.id}">${t('Decline')}</button>
                    </div>
                </div>`).join('');

        const outgoingHtml = outgoing.length === 0
            ? `<div class="friends-empty">${t('No pending requests you sent.')}</div>`
            : outgoing.map(r => `
                <div class="friend-row" data-id="${r.id}">
                    <div class="friend-avatar">${Utils.escapeHtml((r.username || '?')[0].toUpperCase())}</div>
                    <div class="friend-info">
                        <div class="friend-name">${Utils.escapeHtml(r.username)}</div>
                        <div class="friend-email">${Utils.escapeHtml(r.email)}</div>
                    </div>
                    <div class="friend-actions">
                        <span class="friend-chip">${t('Pending')}</span>
                        <button type="button" class="btn btn-sm" data-action="withdraw-req" data-id="${r.id}">${t('Withdraw')}</button>
                    </div>
                </div>`).join('');

        container.innerHTML = `
            <div class="friends-subheader">
                <span>${t('Incoming')}</span>
                <span class="friends-count">${incoming.length}</span>
            </div>
            ${incomingHtml}
            <div class="friends-subheader">
                <span>${t('Sent')}</span>
                <span class="friends-count">${outgoing.length}</span>
            </div>
            ${outgoingHtml}`;

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
                    ${t('No playlist invitations. When a friend shares a playlist with you, it shows up here — accept it to add it to your library.')}
                </div>`;
            return;
        }
        container.innerHTML = `
            <div class="friends-subheader">
                <span>${t('Playlist invites')}</span>
                <span class="friends-count">${invites.length}</span>
            </div>
            ${invites.map(i => `
            <div class="friend-row" data-id="${i.id}">
                <div class="friend-avatar">${Utils.escapeHtml((i.playlist_name || '?')[0].toUpperCase())}</div>
                <div class="friend-info">
                    <div class="friend-name">${Utils.escapeHtml(i.playlist_name)}</div>
                    <div class="friend-email">${t('invited by {name}', { name: Utils.escapeHtml(i.invited_by_username) })}</div>
                </div>
                <div class="friend-actions">
                    <button type="button" class="btn btn-sm btn-primary" data-action="accept-invite" data-id="${i.id}">${t('Accept')}</button>
                    <button type="button" class="btn btn-sm" data-action="decline-invite" data-id="${i.id}">${t('Decline')}</button>
                </div>
            </div>`).join('')}`;

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
            friendsList.innerHTML = `<div class="friends-empty">${t("No friends left to invite — everyone's in!")}</div>`;
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
            currentList.innerHTML = `<div class="friends-empty">${t('No collaborators yet.')}</div>`;
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