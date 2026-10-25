# Friends chat

Friends can message each other, send songs, invite each other to playlists and see who is online and listening. Everything is between two accepted friends: each request checks the friendship, so unfriending closes the conversation (the history stays in the database).

## Concepts

- **Message kinds:** `text` (`body`, up to 2000 characters), `song` (`song_id`, optional `body` note) and `playlist_invite` (`playlist_id`, `role`).
- **Songs are references.** The receiver can stream and download a song a friend sent them while they are friends (`LibraryAccessModel.can_play`) and keeps it with the usual `POST /api/music/library/songs/<id>`. Only songs in the sender's own library can be sent.
- **Invitations are real shares.** Sending one creates a pending `playlist_shares` row. The receiver answers with `/api/playlists/invites/<share_id>/accept|decline`; the message shows the live state (`pending`, `accepted` or `closed`).
- **Presence.** An account is online while a client holds its chat stream open (or a Rainy Connect device is alive). "Listening" comes from the Connect heartbeat the players already send. `share_online` and `share_listening` (per account, default on) decide what friends see; a hidden account looks offline.

## API

All under `/api/chat`, session cookie like the rest of the API.

| Request | Answer |
|---|---|
| `GET /conversations` | every friend with `last_message`, `unread` and `presence`, newest conversation first |
| `GET /<friend_id>/messages?before=&limit=` | one page, oldest first |
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

Workers do not share memory: a stream reaches other workers' news by polling the database once a second, like Rainy Connect. Every open stream occupies a server thread, which is why the default gunicorn setting is 32 threads per worker.
