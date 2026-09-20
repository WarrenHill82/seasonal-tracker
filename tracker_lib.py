#!/usr/bin/env python3
"""Seasonal Tracker data layer — AniList catalog and AniSchedule dub/sub feeds."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA_DIR = Path(os.environ.get("SEASONAL_TRACKER_HOME", Path.home() / ".config" / "seasonal-tracker"))
LIBRARY_PATH = DATA_DIR / "library.json"
SETTINGS_PATH = DATA_DIR / "settings.json"
CACHE_DIR = DATA_DIR / "cache"
DB_PATH = DATA_DIR / "tracker.db"

ANILIST = "https://graphql.anilist.co"
ANISCHEDULE_RAW = "https://raw.githubusercontent.com/RockinChaos/AniSchedule/master/readable"
UA = "SeasonalTracker/0.1 (Nobara desktop widget; +local)"

DEFAULT_SETTINGS = {
    "layout": "rows",
    "theme": "dark",
    "compact": False,
    "showSub": True,
    "showDub": True,
    # split = separate SUB / DUB tracks; combined = one pip row, colour = air state
    "progressMode": "split",
    # stacks only: poster sits under the pips (bottom) or above them (top)
    "stackPoster": "bottom",
    "pickerLayout": "tiles",
    "weekStart": "sunday",
    "opacity": 0.97,
    "titleLanguage": "english",
}

SEASONS = ("WINTER", "SPRING", "SUMMER", "FALL")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def season_of(dt: datetime | None = None) -> tuple[str, int]:
    dt = dt or now_utc()
    m = dt.month
    if m <= 3:
        return "WINTER", dt.year
    if m <= 6:
        return "SPRING", dt.year
    if m <= 9:
        return "SUMMER", dt.year
    return "FALL", dt.year


def next_season(season: str, year: int) -> tuple[str, int]:
    i = SEASONS.index(season)
    if i == 3:
        return "WINTER", year + 1
    return SEASONS[i + 1], year


def week_start_for_date(day: datetime, week_start: str = "sunday") -> datetime:
    start_weekday = 6 if week_start == "sunday" else 0
    days_since = (day.weekday() - start_weekday) % 7
    return (day - timedelta(days=days_since)).replace(hour=0, minute=0, second=0, microsecond=0)


def week_bounds(offset: int, week_start: str = "sunday") -> tuple[datetime, datetime]:
    local = datetime.now().astimezone()
    start = week_start_for_date(local, week_start) + timedelta(days=7 * offset)
    return start, start + timedelta(days=7)


def schedule_window(range_key: str, week_start: str = "sunday", offset: int = 0, now: datetime | None = None) -> tuple[datetime, datetime, str]:
    now_utc_dt = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    if range_key == "today":
        start = now_utc_dt.replace(hour=0, minute=0, second=0, microsecond=0)
        return start, start + timedelta(days=1), start.strftime("%A %-d %b")

    today = now_utc_dt.replace(hour=0, minute=0, second=0, microsecond=0)
    base_start = week_start_for_date(today, week_start)
    delta = offset
    if range_key == "next_week":
        delta += 1
    elif range_key == "week_after":
        delta += 2
    start = base_start + timedelta(days=7 * delta)
    end = start + timedelta(days=7)
    label = f"{start.strftime('%-d %b')} – {(end - timedelta(days=1)).strftime('%-d %b')}"
    return start, end, label


def rolling_week_bounds(week_start: str = "sunday", now: datetime | None = None) -> tuple[datetime, datetime]:
    now_utc_dt = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    today = now_utc_dt.replace(hour=0, minute=0, second=0, microsecond=0)
    week_origin = week_start_for_date(today, week_start)
    week_end = (week_origin + timedelta(days=6)).replace(hour=0, minute=0, second=0, microsecond=0)
    return week_origin, week_end + timedelta(days=1)


def jst_weekday(value: Any) -> int | None:
    dt = parse_airing(value)
    if dt is None:
        return None
    tokyo = dt.astimezone(timezone(timedelta(hours=9)))
    return (tokyo.weekday() + 1) % 7


def today_bounds() -> tuple[datetime, datetime]:
    local = datetime.now().astimezone()
    start = local.replace(hour=0, minute=0, second=0, microsecond=0)
    return start, start + timedelta(days=1)


def parse_airing(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(int(value), tz=timezone.utc)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def http_json(url: str, payload: dict | None = None, timeout: int = 25) -> Any:
    body = None if payload is None else json.dumps(payload).encode()
    headers = {"User-Agent": UA, "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = Request(url, data=body, headers=headers)
    with urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def ensure_database() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("DROP TABLE IF EXISTS cache")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS media (
                id INTEGER PRIMARY KEY,
                season_key TEXT NOT NULL,
                season TEXT,
                season_year INTEGER,
                id_mal INTEGER,
                title_json TEXT,
                episodes INTEGER,
                format TEXT,
                status TEXT,
                genres_json TEXT,
                average_score REAL,
                duration INTEGER,
                is_adult INTEGER,
                site_url TEXT,
                cover_image_json TEXT,
                next_airing_episode_json TEXT,
                start_date_json TEXT,
                raw_json TEXT,
                fetched_at INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS weekly_schedule (
                year INTEGER NOT NULL,
                month INTEGER NOT NULL,
                week_num INTEGER NOT NULL,
                anime_id INTEGER NOT NULL,
                anime_title TEXT NOT NULL,
                episode INTEGER NOT NULL,
                air_day TEXT NOT NULL,
                air_date TEXT NOT NULL,
                air_ts INTEGER NOT NULL,
                source TEXT NOT NULL,
                fetched_at INTEGER NOT NULL,
                UNIQUE(year, month, week_num, anime_id, episode)
                ON CONFLICT REPLACE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS library (
                id INTEGER PRIMARY KEY,
                id_mal INTEGER,
                title TEXT,
                title_jap TEXT,
                cover TEXT,
                color TEXT,
                episodes INTEGER,
                format TEXT,
                status TEXT,
                season TEXT,
                season_year INTEGER,
                next_sub_episode INTEGER,
                next_sub_at TEXT,
                watched_sub INTEGER NOT NULL DEFAULT 0,
                watched_dub INTEGER NOT NULL DEFAULT 0,
                note TEXT NOT NULL DEFAULT '',
                added_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )

        library_cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(library)").fetchall()
        }
        if "titles_json" in library_cols:
            conn.execute("ALTER TABLE library RENAME TO library_old")
            conn.execute(
                """
                CREATE TABLE library (
                    id INTEGER PRIMARY KEY,
                    id_mal INTEGER,
                    title TEXT,
                    title_jap TEXT,
                    cover TEXT,
                    color TEXT,
                    episodes INTEGER,
                    format TEXT,
                    status TEXT,
                    season TEXT,
                    season_year INTEGER,
                    next_sub_episode INTEGER,
                    next_sub_at TEXT,
                    watched_sub INTEGER NOT NULL DEFAULT 0,
                    watched_dub INTEGER NOT NULL DEFAULT 0,
                    note TEXT NOT NULL DEFAULT '',
                    added_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                INSERT INTO library (
                    id, id_mal, title, title_jap, cover, color, episodes, format,
                    status, season, season_year, next_sub_episode, next_sub_at,
                    watched_sub, watched_dub, note, added_at, updated_at
                )
                SELECT
                    id, id_mal, title,
                    json_extract(titles_json, '$.romaji'),
                    cover, color, episodes, format,
                    status, season, season_year, next_sub_episode, next_sub_at,
                    watched_sub, watched_dub, note, added_at, updated_at
                FROM library_old
                """
            )
            conn.execute("DROP TABLE library_old")

        if "title_jap" not in library_cols and "titles_json" not in library_cols:
            conn.execute(
                "ALTER TABLE library ADD COLUMN title_jap TEXT"
            )
            conn.execute(
                "UPDATE library SET title_jap = title WHERE title_jap IS NULL"
            )

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_media_season ON media (season_key, season_year, season)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_weekly_schedule ON weekly_schedule (year, month, week_num, air_day, anime_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_library_updated ON library (updated_at)"
        )
        conn.commit()


def store_media_records(media_list: list[dict], season: str, year: int) -> None:
    if not media_list:
        return
    ensure_database()
    season_key = f"{season}-{year}"
    now_ts = int(time.time())
    with sqlite3.connect(DB_PATH) as conn:
        for item in media_list:
            if not isinstance(item, dict):
                continue
            raw_json = json.dumps(item)
            row = {
                "id": int(item.get("id")),
                "season_key": season_key,
                "season": item.get("season") or season,
                "season_year": int(item.get("seasonYear") or year),
                "id_mal": item.get("idMal"),
                "title_json": json.dumps(item.get("title") or {}),
                "episodes": item.get("episodes"),
                "format": item.get("format"),
                "status": item.get("status"),
                "genres_json": json.dumps(item.get("genres") or []),
                "average_score": item.get("averageScore"),
                "duration": item.get("duration"),
                "is_adult": 1 if item.get("isAdult") else 0,
                "site_url": item.get("siteUrl"),
                "cover_image_json": json.dumps(item.get("coverImage") or {}),
                "next_airing_episode_json": json.dumps(item.get("nextAiringEpisode") or {}),
                "start_date_json": json.dumps(item.get("startDate") or {}),
                "raw_json": raw_json,
                "fetched_at": now_ts,
            }
            conn.execute(
                """
                INSERT INTO media (
                    id, season_key, season, season_year, id_mal,
                    title_json, episodes, format, status, genres_json,
                    average_score, duration, is_adult, site_url,
                    cover_image_json, next_airing_episode_json, start_date_json,
                    raw_json, fetched_at
                ) VALUES (
                    :id, :season_key, :season, :season_year, :id_mal,
                    :title_json, :episodes, :format, :status, :genres_json,
                    :average_score, :duration, :is_adult, :site_url,
                    :cover_image_json, :next_airing_episode_json, :start_date_json,
                    :raw_json, :fetched_at
                )
                ON CONFLICT(id) DO UPDATE SET
                    season_key = excluded.season_key,
                    season = excluded.season,
                    season_year = excluded.season_year,
                    id_mal = excluded.id_mal,
                    title_json = excluded.title_json,
                    episodes = excluded.episodes,
                    format = excluded.format,
                    status = excluded.status,
                    genres_json = excluded.genres_json,
                    average_score = excluded.average_score,
                    duration = excluded.duration,
                    is_adult = excluded.is_adult,
                    site_url = excluded.site_url,
                    cover_image_json = excluded.cover_image_json,
                    next_airing_episode_json = excluded.next_airing_episode_json,
                    start_date_json = excluded.start_date_json,
                    raw_json = excluded.raw_json,
                    fetched_at = excluded.fetched_at
                """,
                row,
            )
        conn.commit()


def week_number_for_month(day: datetime.date) -> int:
    return ((day.day - 1) // 7) + 1


def db_library_ids() -> set[int]:
    ensure_database()
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute("SELECT id FROM library").fetchall()
    return {int(row[0]) for row in rows}


def populate_weekly_schedule(
    year: int,
    month: int,
    source: str = "sub",
    library_ids: set[int] | None = None,
) -> int:
    ensure_database()
    now_ts = int(time.time())
    raw_records = HUB.sub_schedule() if source == "sub" else HUB.dub_schedule()
    library_ids = db_library_ids() if library_ids is None else {int(value) for value in library_ids}
    records: list[dict] = []
    for item in raw_records:
        if not isinstance(item, dict):
            continue
        nested_media = ((item.get("media") or {}).get("media")) or {}
        anime_id_raw = item.get("id") or nested_media.get("id")
        if anime_id_raw is None:
            continue
        try:
            anime_id = int(anime_id_raw)
        except (TypeError, ValueError):
            continue
        if library_ids and anime_id not in library_ids:
            continue
        records.append(item)

    inserted = 0
    with sqlite3.connect(DB_PATH) as conn:
        for item in records:
            if not isinstance(item, dict):
                continue
            nested_media = ((item.get("media") or {}).get("media")) or {}
            anime_id_raw = item.get("id") or nested_media.get("id")
            if anime_id_raw is None:
                continue
            try:
                anime_id = int(anime_id_raw)
            except (TypeError, ValueError):
                continue
            title_data = item.get("title") if isinstance(item.get("title"), dict) else {
                "english": item.get("english"),
                "romaji": item.get("romaji"),
            }
            title = pick_title(title_data, "english") or pick_title(title_data, "romaji") or "Unknown"
            nodes = ((item.get("airingSchedule") or {}).get("nodes") or [])
            if not nodes and item.get("episodeDate"):
                nodes = [{"episode": item.get("episodeNumber"), "airingAt": item.get("episodeDate")}]
            for node in nodes:
                if not isinstance(node, dict):
                    continue
                when = parse_airing(node.get("airingAt"))
                if when is None:
                    continue
                dt = when.astimezone(timezone.utc)
                ep_num = int(node.get("episode") or 0)
                if dt.date().year != year or dt.date().month != month:
                    continue
                week_num = week_number_for_month(dt.date())
                row = {
                    "year": year,
                    "month": month,
                    "week_num": week_num,
                    "anime_id": anime_id,
                    "anime_title": title,
                    "episode": ep_num,
                    "air_day": dt.strftime("%A"),
                    "air_date": dt.date().isoformat(),
                    "air_ts": int(when.timestamp()),
                    "source": source,
                    "fetched_at": now_ts,
                }
                conn.execute(
                    """
                    INSERT INTO weekly_schedule (
                        year, month, week_num, anime_id, anime_title,
                        episode, air_day, air_date, air_ts, source, fetched_at
                    ) VALUES (
                        :year, :month, :week_num, :anime_id, :anime_title,
                        :episode, :air_day, :air_date, :air_ts, :source, :fetched_at
                    )
                    ON CONFLICT(year, month, week_num, anime_id, episode)
                    DO UPDATE SET
                        anime_title = excluded.anime_title,
                        air_day = excluded.air_day,
                        air_date = excluded.air_date,
                        air_ts = excluded.air_ts,
                        source = excluded.source,
                        fetched_at = excluded.fetched_at
                    """,
                    row,
                )
                inserted += 1
        conn.commit()
    return inserted


def populate_schedule_from_media_history(
    library_ids: set[int],
    date_ranges: Iterable[tuple[date, date]],
) -> int:
    """Add historical AniList airing nodes to the normalized schedule table."""
    if not library_ids:
        return 0
    inserted = 0
    placeholders = ", ".join("?" for _ in library_ids)
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            f"SELECT id, raw_json FROM media WHERE id IN ({placeholders})",
            tuple(sorted(library_ids)),
        ).fetchall()
        for anime_id, raw_json in rows:
            media = json.loads(raw_json)
            title = pick_title(media.get("title"), "english") or pick_title(media.get("title"), "romaji") or "Unknown"
            nodes = ((media.get("airingSchedule") or {}).get("nodes") or [])
            for node in nodes:
                when = parse_airing(node.get("airingAt"))
                episode = int(node.get("episode") or 0)
                if when is None or episode <= 0:
                    continue
                air_ts = int(when.timestamp())
                if not any(start <= when.astimezone(timezone.utc).date() < end for start, end in date_ranges):
                    continue
                air_date = when.astimezone(timezone.utc).date()
                conn.execute(
                    """
                    INSERT INTO weekly_schedule (
                        year, month, week_num, anime_id, anime_title,
                        episode, air_day, air_date, air_ts, source, fetched_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(year, month, week_num, anime_id, episode)
                    DO UPDATE SET
                        anime_title = excluded.anime_title,
                        air_day = excluded.air_day,
                        air_date = excluded.air_date,
                        air_ts = excluded.air_ts,
                        source = excluded.source,
                        fetched_at = excluded.fetched_at
                    """,
                    (
                        air_date.year,
                        air_date.month,
                        week_number_for_month(air_date),
                        int(anime_id),
                        title,
                        episode,
                        when.strftime("%A"),
                        air_date.isoformat(),
                        air_ts,
                        "anilist_history",
                        int(time.time()),
                    ),
                )
                inserted += 1
        conn.commit()
    return inserted


def _month_ranges(start: date) -> list[tuple[date, date]]:
    """Return the current and next calendar month for a local date."""
    current = start.replace(day=1)
    if current.month == 12:
        following = date(current.year + 1, 1, 1)
    else:
        following = date(current.year, current.month + 1, 1)
    if following.month == 12:
        after_following = date(following.year + 1, 1, 1)
    else:
        after_following = date(following.year, following.month + 1, 1)
    return [(current, following), (following, after_following)]


def build_library_schedule(
    library_ids: Iterable[int] | None = None,
    date_ranges: Iterable[tuple[date, date]] | None = None,
    sources: Iterable[str] = ("sub", "dub"),
) -> dict[str, int]:
    """Build media and schedule rows for library IDs over selected date ranges.

    The default window is the current and next local calendar month. Callers can
    provide half-open ``(start, end)`` date ranges to rebuild another window.
    This path intentionally owns the orchestration: media is loaded first, then
    schedule rows are rebuilt from the requested feed data.
    """
    ensure_database()
    ids = {int(value) for value in (library_ids if library_ids is not None else db_library_ids())}
    ranges = list(date_ranges) if date_ranges is not None else _month_ranges(datetime.now().astimezone().date())
    if not ranges:
        return {"media": 0, "schedule": 0}
    for start, end in ranges:
        if start >= end:
            raise ValueError("date ranges must have start before end")
    if not ids:
        return {"media": 0, "schedule": 0}

    media_count = 0
    for media_id in sorted(ids):
        raw = HUB.media_details(media_id)
        media = ((raw or {}).get("data") or {}).get("Media") or {}
        if not media:
            continue
        season = media.get("season") or "UNKNOWN"
        season_year = int(media.get("seasonYear") or datetime.now().year)
        store_media_records([media], season, season_year)
        media_count += 1

    with sqlite3.connect(DB_PATH) as conn:
        placeholders = ", ".join("?" for _ in ids)
        conn.execute(f"DELETE FROM weekly_schedule WHERE anime_id IN ({placeholders})", tuple(sorted(ids)))
        conn.commit()

    schedule_count = 0
    months: set[tuple[int, int]] = set()
    for start, end in ranges:
        month = start.replace(day=1)
        last_month = (end - timedelta(days=1)).replace(day=1)
        while month <= last_month:
            months.add((month.year, month.month))
            if month.month == 12:
                month = date(month.year + 1, 1, 1)
            else:
                month = date(month.year, month.month + 1, 1)
    for year, month in months:
        for source in sources:
            schedule_count += populate_weekly_schedule(year, month, source, library_ids=ids)
    schedule_count += populate_schedule_from_media_history(ids, ranges)

    clauses = []
    values: list[Any] = []
    for start, end in ranges:
        clauses.append("(air_date >= ? AND air_date < ?)")
        values.extend((start.isoformat(), end.isoformat()))
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            f"DELETE FROM weekly_schedule WHERE anime_id IN ({placeholders}) AND NOT ({' OR '.join(clauses)})",
            tuple(sorted(ids)) + tuple(values),
        )
        conn.commit()
        stored = conn.execute(
            f"SELECT COUNT(*) FROM weekly_schedule WHERE anime_id IN ({placeholders}) AND ({' OR '.join(clauses)})",
            tuple(sorted(ids)) + tuple(values),
        ).fetchone()[0]
    return {"media": media_count, "schedule": int(stored)}


def schedule_view_payload(range_key: str, offset: int = 0) -> dict:
    """Read a UI schedule payload from the isolated SQLite schedule service."""
    settings = load_settings()
    week_start = settings.get("weekStart", "sunday")
    if range_key == "today":
        start, end = today_bounds()
        label = start.strftime("%A %-d %b")
    elif range_key in {"this_week", "next_week", "week_after"}:
        start, end, label = schedule_window(range_key, week_start, offset=offset)
    else:
        start, end = today_bounds()
        label = "Today"

    days: dict[str, list] = {}
    current = start
    while current < end:
        key = current.strftime("%Y-%m-%d")
        days[key] = []
        current += timedelta(days=1)

    library = {int(show["id"]): show for show in load_library() if show.get("id") is not None}
    sub_map, dub_map, dub_feed = build_maps()
    enriched_library = {
        show_id: enrich_show(dict(show), sub_map, dub_map, dub_feed)
        for show_id, show in library.items()
    }
    history_weekdays: dict[int, int] = {}
    with sqlite3.connect(DB_PATH) as conn:
        media_rows = conn.execute(
            f"SELECT id, raw_json FROM media WHERE id IN ({', '.join('?' for _ in library)})",
            tuple(sorted(library)),
        ).fetchall() if library else []
    for media_id, raw_json in media_rows:
        nodes = ((json.loads(raw_json).get("airingSchedule") or {}).get("nodes") or [])
        airing_times = [parse_airing(node.get("airingAt")) for node in nodes]
        airing_times = [when for when in airing_times if when is not None]
        if airing_times:
            history_weekdays[int(media_id)] = (max(airing_times).astimezone().weekday() + 1) % 7
    start_ts = int(start.timestamp())
    end_ts = int(end.timestamp())
    ensure_database()
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            """
            SELECT anime_id, episode, air_date, air_ts, source
            FROM weekly_schedule
            WHERE air_ts >= ? AND air_ts < ?
            ORDER BY air_ts, anime_id, episode
            """,
            (start_ts, end_ts),
        ).fetchall()
        progress_rows = conn.execute(
            """
            SELECT anime_id, source, MAX(episode)
            FROM weekly_schedule
            WHERE air_ts < ?
            GROUP BY anime_id, source
            """,
            (end_ts,),
        ).fetchall()

    progress: dict[int, dict[str, int]] = {}
    for anime_id, source, episode in progress_rows:
        progress.setdefault(int(anime_id), {})["dub" if source == "dub" else "sub"] = int(episode or 0)

    def progress_for(show: dict, kind: str) -> int | None:
        value = progress.get(int(show["id"]), {}).get(kind)
        if value is None:
            value = show.get("dubAired" if kind == "dub" else "subAired")
        if kind != "dub":
            return value
        event = next((item for item in show.get("nextEvents", []) if item.get("kind") == "dub"), None)
        when = parse_airing(event.get("at")) if event else None
        episode = int(event.get("episode") or 0) if event else 0
        total = int(show.get("episodes") or 0)
        while when is not None and episode > 0 and episode <= total and when.timestamp() < end_ts:
            value = max(value or 0, episode)
            when += timedelta(days=7)
            episode += 1
        return value

    for anime_id, episode, air_date, air_ts, source in rows:
        show = enriched_library.get(int(anime_id))
        if show is None or air_date not in days:
            continue
        item = dict(show)
        item.update({
            "scheduleSubAired": progress_for(show, "sub"),
            "scheduleDubAired": progress_for(show, "dub"),
        })
        focus = {
            "kind": "sub" if source == "anilist_history" else source,
            "episode": episode,
            "at": datetime.fromtimestamp(air_ts, timezone.utc).isoformat(),
            "ts": air_ts,
        }
        bucket = days[air_date]
        existing = next((entry for entry in bucket if int(entry.get("id")) == int(anime_id)), None)
        if existing is None:
            item["focus"] = focus
            item["focusAll"] = [focus]
            bucket.append(item)
        else:
            existing["focusAll"].append(focus)
            existing["focusAll"].sort(key=lambda event: event["ts"])
            existing["focus"] = existing["focusAll"][0]

    displayed_ids = {
        int(show["id"])
        for day in days.values()
        for show in day
        if show.get("id") is not None
    }
    for show_id, show in enriched_library.items():
        if show_id in displayed_ids:
            continue
        air_dow = show.get("airDow")
        if air_dow is None:
            air_dow = history_weekdays.get(show_id)
        if air_dow is None:
            continue
        for day_key, items in days.items():
            day = datetime.fromisoformat(day_key).date()
            if day.weekday() == (int(air_dow) - 1) % 7:
                display_show = dict(show)
                display_show.update({
                    "scheduleSubAired": progress_for(show, "sub"),
                    "scheduleDubAired": progress_for(show, "dub"),
                })
                items.append(display_show)

    ordered = [
        {
            "date": key,
            "label": datetime.fromisoformat(key).strftime("%a %-d"),
            "shows": items,
        }
        for key, items in sorted(days.items())
    ]
    return {
        "range": range_key,
        "label": label,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "days": ordered,
        "count": sum(len(day["shows"]) for day in ordered),
    }


def db_get_library() -> list[dict]:
    ensure_database()
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            """
            SELECT id, id_mal, title, title_jap, cover, color, episodes, format,
                   status, season, season_year, next_sub_episode, next_sub_at,
                   watched_sub, watched_dub, note, added_at, updated_at
            FROM library
            ORDER BY updated_at DESC
            """
        ).fetchall()
    out: list[dict] = []
    for row in rows:
        out.append(
            {
                "id": row[0],
                "idMal": row[1],
                "title": row[2],
                "titleJap": row[3],
                "cover": row[4],
                "color": row[5],
                "episodes": row[6],
                "format": row[7],
                "status": row[8],
                "season": row[9],
                "seasonYear": row[10],
                "nextSubEpisode": row[11],
                "nextSubAt": row[12],
                "watchedSub": row[13],
                "watchedDub": row[14],
                "note": row[15],
                "addedAt": row[16],
                "updatedAt": row[17],
            }
        )
    return out


def db_add_library_show(payload: dict) -> list[dict]:
    ensure_database()
    now = now_utc().isoformat()
    titles = payload.get("titles") or {}
    row = {
        "id": int(payload["id"]),
        "idMal": payload.get("idMal"),
        "title": payload.get("title") or "",
        "titleJap": (titles.get("romaji") if isinstance(titles, dict) else None) or payload.get("titleJap") or payload.get("title") or "",
        "cover": payload.get("cover"),
        "color": payload.get("color"),
        "episodes": payload.get("episodes"),
        "format": payload.get("format"),
        "status": payload.get("status"),
        "season": payload.get("season"),
        "seasonYear": payload.get("seasonYear"),
        "nextSubEpisode": payload.get("nextSubEpisode"),
        "nextSubAt": payload.get("nextSubAt"),
        "watchedSub": int(payload.get("watchedSub", 0) or 0),
        "watchedDub": int(payload.get("watchedDub", 0) or 0),
        "note": payload.get("note") or "",
        "addedAt": payload.get("addedAt") or now,
        "updatedAt": now,
    }
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            INSERT INTO library (
                id, id_mal, title, title_jap, cover, color, episodes, format,
                status, season, season_year, next_sub_episode, next_sub_at,
                watched_sub, watched_dub, note, added_at, updated_at
            ) VALUES (
                :id, :idMal, :title, :titleJap, :cover, :color, :episodes, :format,
                :status, :season, :seasonYear, :nextSubEpisode, :nextSubAt,
                :watchedSub, :watchedDub, :note, :addedAt, :updatedAt
            )
            ON CONFLICT(id) DO UPDATE SET
                id_mal = excluded.id_mal,
                title = excluded.title,
                title_jap = excluded.title_jap,
                cover = excluded.cover,
                color = excluded.color,
                episodes = excluded.episodes,
                format = excluded.format,
                status = excluded.status,
                season = excluded.season,
                season_year = excluded.season_year,
                next_sub_episode = excluded.next_sub_episode,
                next_sub_at = excluded.next_sub_at,
                watched_sub = excluded.watched_sub,
                watched_dub = excluded.watched_dub,
                note = excluded.note,
                updated_at = excluded.updated_at
            """,
            row,
        )
        conn.commit()
    return db_get_library()


def db_remove_library_show(show_id: int) -> list[dict]:
    ensure_database()
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("DELETE FROM library WHERE id = ?", (int(show_id),))
        conn.commit()
    return db_get_library()


def db_update_library_progress(show_id: int, **kwargs: Any) -> list[dict]:
    ensure_database()
    updates: dict[str, Any] = {"updated_at": now_utc().isoformat()}
    if "watchedSub" in kwargs:
        updates["watched_sub"] = max(0, int(kwargs["watchedSub"]))
    if "watchedDub" in kwargs:
        updates["watched_dub"] = max(0, int(kwargs["watchedDub"]))
    if "note" in kwargs:
        updates["note"] = str(kwargs["note"])
    if not updates or len(updates) == 1:
        return db_get_library()
    assignments = ", ".join(f"{key} = ?" for key in updates)
    values = list(updates.values()) + [int(show_id)]
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(f"UPDATE library SET {assignments} WHERE id = ?", values)
        conn.commit()
    return db_get_library()


def _legacy_cache_get(name: str, ttl: int) -> Any | None:
    path = CACHE_DIR / name
    if not path.exists():
        return None
    age = time.time() - path.stat().st_mtime
    if age > ttl:
        return None
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return None


def cache_get(name: str, ttl: int) -> Any | None:
    ensure_database()
    legacy = _legacy_cache_get(name, ttl)
    if legacy is not None:
        if name.endswith(".json"):
            prefix = name.rsplit("-", 1)[0] if "-" in name else name
        else:
            prefix = name
        # A legacy JSON cache entry may still be used during transition; we keep
        # it as a fallback, but the canonical database is the normalized media table.
        return legacy
    return None


def cache_set(name: str, data: Any) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data)
    ensure_database()
    path = CACHE_DIR / name
    tmp = path.with_suffix(".tmp")
    tmp.write_text(payload)
    tmp.replace(path)


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return default


def save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(path)


def load_library() -> list[dict]:
    data = load_json(LIBRARY_PATH, {"shows": []})
    if isinstance(data, list):
        return data
    return data.get("shows", [])


def save_library(shows: list[dict]) -> None:
    save_json(LIBRARY_PATH, {"shows": shows})


def load_settings() -> dict:
    stored = load_json(SETTINGS_PATH, {})
    out = dict(DEFAULT_SETTINGS)
    out.update(stored if isinstance(stored, dict) else {})
    return out


class DataHub:
    def anilist(self, query: str, variables: dict | None = None) -> dict:
        return http_json(ANILIST, {"query": query, "variables": variables or {}})

    def fetch_season(self, season: str, year: int, page: int = 1) -> dict:
        key = f"season-{season}-{year}-p{page}.json"
        cached = cache_get(key, ttl=6 * 3600)
        if cached is not None:
            media_page = ((cached.get("data") or {}).get("Page") or {}).get("media") or []
            store_media_records(media_page, season, year)
            return cached
        query = """
        query ($page: Int, $season: MediaSeason, $seasonYear: Int) {
          Page(page: $page, perPage: 50) {
            pageInfo { currentPage hasNextPage lastPage total }
            media(season: $season, seasonYear: $seasonYear, type: ANIME, sort: POPULARITY_DESC) {
              id idMal title { romaji english native }
              episodes format status season seasonYear genres averageScore duration isAdult siteUrl
              coverImage { large medium color }
              nextAiringEpisode { episode airingAt timeUntilAiring }
              startDate { year month day }
            }
          }
        }
        """
        raw = self.anilist(query, {"page": page, "season": season, "seasonYear": year})
        cache_set(key, raw)
        media_page = ((raw.get("data") or {}).get("Page") or {}).get("media") or []
        store_media_records(media_page, season, year)
        return raw

    def search(self, q: str) -> dict:
        query = """
        query ($q: String) {
          Page(page: 1, perPage: 20) {
            media(search: $q, type: ANIME, sort: SEARCH_MATCH) {
              id idMal title { romaji english native }
              episodes format status season seasonYear genres averageScore isAdult siteUrl
              coverImage { large medium color }
              nextAiringEpisode { episode airingAt timeUntilAiring }
            }
          }
        }
        """
        return self.anilist(query, {"q": q})

    def media_details(self, media_id: int) -> dict:
        key = f"media-{media_id}.json"
        cached = cache_get(key, ttl=30 * 60)
        if cached is not None:
            return cached
        query = """
        query ($id: Int) {
          Media(id: $id, type: ANIME) {
            id idMal title { romaji english native }
            episodes format status season seasonYear genres averageScore duration isAdult siteUrl
            description(asHtml: false)
            coverImage { large medium color }
            bannerImage
            nextAiringEpisode { episode airingAt timeUntilAiring }
            airingSchedule(notYetAired: false, perPage: 25) { nodes { episode airingAt } }
          }
        }
        """
        raw = self.anilist(query, {"id": media_id})
        cache_set(key, raw)
        return raw

    def sub_schedule(self) -> list[dict]:
        cached = cache_get("sub-schedule.json", ttl=20 * 60)
        if cached is not None:
            return cached
        data = http_json(f"{ANISCHEDULE_RAW}/sub-schedule-readable.json")
        cache_set("sub-schedule.json", data)
        return data

    def dub_schedule(self) -> list[dict]:
        cached = cache_get("dub-schedule.json", ttl=20 * 60)
        if cached is not None:
            return cached
        data = http_json(f"{ANISCHEDULE_RAW}/dub-schedule-readable.json")
        cache_set("dub-schedule.json", data)
        return data

    def dub_feed_index(self) -> dict[int, dict]:
        cached = cache_get("dub-feed-index.json", ttl=20 * 60)
        if cached is not None:
            return {int(k): v for k, v in cached.items()}
        raw = http_json(f"{ANISCHEDULE_RAW}/dub-episode-feed-readable.json")
        index: dict[int, dict] = {}
        if isinstance(raw, list):
            for item in raw:
                mid = item.get("id")
                if mid is None:
                    continue
                prev = index.get(int(mid))
                aired = ((item.get("episode") or {}).get("aired")) or 0
                if prev is None or aired >= ((prev.get("episode") or {}).get("aired") or 0):
                    index[int(mid)] = item
        cache_set("dub-feed-index.json", {str(k): v for k, v in index.items()})
        return index


HUB = DataHub()


def pick_title(title: dict | None, lang: str) -> str:
    title = title or {}
    if lang == "romaji":
        return title.get("romaji") or title.get("english") or title.get("native") or "Untitled"
    return title.get("english") or title.get("romaji") or title.get("native") or "Untitled"


def compact_media(media: dict, lang: str) -> dict:
    nxt = media.get("nextAiringEpisode") or {}
    cover = media.get("coverImage") or {}
    return {
        "id": media.get("id"),
        "idMal": media.get("idMal"),
        "title": pick_title(media.get("title"), lang),
        "titles": media.get("title") or {},
        "episodes": media.get("episodes"),
        "format": media.get("format"),
        "status": media.get("status"),
        "season": media.get("season"),
        "seasonYear": media.get("seasonYear"),
        "genres": media.get("genres") or [],
        "score": media.get("averageScore"),
        "duration": media.get("duration"),
        "isAdult": media.get("isAdult"),
        "siteUrl": media.get("siteUrl"),
        "cover": cover.get("large") or cover.get("medium"),
        "color": cover.get("color"),
        "nextSubEpisode": nxt.get("episode"),
        "nextSubAt": nxt.get("airingAt"),
    }


def enrich_show(show: dict, sub_map: dict[int, dict], dub_map: dict[int, dict], dub_feed: dict[int, dict]) -> dict:
    sid = int(show["id"])
    sub = sub_map.get(sid) or {}
    dub = dub_map.get(sid)
    feed = dub_feed.get(sid) or {}
    total = show.get("episodes")
    next_sub_ep = show.get("nextSubEpisode")
    next_sub_at = parse_airing(show.get("nextSubAt"))
    sub_nodes = ((sub.get("airingSchedule") or {}).get("nodes")) or []
    upcoming_sub = []
    latest_sub_aired = None
    for node in sub_nodes:
        when = parse_airing(node.get("airingAt"))
        ep = node.get("episode")
        if when is None or ep is None:
            continue
        upcoming_sub.append({"episode": ep, "at": when.isoformat(), "ts": int(when.timestamp())})
        if when <= now_utc():
            latest_sub_aired = ep if latest_sub_aired is None else max(latest_sub_aired, ep)
    if next_sub_ep and latest_sub_aired is None:
        latest_sub_aired = max(0, int(next_sub_ep) - 1)
    if show.get("nextSubAt") and show.get("nextSubEpisode"):
        when = parse_airing(show.get("nextSubAt"))
        if when:
            upcoming_sub = [{"episode": show["nextSubEpisode"], "at": when.isoformat(), "ts": int(when.timestamp())}] + [
                n for n in upcoming_sub if n.get("episode") != show["nextSubEpisode"]
            ]
    sub_aired = latest_sub_aired
    if sub_aired is None and next_sub_ep:
        sub_aired = max(0, int(next_sub_ep) - 1)
    if sub_aired is None and total and show.get("status") == "FINISHED":
        sub_aired = total
    dub_ep_num = None
    dub_at = None
    dub_delayed = False
    if dub:
        dub_ep_num = dub.get("episodeNumber")
        dub_at = parse_airing(dub.get("episodeDate"))
        dub_delayed = bool(dub.get("delayedIndefinitely") or dub.get("delayedText"))
        inner = ((dub.get("media") or {}).get("media")) or {}
        if not show.get("cover"):
            cover = inner.get("coverImage") or {}
            show["cover"] = cover.get("extraLarge") or cover.get("medium")
            show["color"] = show.get("color") or cover.get("color")
    feed_aired = ((feed.get("episode") or {}).get("aired"))
    dub_aired = feed_aired
    if dub_aired is None and dub_ep_num is not None:
        if dub_at and dub_at > now_utc():
            dub_aired = max(0, int(dub_ep_num) - 1)
        else:
            dub_aired = int(dub_ep_num)
    remaining_sub = None
    remaining_dub = None
    if total is not None and sub_aired is not None:
        remaining_sub = max(0, int(total) - int(sub_aired))
    if total is not None and dub_aired is not None:
        remaining_dub = max(0, int(total) - int(dub_aired))
    lag = None
    if sub_aired is not None and dub_aired is not None:
        lag = max(0, int(sub_aired) - int(dub_aired))
    next_events = []
    if next_sub_at:
        when = next_sub_at if isinstance(next_sub_at, datetime) else parse_airing(next_sub_at)
        if when:
            next_events.append({"kind": "sub", "episode": next_sub_ep, "at": when.isoformat(), "ts": int(when.timestamp())})
    if not any(e["kind"] == "sub" for e in next_events):
        future_sub = [n for n in upcoming_sub if n.get("ts") and n["ts"] >= time.time() - 3600]
        if future_sub:
            nxt = min(future_sub, key=lambda n: n["ts"])
            next_events.append({"kind": "sub", "episode": nxt["episode"], "at": nxt["at"], "ts": nxt["ts"]})
    if dub_at and dub_ep_num and not (dub.get("delayedIndefinitely") if dub else False):
        next_events.append({"kind": "dub", "episode": dub_ep_num, "at": dub_at.isoformat(), "ts": int(dub_at.timestamp())})
    tagged_day = None
    candidate_events = []
    for ev in next_events + [{"at": n["at"], "ts": n["ts"]} for n in upcoming_sub]:
        when = parse_airing(ev.get("at"))
        if when is not None:
            candidate_events.append(when.astimezone(timezone.utc))
    if candidate_events:
        tagged_day = min(candidate_events).date().isoformat()

    out = dict(show)
    out.update({
        "subAired": sub_aired,
        "dubAired": dub_aired,
        "remainingSub": remaining_sub,
        "remainingDub": remaining_dub,
        "dubLag": lag,
        "dubDelayed": dub_delayed,
        "nextEvents": sorted(next_events, key=lambda e: e["ts"]),
        "upcomingSub": upcoming_sub[:8],
        "hasDubSchedule": dub is not None,
        "airDay": tagged_day,
    })
    return out


def build_maps() -> tuple[dict[int, dict], dict[int, dict], dict[int, dict]]:
    sub_map: dict[int, dict] = {}
    try:
        for item in HUB.sub_schedule():
            if item.get("id") is not None:
                sub_map[int(item["id"])] = item
    except (URLError, HTTPError, TimeoutError, json.JSONDecodeError):
        pass
    dub_map: dict[int, dict] = {}
    try:
        for item in HUB.dub_schedule():
            inner = ((item.get("media") or {}).get("media")) or {}
            mid = inner.get("id")
            if mid is not None:
                dub_map[int(mid)] = item
    except (URLError, HTTPError, TimeoutError, json.JSONDecodeError):
        pass
    try:
        dub_feed = HUB.dub_feed_index()
    except (URLError, HTTPError, TimeoutError, json.JSONDecodeError):
        dub_feed = {}
    return sub_map, dub_map, dub_feed


def event_in_range(events: list[dict], start: datetime, end: datetime) -> list[dict]:
    hits = []
    for ev in events:
        when = parse_airing(ev.get("at"))
        if when is None:
            continue
        local = when.astimezone()
        if start <= local < end:
            hits.append(ev)
    return hits
