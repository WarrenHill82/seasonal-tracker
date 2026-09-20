from datetime import date, datetime, timezone

from tracker_lib import enrich_show, jst_weekday, rolling_week_bounds, schedule_window


def test_rolling_week_starts_today_and_runs_to_week_end() -> None:
    # Saturday 2026-09-19, Sunday-start week should only include today and the
    # remaining days in the same week, never the past days from the same week.
    start, end = rolling_week_bounds("sunday", datetime(2026, 9, 19, 12, 0, tzinfo=timezone.utc))
    assert start.isoformat() == "2026-09-19T00:00:00+00:00"
    assert end.isoformat() == "2026-09-27T00:00:00+00:00"


def test_jst_weekday_tracks_tokyo_broadcast_day() -> None:
    # 2026-09-20 17:00 JST is Sunday local time in Tokyo, even though it is
    # Saturday 2026-09-19 09:00 UTC.
    d = datetime(2026, 9, 19, 9, 0, tzinfo=timezone.utc)
    assert jst_weekday(d) == 0


def test_schedule_window_respects_offset_for_weekly_views() -> None:
    start, end, label = schedule_window("this_week", "sunday", offset=1, now=datetime(2026, 9, 19, 12, 0, tzinfo=timezone.utc))
    assert start.isoformat() == "2026-09-20T00:00:00+01:00"
    assert end.isoformat() == "2026-09-27T00:00:00+01:00"
    assert label == "20 Sep – 26 Sep"


def test_finished_show_keeps_its_last_known_airing_event() -> None:
    show = {
        "id": 1,
        "title": "Test Show",
        "episodes": 2,
        "status": "FINISHED",
        "nextSubEpisode": 2,
        "nextSubAt": "2020-01-01T12:00:00+00:00",
    }
    out = enrich_show(show, {}, {}, {})
    assert len(out["nextEvents"]) == 1
    assert out["nextEvents"][0]["episode"] == 2


def test_cache_round_trip_uses_sqlite(monkeypatch, tmp_path) -> None:
    import tracker_lib

    monkeypatch.setattr(tracker_lib, "DATA_DIR", tmp_path)
    monkeypatch.setattr(tracker_lib, "LIBRARY_PATH", tmp_path / "library.json")
    monkeypatch.setattr(tracker_lib, "SETTINGS_PATH", tmp_path / "settings.json")
    monkeypatch.setattr(tracker_lib, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(tracker_lib, "DB_PATH", tmp_path / "tracker.db")

    tracker_lib.ensure_database()
    tracker_lib.cache_set("demo.json", {"a": 1, "b": [2, 3]})

    assert tracker_lib.cache_get("demo.json", 60) == {"a": 1, "b": [2, 3]}


def test_populate_weekly_schedule_skips_rows_missing_anime_id(monkeypatch, tmp_path) -> None:
    import sqlite3

    import tracker_lib

    monkeypatch.setattr(tracker_lib, "DATA_DIR", tmp_path)
    monkeypatch.setattr(tracker_lib, "LIBRARY_PATH", tmp_path / "library.json")
    monkeypatch.setattr(tracker_lib, "SETTINGS_PATH", tmp_path / "settings.json")
    monkeypatch.setattr(tracker_lib, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(tracker_lib, "DB_PATH", tmp_path / "tracker.db")

    bad = {"title": {"english": "Broken Entry"}, "airingSchedule": {"nodes": [{"episode": 1, "airingAt": 1750000000}]}}
    good = {
        "id": 42,
        "title": {"english": "Good Entry", "romaji": "Good Entry"},
        "airingSchedule": {"nodes": [{"episode": 1, "airingAt": 1750000000}]},
    }
    monkeypatch.setattr(tracker_lib.HUB, "sub_schedule", lambda: [bad, good])

    tracker_lib.ensure_database()
    inserted = tracker_lib.populate_weekly_schedule(2025, 9, source="sub")

    assert inserted == 1
    with sqlite3.connect(tracker_lib.DB_PATH) as conn:
        rows = conn.execute('SELECT COUNT(*) FROM weekly_schedule').fetchone()[0]
    assert rows == 1


def test_library_title_jap_comes_from_romaji(monkeypatch, tmp_path) -> None:
    import sqlite3

    import tracker_lib

    monkeypatch.setattr(tracker_lib, "DATA_DIR", tmp_path)
    monkeypatch.setattr(tracker_lib, "LIBRARY_PATH", tmp_path / "library.json")
    monkeypatch.setattr(tracker_lib, "SETTINGS_PATH", tmp_path / "settings.json")
    monkeypatch.setattr(tracker_lib, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(tracker_lib, "DB_PATH", tmp_path / "tracker.db")

    tracker_lib.ensure_database()
    tracker_lib.db_add_library_show(
        {
            "id": 42,
            "idMal": 99,
            "title": "English Title",
            "titles": {"english": "English Title", "romaji": "Romaji Title"},
            "cover": "cover.jpg",
            "episodes": 12,
            "format": "TV",
            "status": "RELEASING",
            "season": "SPRING",
            "seasonYear": 2026,
        }
    )

    with sqlite3.connect(tracker_lib.DB_PATH) as conn:
        cols = [row[1] for row in conn.execute("PRAGMA table_info(library)")]
        assert "title_jap" in cols
        assert "titles_json" not in cols
        row = conn.execute(
            "SELECT title, title_jap FROM library WHERE id = 42"
        ).fetchone()

    assert row == ("English Title", "Romaji Title")


def test_populate_weekly_schedule_filters_to_saved_library(monkeypatch, tmp_path) -> None:
    import sqlite3

    import tracker_lib

    monkeypatch.setattr(tracker_lib, "DATA_DIR", tmp_path)
    monkeypatch.setattr(tracker_lib, "LIBRARY_PATH", tmp_path / "library.json")
    monkeypatch.setattr(tracker_lib, "SETTINGS_PATH", tmp_path / "settings.json")
    monkeypatch.setattr(tracker_lib, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(tracker_lib, "DB_PATH", tmp_path / "tracker.db")

    tracker_lib.ensure_database()
    tracker_lib.db_add_library_show({"id": 42, "title": "Saved Show", "titles": {"romaji": "Saved Show"}})
    tracker_lib.db_add_library_show({"id": 99, "title": "Other Show", "titles": {"romaji": "Other Show"}})

    monkeypatch.setattr(
        tracker_lib.HUB,
        "sub_schedule",
        lambda: [
            {"id": 42, "title": {"english": "Saved Show"}, "airingSchedule": {"nodes": [{"episode": 1, "airingAt": 1750000000}]}},
            {"id": 99, "title": {"english": "Other Show"}, "airingSchedule": {"nodes": [{"episode": 2, "airingAt": 1750000000}]}} ,
        ],
    )

    inserted = tracker_lib.populate_weekly_schedule(2025, 9, source="sub")
    assert inserted == 1

    with sqlite3.connect(tracker_lib.DB_PATH) as conn:
        rows = conn.execute("SELECT anime_id FROM weekly_schedule").fetchall()
    assert rows == [(42,)]


def test_populate_weekly_schedule_omits_missing_source_row(monkeypatch, tmp_path) -> None:
    import sqlite3

    import tracker_lib

    monkeypatch.setattr(tracker_lib, "DATA_DIR", tmp_path)
    monkeypatch.setattr(tracker_lib, "LIBRARY_PATH", tmp_path / "library.json")
    monkeypatch.setattr(tracker_lib, "SETTINGS_PATH", tmp_path / "settings.json")
    monkeypatch.setattr(tracker_lib, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(tracker_lib, "DB_PATH", tmp_path / "tracker.db")

    tracker_lib.ensure_database()
    tracker_lib.db_add_library_show({"id": 42, "title": "Saved Show", "titles": {"romaji": "Saved Show"}})
    tracker_lib.db_add_library_show({"id": 99, "title": "Missing Show", "titles": {"romaji": "Missing Show"}})

    monkeypatch.setattr(
        tracker_lib.HUB,
        "sub_schedule",
        lambda: [
            {"id": 42, "title": {"english": "Saved Show"}, "airingSchedule": {"nodes": [{"episode": 1, "airingAt": 1757776000}]}}
        ],
    )

    inserted = tracker_lib.populate_weekly_schedule(2025, 9, source="sub")
    assert inserted == 1

    with sqlite3.connect(tracker_lib.DB_PATH) as conn:
        rows = conn.execute(
            "SELECT anime_id, anime_title, source, air_date FROM weekly_schedule ORDER BY anime_id"
        ).fetchall()
    assert (42, "Saved Show", "sub", "2025-09-13") in rows
    assert all(row[0] != 99 for row in rows)


def test_build_library_schedule_loads_media_before_filtered_schedule(monkeypatch, tmp_path) -> None:
    import sqlite3

    import tracker_lib

    monkeypatch.setattr(tracker_lib, "DATA_DIR", tmp_path)
    monkeypatch.setattr(tracker_lib, "DB_PATH", tmp_path / "tracker.db")
    monkeypatch.setattr(tracker_lib, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(
        tracker_lib.HUB,
        "media_details",
        lambda media_id: {
            "data": {
                "Media": {
                    "id": media_id,
                    "title": {"english": "Demo", "romaji": "Demo"},
                    "season": "FALL",
                    "seasonYear": 2026,
                }
            }
        },
    )
    monkeypatch.setattr(
        tracker_lib.HUB,
        "sub_schedule",
        lambda: [
            {
                "id": 7,
                "title": {"english": "Demo", "romaji": "Demo"},
                "airingSchedule": {"nodes": [{"episode": 1, "airingAt": 1790121600}]},
            }
        ],
    )

    result = tracker_lib.build_library_schedule(
        library_ids=[7],
        date_ranges=[(date(2026, 9, 1), date(2026, 10, 1))],
        sources=("sub",),
    )

    with sqlite3.connect(tracker_lib.DB_PATH) as conn:
        media_count = conn.execute("SELECT COUNT(*) FROM media").fetchone()[0]
        schedule_count = conn.execute("SELECT COUNT(*) FROM weekly_schedule").fetchone()[0]

    assert result == {"media": 1, "schedule": 1}
    assert media_count == 1
    assert schedule_count == 1
