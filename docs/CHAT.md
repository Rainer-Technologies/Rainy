# Friends chat

Friends can message each other, send songs, invite each other to playlists and see who is online and listening. Everything is between two accepted friends: each request checks the friendship, so unfriending closes the conversation (the history stays in the database).

## Concepts

- **Message kinds:** `text` (`body`, up to 2000 characters), `song` (`song_id`, optional `body` note) and `playlist_invite` (`playlist_id`, `role`). The server also writes `listen_invite` (see [Listen together](#listen-together)); clients cannot send it.
- **Songs are references.** The receiver can stream and download a song a friend sent them while they are friends (`LibraryAccessModel.can_play`) and keeps it with the usual `POST /api/music/library/songs/<id>`. Only songs in the sender's own library can be sent.
- **Invitations are real shares.** Sending one creates a pending `playlist_shares` row. The receiver answers with `/api/playlists/invites/<share_id>/accept|decline`; the message shows the live state (`pending`, `accepted` or `closed`).
- **Presence.** An account is online while a client holds its chat stream open (or a Rainy Connect device is alive). "Listening" comes from the Connect heartbeat the players already send. `share_online` and `share_listening` (per account, default on) decide what friends see; a hidden account looks offline.

## API

All under `/api/chat`, session cookie like the rest of the API.

| Request | Answer |
|---|---|
| `GET /conversations` | every friend with `last_message`, `unread` and `presence`, newest conversation first |
| `GET /<friend_id>/messages?before=&limit=` | `{messages, read_by_friend}`: one page, oldest first, and how far the friend has read yours |
| `POST /<friend_id>/messages` | `{kind, body?, song_id?, playlist_id?, role?}` → `201 {message}` |
| `POST /<friend_id>/read` | `{up_to?}` → `{last_read_id}` (marks only move forward) |
| `POST /<friend_id>/typing` | ping while the user types (every ~3 s at most) |
| `GET /presence` | `[{user_id, online, listening, typing}]` |
| `GET` / `PUT /settings` | `{share_online, share_listening}` |
| `GET /stream` | server-sent events, below |

A message is `{id, sender_id, recipient_id, kind, body, created_at}` plus `song` (`id, title, artist, album, duration, cover_path, in_library`; `null` once deleted) or `invite` (`share_id, playlist_id, playlist_name, role, state`).

## Stream

`GET /api/chat/stream?after=<message id>` is one long request per client (up to 6 per account), recycled every 5 minutes. Without `after` (or `Last-Event-ID`, which browsers send on their own) only new messages arrive. Events:

- `open`: the stream is up.
- `message`: a message the account sent or received, `id:` is the message id. Devices of the sender get their own messages too, so clients de-duplicate by id.
- `presence`: `{users: [...], full}`; the first one is the full list, later ones carry only what changed.
- `read`: `{reader_id, author_id, last_read_id}`.
- `listen`: a listen-together session the account hosts or is part of, as that account sees it (see below). Sent on open, and again whenever the session's `version` moves.

Workers do not share memory: a stream reaches other workers' news by polling the database once a second, like Rainy Connect. Every open stream occupies a server thread, which is why the default gunicorn setting is 32 threads per worker.

## Listen together

A host plays something and invites friends to hear it in sync. The invitation is a `listen_invite` message in the chat, so it arrives live like any other; the card's buttons call the endpoints below.

| Request | Answer |
|---|---|
| `POST /api/listen/invite` `{friend_id, device_id}` | opens the host's session on that device (or keeps the live one, moving it there) and invites the friend → `201 {session}` |
| `GET /api/listen/<id>` | the session as the viewer sees it |
| `POST /api/listen/<id>/join` | takes up an open invitation |
| `POST /api/listen/<id>/leave` | leaves, or declines; the invitation closes |
| `POST /api/listen/<id>/end` | host only: ends it for everyone |

**The rules.** A friend is `invited`, `joined` or `left`. Joining needs an open invitation. Leaving closes it for good: it opens again only when the host invites again, and then only the newest invitation card is open. Ending closes every invitation. Up to 8 friends at once.

**The host's playback** is not sent separately. The Connect heartbeat of the device the session is bound to (`host_device_id`) carries song, position and play state, and `ListenModel.host_beat` moves the session with it. A change of song, play state or place moves `state_seq`; a plain tick only refreshes the position. Songs the host cannot play are never shared.

**What a friend may stream** is the song the host plays now (`LibraryAccessModel.can_play`, `listening_along`), and only while they have joined.

**The snapshot** (`GET /api/listen/<id>`, and the `listen` event) is `{id, status, role, state, host, members, song, playing, position, state_seq, host_live, host_age, version}`. `song` and `playing`/`position` are only given to the host and to friends who joined. `position` is where the host's playback is now, aged by the server. `host_live` is false while the host's device has been silent for 15 seconds.
