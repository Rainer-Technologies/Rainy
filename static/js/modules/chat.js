/**
 * Chat Module — messages between friends, and who is around.
 *
 * Lives inside the Friends view (the Messages tab): a list of conversations
 * with presence ("online", "listening to …") and, opened from it, one
 * conversation with songs and playlist invitations as cards. One server
 * stream (docs/CHAT.md) keeps messages, unread counts and presence live; the
 * module is started with the session and stopped with it.
 */
import { Utils } from './utils.js';
import { t } from '../i18n/index.js';
import { useChatService } from '../services/chat.js';
import { useFriendsService } from '../services/friends.js';
import { useMusicService } from '../services/music.js';

const TYPING_PING_MS = 3000;
const RECONNECT_MS = 60000;
const PICKER_LIMIT = 30;

const esc = (value) => Utils.escapeHtml(value);

export class ChatModule {
    constructor(app) {
        this.app = app;
        /** @type {Map<number, import('../services/chat.js').ConversationModel>} */
        this.conversations = new Map();
        /** @type {import('../services/chat.js').ChatMessageModel[]} */
        this.messages = [];
        this.openFriendId = null;
        this.readByFriend = 0;
        this._source = null;
        this._retryTimer = null;
        this._opened = false;
        this._lastTypingPing = 0;
        this._active = false;
        this._bindStatic();
    }

    // ── Session ────────────────────────────────────────────────────

    /** Load the conversations and open the live stream. */
    async start() {
        if (this._active) return;
        this._active = true;
        this._opened = false;
        await this.refresh();
        this._connect();
    }

    /** Close the stream and forget everything (logout / session expiry). */
    stop() {
        this._active = false;
        clearTimeout(this._retryTimer);
        this._retryTimer = null;
        this._source?.close();
        this._source = null;
        this.conversations.clear();
        this.messages = [];
        this.openFriendId = null;
        this._paintBadge();
    }

    get unreadTotal() {
        let total = 0;
        for (const c of this.conversations.values()) total += c.unread || 0;
        return total;
    }

    _newestId() {
        let newest = 0;
        for (const c of this.conversations.values()) {
            newest = Math.max(newest, c.last_message?.id || 0);
        }
        return newest;
    }

    _connect() {
        if (!this._active || typeof EventSource === 'undefined') return;
        this._source?.close();
        const source = new EventSource(useChatService().streamUrl(this._newestId() || null));
        this._source = source;
        source.addEventListener('open', async () => {
            // A reconnect may have skipped events: read the state again.
            if (this._opened) await this.refresh();
            this._opened = true;
        });
        source.addEventListener('message', (e) => this._onMessage(JSON.parse(e.data)));
        source.addEventListener('presence', (e) => this._onPresence(JSON.parse(e.data)));
        source.addEventListener('read', (e) => this._onRead(JSON.parse(e.data)));
        source.onerror = () => {
            // The browser retries a dropped connection by itself; a refused
            // one (too many streams, signed out) it gives up on.
            if (source.readyState !== EventSource.CLOSED) return;
            this._source = null;
            clearTimeout(this._retryTimer);
            this._retryTimer = setTimeout(() => this._connect(), RECONNECT_MS);
        };
    }

    // ── Data ────────────────────────────────────────────────────────

    async refresh() {
        const res = await useChatService().conversations();
        if (res.error) return;
        this.conversations = new Map(res.value.conversations.map(c => [c.friend.id, c]));
        this.renderConversations();
        this._paintBadge();
        if (this.openFriendId != null) this._loadThread(this.openFriendId, { keepScroll: true });
    }

    _friendName(id) {
        return this.conversations.get(id)?.friend.username || '?';
    }

    _onMessage(message) {
        const me = this.app.user?.id;
        const friendId = message.sender_id === me ? message.recipient_id : message.sender_id;
        let conversation = this.conversations.get(friendId);
        if (!conversation) {
            // A friend who was added since the list was loaded.
            this.refresh();
            return;
        }
        const known = conversation.last_message?.id >= message.id;
        conversation.last_message = known ? conversation.last_message : message;

        const incoming = message.sender_id !== me;
        const looking = this.openFriendId === friendId && this._threadVisible();
        if (this.openFriendId === friendId && !this.messages.some(m => m.id === message.id)) {
            this.messages.push(message);
            this._appendMessage(message);
        }
        if (incoming && !known) {
            if (looking) {
                useChatService().read(friendId);
            } else {
                conversation.unread = (conversation.unread || 0) + 1;
                Utils.showToast(`${conversation.friend.username}: ${this._preview(message)}`, 'info', 4000);
            }
        }
        this.renderConversations();
        this._paintBadge();
    }

    _onPresence({ users }) {
        for (const entry of users) {
            const conversation = this.conversations.get(entry.user_id);
            if (conversation) conversation.presence = entry;
        }
        this.renderConversations();
        window.friendsModule?.renderFriends();
        if (this.openFriendId != null) this._paintHead();
    }

    _onRead({ reader_id, author_id, last_read_id }) {
        const me = this.app.user?.id;
        if (author_id === me && reader_id === this.openFriendId) {
            this.readByFriend = Math.max(this.readByFriend, last_read_id);
            this._paintSeen();
        } else if (reader_id === me) {
            // Read on another device of this account.
            const conversation = this.conversations.get(author_id);
            if (conversation && conversation.last_message?.id <= last_read_id) {
                conversation.unread = 0;
                this.renderConversations();
                this._paintBadge();
            }
        }
    }

    _preview(message) {
        if (message.kind === 'song') return `♪ ${message.song?.title || t('A song')}`;
        if (message.kind === 'playlist_invite') {
            return t('Playlist invitation: {name}', { name: message.invite?.playlist_name || '' });
        }
        return message.body || '';
    }

    // ── Badge ───────────────────────────────────────────────────────

    _paintBadge() {
        const total = this.unreadTotal;
        const tab = document.getElementById('chat-tab-badge');
        if (tab) {
            tab.textContent = String(total);
            tab.classList.toggle('hidden', total === 0);
        }
        window.friendsModule?.setChatUnread(total);
    }

    // ── Presence text ───────────────────────────────────────────────

    /** The line under a friend's name: what they are doing right now. */
    presenceLine(friendId) {
        const presence = this.conversations.get(friendId)?.presence;
        if (!presence?.online) return t('Offline');
        const song = presence.listening;
        if (song) {
            return t('Listening to {title} – {artist}', { title: song.title || '', artist: song.artist || '' });
        }
        return t('Online');
    }

    presenceDot(friendId) {
        const online = !!this.conversations.get(friendId)?.presence?.online;
        const listening = !!this.conversations.get(friendId)?.presence?.listening;
        return `<span class="presence-dot${online ? ' online' : ''}${listening ? ' listening' : ''}"></span>`;
    }

    // ── Static bindings ─────────────────────────────────────────────

    _bindStatic() {
        document.getElementById('chat-back')?.addEventListener('click', () => this.closeThread());
        document.getElementById('chat-form')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this._sendText();
        });
        document.getElementById('chat-input')?.addEventListener('input', () => this._pingTyping());
        document.getElementById('chat-attach')?.addEventListener('click', () => this._toggleAttach());
        document.getElementById('chat-attach-song')?.addEventListener('click', () => this._showPicker('song'));
        document.getElementById('chat-attach-playlist')?.addEventListener('click', () => this._showPicker('playlist'));
        document.getElementById('chat-picker-search')?.addEventListener('input', () => this._renderPicker());
        document.getElementById('chat-messages')?.addEventListener('click', (e) => this._onCardAction(e));
        document.getElementById('chat-conversations')?.addEventListener('click', (e) => {
            const row = e.target.closest('[data-friend-id]');
            if (row) this.openThread(parseInt(row.dataset.friendId));
        });
        document.getElementById('chat-picker-list')?.addEventListener('click', (e) => this._onPick(e));
        for (const key of ['share_online', 'share_listening']) {
            document.getElementById(`chat-${key.replace('_', '-')}`)?.addEventListener('change', (e) => {
                this._saveSetting(key, e.target.checked);
            });
        }
    }

    _threadVisible() {
        const panel = document.getElementById('friends-messages-panel');
        return !document.hidden && !!panel && !panel.classList.contains('hidden')
            && !document.getElementById('friends-view')?.classList.contains('hidden');
    }

    // ── Conversation list ───────────────────────────────────────────

    renderConversations() {
        const container = document.getElementById('chat-conversations');
        if (!container) return;
        const list = [...this.conversations.values()].sort((a, b) =>
            (b.last_message?.id || 0) - (a.last_message?.id || 0)
            || a.friend.username.localeCompare(b.friend.username));
        if (list.length === 0) {
            container.innerHTML = `<div class="friends-empty">${t('Add a friend to start chatting.')}</div>`;
            return;
        }
        container.innerHTML = list.map(c => {
            const id = c.friend.id;
            const last = c.last_message
                ? `${c.last_message.sender_id === this.app.user?.id ? t('You') + ': ' : ''}${this._preview(c.last_message)}`
                : this.presenceLine(id);
            return `
            <div class="friend-row chat-conversation" data-friend-id="${id}">
                <div class="friend-avatar">${esc((c.friend.username || '?')[0].toUpperCase())}${this.presenceDot(id)}</div>
                <div class="friend-info">
                    <div class="friend-name">${esc(c.friend.username)}</div>
                    <div class="friend-email">${esc(last)}</div>
                </div>
                ${c.unread ? `<span class="nav-badge">${c.unread}</span>` : ''}
            </div>`;
        }).join('');
    }

    // ── Thread ──────────────────────────────────────────────────────

    /** Open the Friends view on the Messages tab and the conversation with a friend. */
    async openChat(friendId) {
        await this.app.openFriendsView?.();
        window.friendsModule?.activateTab('messages');
        await this.openThread(friendId);
    }

    async openThread(friendId) {
        this.openFriendId = friendId;
        document.getElementById('chat-conversations')?.classList.add('hidden');
        document.getElementById('chat-thread')?.classList.remove('hidden');
        document.getElementById('chat-attach-panel')?.classList.add('hidden');
        this._paintHead();
        await this._loadThread(friendId);
        document.getElementById('chat-input')?.focus();
    }

    closeThread() {
        this.openFriendId = null;
        this.messages = [];
        document.getElementById('chat-thread')?.classList.add('hidden');
        document.getElementById('chat-conversations')?.classList.remove('hidden');
        this.renderConversations();
    }

    /** The Messages tab was shown or hidden: a visible thread counts as read. */
    onTabShown() {
        this.renderConversations();
        if (this.openFriendId != null) this._markRead(this.openFriendId);
    }

    async _loadThread(friendId, { keepScroll = false } = {}) {
        const res = await useChatService().messages(friendId);
        if (res.error || this.openFriendId !== friendId) return;
        this.messages = res.value.messages;
        this.readByFriend = res.value.read_by_friend || 0;
        this._renderMessages({ keepScroll });
        this._markRead(friendId);
    }

    async _markRead(friendId) {
        const conversation = this.conversations.get(friendId);
        if (!conversation || !conversation.unread || !this._threadVisible()) return;
        conversation.unread = 0;
        this._paintBadge();
        this.renderConversations();
        await useChatService().read(friendId);
    }

    _paintHead() {
        const head = document.getElementById('chat-head-info');
        const conversation = this.conversations.get(this.openFriendId);
        if (!head || !conversation) return;
        const presence = conversation.presence;
        const status = presence?.typing ? t('is typing…') : this.presenceLine(conversation.friend.id);
        head.innerHTML = `
            <div class="friend-avatar">${esc((conversation.friend.username || '?')[0].toUpperCase())}${this.presenceDot(conversation.friend.id)}</div>
            <div class="friend-info">
                <div class="friend-name">${esc(conversation.friend.username)}</div>
                <div class="friend-email">${esc(status)}</div>
            </div>`;
    }

    _renderMessages({ keepScroll = false } = {}) {
        const box = document.getElementById('chat-messages');
        if (!box) return;
        const stick = !keepScroll || box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        if (this.messages.length === 0) {
            box.innerHTML = `<div class="friends-empty">${t('No messages yet. Say hi!')}</div>`;
            return;
        }
        box.innerHTML = this.messages.map(m => this._messageHtml(m)).join('') + '<div class="chat-seen hidden" id="chat-seen"></div>';
        this._paintSeen();
        if (stick) box.scrollTop = box.scrollHeight;
    }

    _appendMessage(message) {
        const box = document.getElementById('chat-messages');
        if (!box) return;
        box.querySelector('.friends-empty')?.remove();
        const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80
            || message.sender_id === this.app.user?.id;
        const seen = document.getElementById('chat-seen');
        const holder = document.createElement('div');
        holder.innerHTML = this._messageHtml(message);
        const node = holder.firstElementChild;
        if (seen) box.insertBefore(node, seen); else box.appendChild(node);
        this._paintSeen();
        if (stick) box.scrollTop = box.scrollHeight;
    }

    _replaceMessage(message) {
        const index = this.messages.findIndex(m => m.id === message.id);
        if (index >= 0) this.messages[index] = message;
        const node = document.querySelector(`#chat-messages [data-message-id="${message.id}"]`);
        if (!node) return;
        const holder = document.createElement('div');
        holder.innerHTML = this._messageHtml(message);
        node.replaceWith(holder.firstElementChild);
    }

    _paintSeen() {
        const seen = document.getElementById('chat-seen');
        if (!seen) return;
        const me = this.app.user?.id;
        const last = [...this.messages].reverse().find(m => m.sender_id === me);
        const isSeen = !!last && last.id <= this.readByFriend;
        seen.textContent = isSeen ? t('Seen') : '';
        seen.classList.toggle('hidden', !isSeen);
    }

    _messageHtml(message) {
        const mine = message.sender_id === this.app.user?.id;
        let body = '';
        if (message.kind === 'song') body = this._songCard(message);
        else if (message.kind === 'playlist_invite') body = this._inviteCard(message, mine);
        else body = `<div class="chat-text">${esc(message.body)}</div>`;
        const time = new Date(message.created_at * 1000)
            .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `
        <div class="chat-message ${mine ? 'mine' : 'theirs'}" data-message-id="${message.id}">
            ${body}
            <div class="chat-time">${esc(time)}</div>
        </div>`;
    }

    _songCard(message) {
        const song = message.song;
        if (!song) {
            return `<div class="chat-card chat-card-gone">${t('This song is no longer available.')}</div>`;
        }
        const cover = song.cover_path
            ? `<img src="/api/music/cover/${encodeURIComponent(song.cover_path)}" alt="" loading="lazy" onerror="window.Utils.handleCoverError(this)">`
            : '';
        const note = message.body ? `<div class="chat-text">${esc(message.body)}</div>` : '';
        return `${note}
        <div class="chat-card" data-song-id="${song.id}">
            <div class="chat-card-cover">${cover}</div>
            <div class="chat-card-info">
                <div class="chat-card-title">${esc(song.title)}</div>
                <div class="chat-card-sub">${esc(song.artist)}</div>
            </div>
            <div class="chat-card-actions">
                <button type="button" class="btn btn-sm btn-primary" data-action="play-song">${t('Play')}</button>
                ${song.in_library ? '' : `<button type="button" class="btn btn-sm" data-action="keep-song">${t('Add to library')}</button>`}
            </div>
        </div>`;
    }

    _inviteCard(message, mine) {
        const invite = message.invite || {};
        const name = invite.playlist_name;
        let actions;
        if (invite.state === 'pending' && !mine) {
            actions = `
                <button type="button" class="btn btn-sm btn-primary" data-action="accept-invite">${t('Accept')}</button>
                <button type="button" class="btn btn-sm" data-action="decline-invite">${t('Decline')}</button>`;
        } else if (invite.state === 'pending') {
            actions = `<span class="friend-chip friend-chip-warn">${t('Pending')}</span>`;
        } else if (invite.state === 'accepted') {
            actions = `<span class="friend-chip">${t('Joined')}</span>`;
        } else {
            actions = `<span class="friend-chip friend-chip-warn">${t('Closed')}</span>`;
        }
        const role = invite.role === 'viewer' ? t('Viewer') : t('Admin');
        return `
        <div class="chat-card" data-share-id="${invite.share_id ?? ''}">
            <div class="chat-card-cover chat-card-cover-playlist">${esc((name || '?')[0].toUpperCase())}</div>
            <div class="chat-card-info">
                <div class="chat-card-title">${esc(name || t('Playlist'))}</div>
                <div class="chat-card-sub">${mine ? t('Invitation sent') : t('Playlist invitation')} · ${esc(role)}</div>
            </div>
            <div class="chat-card-actions">${actions}</div>
        </div>`;
    }

    async _onCardAction(event) {
        const button = event.target.closest('[data-action]');
        const node = button?.closest('[data-message-id]');
        if (!button || !node) return;
        const message = this.messages.find(m => m.id === parseInt(node.dataset.messageId));
        if (!message) return;
        const action = button.dataset.action;

        if (action === 'play-song' && message.song) {
            window.player?.playSong(0, [message.song], { type: 'library', id: null });
        } else if (action === 'keep-song' && message.song) {
            const res = await useMusicService().saveToLibrary(message.song.id);
            if (res.error) return Utils.showToast(res.error.error || 'Could not add the song', 'error');
            Utils.showToast('Added to your library');
            // Every message with this song now has it in the library.
            for (const other of this.messages.filter(m => m.song?.id === message.song.id)) {
                this._replaceMessage({ ...other, song: { ...other.song, in_library: true } });
            }
            this.app.loadLibrary?.();
        } else if (action === 'accept-invite' || action === 'decline-invite') {
            const shareId = message.invite?.share_id;
            if (!shareId) return;
            const friends = useFriendsService();
            const accept = action === 'accept-invite';
            const res = accept ? await friends.acceptPlaylistInvite(shareId)
                               : await friends.declinePlaylistInvite(shareId);
            if (res.error) return Utils.showToast(res.error.error, 'error');
            Utils.showToast(accept ? 'Playlist added' : 'Invitation declined');
            if (accept) this.app.loadPlaylists?.();
            this._replaceMessage({ ...message, invite: { ...message.invite, state: accept ? 'accepted' : 'closed' } });
            window.friendsModule?.refreshBadges();
        }
    }

    // ── Sending ─────────────────────────────────────────────────────

    async _sendText() {
        const input = document.getElementById('chat-input');
        const body = (input?.value || '').trim();
        if (!body || this.openFriendId == null) return;
        input.value = '';
        const res = await this._send(this.openFriendId, { kind: 'text', body });
        if (res.error) input.value = body;
    }

    async _send(friendId, payload) {
        const res = await useChatService().send(friendId, payload);
        if (res.error) {
            Utils.showToast(res.error.error || 'Could not send the message', 'error');
            return res;
        }
        // The stream brings it back too; the id keeps it from showing twice.
        this._onMessage(res.value.message);
        return res;
    }

    /** Send a song from anywhere in the app (the song menu). */
    async sendSong(friendId, song) {
        const res = await this._send(friendId, { kind: 'song', song_id: parseInt(song.id) });
        if (!res.error) {
            Utils.showToast(t('Sent to {name}', { name: this._friendName(friendId) }));
        }
    }

    _pingTyping() {
        const now = Date.now();
        if (this.openFriendId == null || now - this._lastTypingPing < TYPING_PING_MS) return;
        this._lastTypingPing = now;
        useChatService().typing(this.openFriendId);
    }

    // ── Attachments ─────────────────────────────────────────────────

    _toggleAttach() {
        const panel = document.getElementById('chat-attach-panel');
        panel?.classList.toggle('hidden');
        document.getElementById('chat-picker')?.classList.add('hidden');
        document.getElementById('chat-attach-menu')?.classList.remove('hidden');
    }

    _showPicker(kind) {
        this._pickerKind = kind;
        document.getElementById('chat-attach-menu')?.classList.add('hidden');
        document.getElementById('chat-picker')?.classList.remove('hidden');
        const search = document.getElementById('chat-picker-search');
        if (search) {
            search.value = '';
            search.placeholder = kind === 'song' ? t('Search your library') : t('Search your playlists');
            search.focus();
        }
        this._renderPicker();
    }

    _renderPicker() {
        const list = document.getElementById('chat-picker-list');
        if (!list) return;
        const query = (document.getElementById('chat-picker-search')?.value || '').trim().toLowerCase();
        if (this._pickerKind === 'song') {
            const songs = (this.app.librarySongs || []).filter(s => !query
                || `${s.title} ${s.artist}`.toLowerCase().includes(query)).slice(0, PICKER_LIMIT);
            list.innerHTML = songs.length ? songs.map(s => `
                <div class="chat-pick" data-song-id="${s.id}">
                    <div class="friend-info">
                        <div class="friend-name">${esc(s.title)}</div>
                        <div class="friend-email">${esc(s.artist)}</div>
                    </div>
                    <button type="button" class="btn btn-sm btn-primary" data-action="pick">${t('Send')}</button>
                </div>`).join('') : `<div class="friends-empty">${t('Nothing found.')}</div>`;
        } else {
            const playlists = (this.app.playlists || []).filter(p => !p.shared
                && (p.name || '').toLowerCase() !== 'liked music'
                && (!query || (p.name || '').toLowerCase().includes(query)));
            list.innerHTML = playlists.length ? playlists.map(p => `
                <div class="chat-pick" data-playlist-id="${p.id}">
                    <div class="friend-info"><div class="friend-name">${esc(p.name)}</div></div>
                    <select class="share-role-change" data-role>
                        <option value="admin">${t('Admin')}</option>
                        <option value="viewer">${t('Viewer')}</option>
                    </select>
                    <button type="button" class="btn btn-sm btn-primary" data-action="pick">${t('Invite')}</button>
                </div>`).join('') : `<div class="friends-empty">${t('Nothing found.')}</div>`;
        }
    }

    async _onPick(event) {
        if (!event.target.closest('[data-action="pick"]') || this.openFriendId == null) return;
        const row = event.target.closest('.chat-pick');
        let payload;
        if (row.dataset.songId) {
            payload = { kind: 'song', song_id: parseInt(row.dataset.songId) };
        } else {
            payload = {
                kind: 'playlist_invite',
                playlist_id: parseInt(row.dataset.playlistId),
                role: row.querySelector('[data-role]')?.value || 'admin',
            };
        }
        const res = await this._send(this.openFriendId, payload);
        if (!res.error) document.getElementById('chat-attach-panel')?.classList.add('hidden');
    }

    // ── Privacy ─────────────────────────────────────────────────────

    async loadSettings() {
        const res = await useChatService().settings();
        if (res.error) return;
        const online = document.getElementById('chat-share-online');
        const listening = document.getElementById('chat-share-listening');
        if (online) online.checked = res.value.share_online;
        if (listening) {
            listening.checked = res.value.share_listening;
            listening.disabled = !res.value.share_online;
        }
    }

    async _saveSetting(key, value) {
        const res = await useChatService().updateSettings({ [key]: value });
        if (res.error) {
            Utils.showToast(res.error.error || 'Could not save', 'error');
        }
        this.loadSettings();
    }
}

let __singleton = null;

/**
 * @returns {ChatModule}
 */
export function useChatModule(app) {
    if (!__singleton && app) __singleton = new ChatModule(app);
    return __singleton;
}
