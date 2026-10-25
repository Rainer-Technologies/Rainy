import { RequestHelper } from "../helper/request.js";
import { Result } from "../helper/result.js";
import { Service } from "./index.js";

/**
 * @typedef {Object} ErrorModel
 * @property {string} error
 */

/**
 * @typedef {Object} PresenceModel
 * @property {number} user_id
 * @property {boolean} online
 * @property {{song_id: number, title: string, artist: string, album: string, cover_path: string}|null} listening
 * @property {boolean} typing
 */

/**
 * @typedef {Object} ChatMessageModel
 * @property {number} id
 * @property {number} sender_id
 * @property {number} recipient_id
 * @property {'text'|'song'|'playlist_invite'} kind
 * @property {string|null} body
 * @property {number} created_at
 * @property {{id: number, title: string, artist: string, album: string, duration: number, cover_path: string, in_library: boolean}|null} [song]
 * @property {{share_id: number|null, playlist_id: number|null, playlist_name: string|null, role: string|null, state: 'pending'|'accepted'|'closed'}} [invite]
 */

/**
 * @typedef {Object} ConversationModel
 * @property {{id: number, username: string}} friend
 * @property {ChatMessageModel|null} last_message
 * @property {number} unread
 * @property {PresenceModel|null} presence
 */

export class ChatService extends Service {
    constructor() {
        super('/api/chat');
    }

    /** @returns {Promise<Result<{conversations: ConversationModel[]}, ErrorModel>>} */
    conversations() {
        return this.wrap(RequestHelper.request(this.url('/conversations')));
    }

    /** @returns {Promise<Result<{messages: ChatMessageModel[], read_by_friend: number}, ErrorModel>>} */
    messages(friendId, before = null) {
        const query = before ? `?before=${before}` : '';
        return this.wrap(RequestHelper.request(this.url(`/${friendId}/messages${query}`)));
    }

    /** @returns {Promise<Result<{message: ChatMessageModel}, ErrorModel>>} */
    send(friendId, payload) {
        return this.wrap(RequestHelper.request(this.url(`/${friendId}/messages`), {
            method: 'POST',
            body: payload,
        }));
    }

    /** @returns {Promise<Result<{last_read_id: number}, ErrorModel>>} */
    read(friendId) {
        return this.wrap(RequestHelper.request(this.url(`/${friendId}/read`), { method: 'POST' }));
    }

    typing(friendId) {
        return this.wrap(RequestHelper.request(this.url(`/${friendId}/typing`), { method: 'POST' }));
    }

    /** @returns {Promise<Result<{share_online: boolean, share_listening: boolean}, ErrorModel>>} */
    settings() {
        return this.wrap(RequestHelper.request(this.url('/settings')));
    }

    /** @returns {Promise<Result<{share_online: boolean, share_listening: boolean}, ErrorModel>>} */
    updateSettings(values) {
        return this.wrap(RequestHelper.request(this.url('/settings'), {
            method: 'PUT',
            body: values,
        }));
    }

    /** The URL of the live event stream (see docs/CHAT.md). */
    streamUrl(after = null) {
        return this.url(after ? `/stream?after=${after}` : '/stream');
    }
}

const __singleton = new ChatService();

/**
 * @returns {ChatService}
 */
export function useChatService() {
    return __singleton;
};
