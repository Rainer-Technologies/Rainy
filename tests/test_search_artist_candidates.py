import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from utils.metadata import MetadataSearcher

def test_search_artist_candidates():
    s = MetadataSearcher()
    candidates = s.search_artist_candidates("Pink Floyd", limit=5)
    assert isinstance(candidates, list)
    for c in candidates:
        assert "name" in c
        assert "channel_id" in c
        assert "image_url" in c
        assert "description" in c
        assert "source_url" in c
    print(f"Found {len(candidates)} candidates for 'Pink Floyd'")
    for c in candidates:
        print(f"  - {c['name']} ({c['channel_id']})")

if __name__ == "__main__":
    test_search_artist_candidates()
