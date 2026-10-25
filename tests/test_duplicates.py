"""Duplicate songs: merging copies that share tags, chat messages and ratings."""
import pytest

from models.database import Database
from models.user import UserModel


@pytest.fixture
def copies():
    """Three copies of one song, owned by the admin (user 1), plus a friend."""
    friend_email = 'dupfriend@test.local'
    if not UserModel.get_user_by_email(friend_email):
        UserModel.create_user('dup_friend', friend_email, 'secret1')
    friend = UserModel.get_user_by_email(friend_email)['id']

    ids = [Database.execute_query(
        "INSERT INTO songs (file_path, title, artist, album) VALUES (%s, %s, %s, %s)",
        (f'/test/dup-merge-{i}.mp3', 'Merge Me', 'Dup Artist', 'Dup Album'))
        for i in range(3)]
    for song_id in ids:
        Database.execute_query(
            "INSERT IGNORE INTO library_access (user_id, song_id, origin) "
            "VALUES (1, %s, 'scan')", (song_id,))
    yield {'ids': ids, 'friend': friend}
    Database.execute_query(
        "DELETE FROM songs WHERE id IN (%s, %s, %s)", tuple(ids))
    UserModel.delete_user(friend)


def _tags(song_id):
    rows = Database.execute_query(
        "SELECT tag_name, source FROM song_tags WHERE song_id = %s",
        (song_id,), fetch_all=True) or []
    return {(r['tag_name'], r['source']) for r in rows}


def test_copies_with_the_same_tags_merge(client, copies):
    """Copies of one song usually carry the same Last.fm tags: the unique
    (song, tag, source) key used to make the whole merge fail with a 500."""
    a, b, c = copies['ids']
    for song_id, extra in ((a, 'rap'), (b, 'trap'), (c, None)):
        Database.execute_query(
            "INSERT INTO song_tags (song_id, tag_name, weight, source) "
            "VALUES (%s, 'hip hop', 90, 'lastfm')", (song_id,))
        if extra:
            Database.execute_query(
                "INSERT INTO song_tags (song_id, tag_name, weight, source) "
                "VALUES (%s, %s, 50, 'lastfm')", (song_id, extra))

    res = client.post('/api/music/duplicates/merge',
                      json={'song_ids': [a, b, c], 'keeper_id': a})
    assert res.status_code == 200, res.get_json()
    assert res.get_json()['removed_count'] == 2

    # The keeper has every tag once; the other copies are gone.
    assert _tags(a) == {('hip hop', 'lastfm'), ('rap', 'lastfm'), ('trap', 'lastfm')}
    assert Database.execute_query(
        "SELECT COUNT(*) AS n FROM songs WHERE id IN (%s, %s)", (b, c),
        fetch_one=True)['n'] == 0


def test_a_song_sent_in_the_chat_follows_the_keeper(client, copies):
    keeper, loser, _ = copies['ids']
    message = Database.execute_query(
        "INSERT INTO chat_messages (sender_id, recipient_id, kind, song_id, created_at) "
        "VALUES (1, %s, 'song', %s, 1.0)", (copies['friend'], loser))

    res = client.post('/api/music/duplicates/merge',
                      json={'song_ids': [keeper, loser], 'keeper_id': keeper})
    assert res.status_code == 200, res.get_json()
    row = Database.execute_query(
        "SELECT song_id FROM chat_messages WHERE id = %s", (message,),
        fetch_one=True)
    assert row['song_id'] == keeper


def test_merge_all_handles_shared_tags_too(client, copies):
    for song_id in copies['ids']:
        Database.execute_query(
            "INSERT INTO song_tags (song_id, tag_name, weight, source) "
            "VALUES (%s, 'pop', 80, 'musicbrainz')", (song_id,))

    res = client.post('/api/music/duplicates/merge-all')
    assert res.status_code == 200, res.get_json()
    left = Database.execute_query(
        "SELECT COUNT(*) AS n FROM songs WHERE title = 'Merge Me'",
        fetch_one=True)['n']
    assert left == 1
