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


def test_enrich_show_carries_upcoming_dub_airing_schedule() -> None:
    from datetime import timedelta

    from tracker_lib import now_utc

    last_at = now_utc() - timedelta(hours=1)
    next_at = now_utc() + timedelta(days=7)
    show = {
        "id": 42,
        "title": "Dub Schedule Test",
        "episodes": 12,
        "status": "RELEASING",
        "dubAired": 4,
    }
    dub_schedule = {
        42: {
            "episodeNumber": 4,
            "episodeDate": last_at.isoformat(),
            "media": {
                "media": {
                    "airingSchedule": {
                        "nodes": [{"episode": 5, "airingAt": next_at.isoformat()}]
                    }
                }
            },
        }
    }

    out = enrich_show(show, {}, dub_schedule, {42: {"episode": {"aired": 4}}})

    assert out["dubAired"] == 4
    assert out["upcomingDub"][0]["episode"] == 5
    assert out["lastEvents"]["dub"]["episode"] == 4
    assert out["lastEvents"]["dub"]["at"] == last_at.isoformat()


def test_enrich_show_prefers_newer_sub_schedule_over_stale_anilist_time() -> None:
    from datetime import timedelta

    from tracker_lib import now_utc

    now = now_utc()
    stale_at = now - timedelta(days=7)
    last_at = now - timedelta(hours=1)
    next_at = now + timedelta(days=7)
    show = {
        "id": 84,
        "title": "Stale Next Episode Test",
        "episodes": 19,
        "status": "RELEASING",
        "subAired": 17,
        "nextSubEpisode": 18,
        "nextSubAt": stale_at.isoformat(),
    }
    sub_schedule = {
        84: {
            "airingSchedule": {
                "nodes": [
                    {"episode": 17, "airingAt": last_at.isoformat()},
                    {"episode": 18, "airingAt": next_at.isoformat()},
                ]
            }
        }
    }

    out = enrich_show(show, sub_schedule, {}, {})

    assert out["subAired"] == 17
    assert out["nextEvents"][0]["episode"] == 18
    assert out["nextEvents"][0]["at"] == next_at.isoformat()
    assert out["lastEvents"]["sub"]["episode"] == 17


def test_enrich_show_includes_finale_dates_only_when_available(monkeypatch, tmp_path) -> None:
    import json

    import tracker_lib

    monkeypatch.setattr(tracker_lib, "CACHE_DIR", tmp_path / "cache")
    cache_path = tracker_lib.CACHE_DIR / "media-42.json"
    cache_path.parent.mkdir(parents=True)
    cache_path.write_text(json.dumps({
        "data": {
            "Media": {
                "airingSchedule": {
                    "nodes": [{"episode": 12, "airingAt": "2026-09-23T12:30:00Z"}]
                }
            }
        }
    }))
    show = {"id": 42, "title": "Finale Date Test", "episodes": 12, "status": "FINISHED"}
    dub_schedule = {42: {"episodeNumber": 12, "episodeDate": "2026-09-24T13:30:00Z"}}
    dub_feed = {42: {"episode": {"aired": 12, "airedAt": "2026-09-24T13:30:00Z"}}}

    out = tracker_lib.enrich_show(show, {}, dub_schedule, dub_feed)

    assert out["finalEvents"]["sub"]["episode"] == 12
    assert out["finalEvents"]["sub"]["at"] == "2026-09-23T12:30:00+00:00"
    assert out["finalEvents"]["dub"]["episode"] == 12
    assert out["finalEvents"]["dub"]["at"] == "2026-09-24T13:30:00+00:00"


def test_enrich_show_estimates_dub_finale_from_scheduled_episode() -> None:
    from datetime import timedelta

    from tracker_lib import now_utc

    next_at = now_utc() + timedelta(days=7)
    show = {"id": 43, "title": "Dub Finale Estimate Test", "episodes": 12, "status": "RELEASING"}
    dub_schedule = {
        43: {
            "episodeNumber": 4,
            "episodeDate": (next_at - timedelta(days=7)).isoformat(),
            "episodes": 12,
            "media": {"media": {"airingSchedule": {"nodes": [{"episode": 5, "airingAt": next_at.isoformat()}]}}},
        }
    }

    out = enrich_show(show, {}, dub_schedule, {43: {"episode": {"aired": 4}}})
    estimated = out["finalEvents"]["dub"]

    assert estimated["episode"] == 12
    assert estimated["estimated"] is True
    assert estimated["at"] == (next_at + timedelta(weeks=7)).isoformat()


def test_enrich_show_infers_episode_total_for_new_show_finale_estimate() -> None:
    from datetime import timedelta

    from tracker_lib import enrich_show, now_utc

    next_at = now_utc() + timedelta(days=7)
    sub_nodes = [
        {"episode": episode, "airingAt": (next_at + timedelta(weeks=episode - 2)).isoformat()}
        for episode in range(2, 13)
    ]
    show = {
        "id": 43,
        "title": "New Show With Unknown Total",
        "episodes": None,
        "status": "RELEASING",
        "nextSubEpisode": 2,
        "nextSubAt": next_at.isoformat(),
    }
    sub_schedule = {43: {"airingSchedule": {"nodes": sub_nodes}}}
    dub_schedule = {
        43: {
            "episodeNumber": 1,
            "episodeDate": (next_at - timedelta(days=7)).isoformat(),
            "media": {"media": {"airingSchedule": {"nodes": [{"episode": 2, "airingAt": next_at.isoformat()}]}}},
        }
    }

    out = enrich_show(show, sub_schedule, dub_schedule, {43: {"episode": {"aired": 1}}})

    assert out["episodes"] is None
    assert out["finalEvents"]["sub"]["episode"] == 12
    assert out["finalEvents"]["sub"]["at"] == (next_at + timedelta(weeks=10)).isoformat()
    assert out["finalEvents"]["dub"]["episode"] == 12
    assert out["finalEvents"]["dub"]["estimated"] is True
    assert out["finalEvents"]["dub"]["at"] == (next_at + timedelta(weeks=10)).isoformat()


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


def test_error_log_can_be_read_and_cleared(monkeypatch, tmp_path) -> None:
    import tracker_lib

    monkeypatch.setattr(tracker_lib, "ERROR_LOG_PATH", tmp_path / "errors.log")

    tracker_lib.write_error_log("Test error", detail="failure details")
    assert "Test error" in tracker_lib.read_error_log()
    assert "failure details" in tracker_lib.read_error_log()

    tracker_lib.clear_error_log()
    assert tracker_lib.read_error_log() == ""


def test_concurrent_cache_writes_use_independent_temp_files(monkeypatch, tmp_path) -> None:
    from concurrent.futures import ThreadPoolExecutor
    import json

    import tracker_lib

    monkeypatch.setattr(tracker_lib, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(tracker_lib, "ensure_database", lambda: None)

    with ThreadPoolExecutor(max_workers=8) as executor:
        list(
            executor.map(
                lambda value: tracker_lib.cache_set("shared.json", {"value": value}),
                range(64),
            )
        )

    result = json.loads((tracker_lib.CACHE_DIR / "shared.json").read_text())
    assert result["value"] in range(64)


def test_upstream_429_sets_retry_after_cooldown(monkeypatch) -> None:
    from email.message import Message
    from io import BytesIO
    from urllib.error import HTTPError

    import pytest
    import tracker_lib

    url = "https://rate-limit-test.invalid/graphql"
    host = "rate-limit-test.invalid"
    headers = Message()
    headers["Retry-After"] = "17"
    error_body = b'{"errors":[{"message":"Too Many Requests.","status":429}]}'
    calls = 0

    def rate_limited(*args, **kwargs):
        nonlocal calls
        calls += 1
        raise HTTPError(url, 429, "Too Many Requests", headers, BytesIO(error_body))

    monkeypatch.setattr(tracker_lib, "urlopen", rate_limited)
    monkeypatch.setitem(tracker_lib.UPSTREAM_COOLDOWN_UNTIL, host, 0)
    monkeypatch.setitem(tracker_lib.UPSTREAM_NEXT_REQUEST, host, 0)

    with pytest.raises(tracker_lib.UpstreamAPIError) as first:
        tracker_lib.http_json(url, {"query": "{}"})
    with pytest.raises(tracker_lib.UpstreamAPIError) as second:
        tracker_lib.http_json(url, {"query": "{}"})

    assert first.value.status == 429
    assert first.value.retry_after == 17
    assert second.value.retry_after is not None
    assert calls == 1


def test_http_json_retries_transient_failure_only_once(monkeypatch) -> None:
    from urllib.error import URLError

    import pytest
    import tracker_lib

    calls = 0

    def unavailable(*args, **kwargs):
        nonlocal calls
        calls += 1
        raise URLError("temporary outage")

    monkeypatch.setattr(tracker_lib, "urlopen", unavailable)
    monkeypatch.setattr(tracker_lib, "UPSTREAM_RETRY_DELAY", 0)
    monkeypatch.setitem(tracker_lib.UPSTREAM_REQUEST_INTERVALS, "retry-test.invalid", 0)

    with pytest.raises(tracker_lib.UpstreamAPIError, match="temporary outage"):
        tracker_lib.http_json("https://retry-test.invalid/graphql", {"query": "{}"})

    assert calls == 2


def test_http_json_surfaces_graphql_errors_in_success_response(monkeypatch) -> None:
    import json

    import pytest
    import tracker_lib

    class FakeResponse:
        headers = {}

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return json.dumps({"errors": [{"message": "Invalid query", "status": 400}]}).encode()

    monkeypatch.setattr(tracker_lib, "urlopen", lambda *args, **kwargs: FakeResponse())

    with pytest.raises(tracker_lib.UpstreamAPIError, match="Invalid query") as error:
        tracker_lib.http_json("https://graphql-error-test.invalid/graphql", {"query": "{}"})

    assert error.value.status == 400


def test_stale_cache_fallback_returns_old_data_and_throttles_warnings(monkeypatch, tmp_path) -> None:
    import json

    import tracker_lib

    monkeypatch.setattr(tracker_lib, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(tracker_lib, "ERROR_LOG_PATH", tmp_path / "errors.log")
    monkeypatch.setattr(tracker_lib, "STALE_CACHE_WARNING_AT", {})
    cache_path = tracker_lib.CACHE_DIR / "media-42.json"
    cache_path.parent.mkdir(parents=True)
    cache_path.write_text(json.dumps({"data": {"Media": {"id": 42}}}))
    error = tracker_lib.UpstreamAPIError("graphql.anilist.co", "temporarily unavailable", 503)

    assert tracker_lib.stale_cache_fallback("media-42.json", error) == {"data": {"Media": {"id": 42}}}
    assert tracker_lib.stale_cache_fallback("media-42.json", error) == {"data": {"Media": {"id": 42}}}
    assert tracker_lib.read_error_log().count("Using stale upstream cache") == 1


def test_season_catalog_caches_all_pages_for_three_hours_and_force_refreshes(monkeypatch, tmp_path) -> None:
    import os
    import time

    import tracker_lib

    monkeypatch.setattr(tracker_lib, "DATA_DIR", tmp_path)
    monkeypatch.setattr(tracker_lib, "LIBRARY_PATH", tmp_path / "library.json")
    monkeypatch.setattr(tracker_lib, "SETTINGS_PATH", tmp_path / "settings.json")
    monkeypatch.setattr(tracker_lib, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(tracker_lib, "DB_PATH", tmp_path / "tracker.db")
    tracker_lib.ensure_database()

    requests = []
    hub = tracker_lib.DataHub()

    def anilist(query, variables):
        page = variables["page"]
        requests.append(page)
        media = {
            "id": page,
            "title": {"english": f"Page {page}"},
            "season": "FALL",
            "seasonYear": 2026,
        }
        return {
            "data": {
                "Page": {
                    "pageInfo": {"currentPage": page, "lastPage": 2, "hasNextPage": page < 2},
                    "media": [media],
                }
            }
        }

    monkeypatch.setattr(hub, "anilist", anilist)

    first = hub.fetch_season_catalog("FALL", 2026)
    second = hub.fetch_season_catalog("FALL", 2026)
    assert [item["id"] for item in first["media"]] == [1, 2]
    assert [item["id"] for item in second["media"]] == [1, 2]
    assert requests == [1, 2]
    assert tracker_lib.SEASON_CATALOG_TTL == 3 * 60 * 60

    stale_time = time.time() - tracker_lib.SEASON_CATALOG_TTL - 1
    for page in (1, 2):
        cache_file = tracker_lib.CACHE_DIR / f"season-v2-FALL-2026-p{page}.json"
        os.utime(cache_file, (stale_time, stale_time))
    hub.fetch_season_catalog("FALL", 2026)
    hub.fetch_season_catalog("FALL", 2026, force_refresh=True)

    assert requests == [1, 2, 1, 2, 1, 2]


def test_media_tags_are_migrated_and_stored(monkeypatch, tmp_path) -> None:
    import json
    import sqlite3

    import tracker_lib

    monkeypatch.setattr(tracker_lib, "DATA_DIR", tmp_path)
    monkeypatch.setattr(tracker_lib, "DB_PATH", tmp_path / "tracker.db")

    tracker_lib.ensure_database()
    with sqlite3.connect(tracker_lib.DB_PATH) as conn:
        conn.execute("ALTER TABLE media DROP COLUMN tags_json")
    tracker_lib.ensure_database()
    with sqlite3.connect(tracker_lib.DB_PATH) as conn:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(media)")}
    assert "tags_json" in columns

    tags = [{"name": "Fantasy", "rank": 80}]
    tracker_lib.store_media_records(
        [{"id": 9, "title": {"english": "Tagged show"}, "tags": tags}],
        "FALL",
        2026,
    )
    with sqlite3.connect(tracker_lib.DB_PATH) as conn:
        stored = conn.execute("SELECT tags_json FROM media WHERE id = 9").fetchone()[0]
    assert json.loads(stored) == tags
    assert tracker_lib.compact_media({"id": 9, "tags": tags}, "english")["tags"] == tags


def test_zoom_settings_default_and_persist(monkeypatch, tmp_path) -> None:
    import tracker_lib

    monkeypatch.setattr(tracker_lib, "DATA_DIR", tmp_path)
    monkeypatch.setattr(tracker_lib, "SETTINGS_PATH", tmp_path / "settings.json")

    zoom_keys = ("mainZoom", "pickerZoom", "settingsZoom", "notificationsZoom", "detailsZoom")
    defaults = tracker_lib.load_settings()
    assert all(defaults[key] == 75 for key in zoom_keys)
    assert defaults["cardSort"] == "name"
    assert defaults["detailsPanelX"] == 0.5
    assert defaults["detailsPanelY"] == 0.5

    tracker_lib.save_json(tracker_lib.SETTINGS_PATH, {"mainZoom": 50, "detailsZoom": 100, "cardSort": "air", "detailsPanelX": 0.2, "detailsPanelY": 0.8})
    persisted = tracker_lib.load_settings()
    assert persisted["mainZoom"] == 50
    assert persisted["detailsZoom"] == 100
    assert persisted["pickerZoom"] == 75
    assert persisted["cardSort"] == "air"
    assert persisted["detailsPanelX"] == 0.2
    assert persisted["detailsPanelY"] == 0.8


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


def test_removing_library_show_cleans_only_its_derived_rows(monkeypatch, tmp_path) -> None:
    import sqlite3

    import tracker_lib

    monkeypatch.setattr(tracker_lib, "DATA_DIR", tmp_path)
    monkeypatch.setattr(tracker_lib, "DB_PATH", tmp_path / "tracker.db")
    tracker_lib.ensure_database()
    for anime_id in (42, 99):
        tracker_lib.db_add_library_show({
            "id": anime_id,
            "title": f"Show {anime_id}",
            "titles": {"english": f"Show {anime_id}"},
        })
        tracker_lib.store_media_records(
            [{"id": anime_id, "title": {"english": f"Show {anime_id}"}}],
            "FALL",
            2026,
        )

    with sqlite3.connect(tracker_lib.DB_PATH) as conn:
        conn.executemany(
            """INSERT INTO weekly_schedule (
                year, month, week_num, anime_id, anime_title, episode,
                air_day, air_date, air_ts, source, fetched_at
            ) VALUES (2026, 9, 1, ?, ?, 1, 'Tuesday', '2026-09-01', 1790000000, 'sub', 1)""",
            [(42, "Show 42"), (99, "Show 99")],
        )

    remaining = tracker_lib.db_remove_library_show(42)

    with sqlite3.connect(tracker_lib.DB_PATH) as conn:
        media_ids = {row[0] for row in conn.execute("SELECT id FROM media")}
        schedule_ids = {row[0] for row in conn.execute("SELECT DISTINCT anime_id FROM weekly_schedule")}

    assert [show["id"] for show in remaining] == [99]
    assert media_ids == {99}
    assert schedule_ids == {99}


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
