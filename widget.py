#!/usr/bin/env python3
"""Seasonal Tracker — local desktop widget server for Nobara/Linux."""

from __future__ import annotations

import json
import os
import sys
import threading
import webbrowser
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlparse

from tracker_lib import (
    CACHE_DIR,
    DATA_DIR,
    DEFAULT_SETTINGS,
    LIBRARY_PATH,
    STATIC,
    build_library_schedule,
    build_maps,
    compact_media,
    db_show_details,
    db_add_library_show,
    db_remove_library_show,
    enrich_show,
    HUB,
    load_library,
    load_settings,
    next_season,
    now_utc,
    parse_airing,
    pick_title,
    save_json,
    save_library,
    schedule_view_payload,
    season_of,
    sync_library_schedule,
    SETTINGS_PATH,
)

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[tracker] " + (fmt % args) + "\n")

    def _send(self, code: int, payload: Any) -> None:
        raw = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode() or "{}")

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        q = parse_qs(parsed.query)
        try:
            if path == "/api/meta":
                season, year = season_of()
                nseason, nyear = next_season(season, year)
                self._send(
                    200,
                    {
                        "now": now_utc().isoformat(),
                        "localNow": datetime.now().astimezone().isoformat(),
                        "season": season,
                        "year": year,
                        "nextSeason": nseason,
                        "nextYear": nyear,
                        "settings": load_settings(),
                    },
                )
                return
            if path == "/api/settings":
                self._send(200, load_settings())
                return
            if path == "/api/library":
                self._send(200, self._library_payload())
                return
            if path == "/api/season":
                season = (q.get("season") or [season_of()[0]])[0].upper()
                year = int((q.get("year") or [season_of()[1]])[0])
                page = int((q.get("page") or ["1"])[0])
                raw = HUB.fetch_season(season, year, page)
                page_data = ((raw.get("data") or {}).get("Page")) or {}
                lang = load_settings().get("titleLanguage", "english")
                media = [compact_media(m, lang) for m in page_data.get("media") or []]
                selected = {int(s["id"]) for s in load_library()}
                for m in media:
                    m["inLibrary"] = m["id"] in selected
                self._send(200, {"pageInfo": page_data.get("pageInfo"), "media": media, "season": season, "year": year})
                return
            if path == "/api/search":
                term = (q.get("q") or [""])[0].strip()
                if len(term) < 2:
                    self._send(200, {"media": []})
                    return
                season = (q.get("season") or [None])[0]
                year = int((q.get("year") or ["0"])[0]) or None
                raw = HUB.search(term, season=season, year=year)
                page = ((raw.get("data") or {}).get("Page") or {})
                if not page.get("media") and (season or year):
                    raw = HUB.search(term)
                lang = load_settings().get("titleLanguage", "english")
                media = [compact_media(m, lang) for m in (((raw.get("data") or {}).get("Page") or {}).get("media") or [])]
                selected = {int(s["id"]) for s in load_library()}
                for m in media:
                    m["inLibrary"] = m["id"] in selected
                self._send(200, {"media": media})
                return
            if path == "/api/schedule":
                offset = int((q.get("offset") or ["0"])[0] or 0)
                self._send(200, schedule_view_payload((q.get("range") or ["today"])[0], offset=offset))
                return
            if path.startswith("/api/show/"):
                mid = int(path.rsplit("/", 1)[-1])
                lang = load_settings().get("titleLanguage", "english")
                show = db_show_details(mid, lang)
                if not show or not show.get("description"):
                    raw = HUB.media_details(mid)
                    media = ((raw.get("data") or {}).get("Media")) or {}
                    refreshed = compact_media(media, lang)
                    if show.get("episodesSchedule"):
                        refreshed["episodesSchedule"] = show["episodesSchedule"]
                    show = refreshed
                sub_map, dub_map, dub_feed = build_maps()
                lib = {int(s["id"]): s for s in load_library()}
                if mid in lib:
                    show.update({k: lib[mid][k] for k in ("watchedSub", "watchedDub", "note") if k in lib[mid]})
                self._send(200, enrich_show(show, sub_map, dub_map, dub_feed))
                return
        except HTTPError as exc:
            self._send(502, {"error": f"upstream {exc.code}", "detail": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001
            self._send(500, {"error": str(exc)})
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        try:
            body = self._read_json()
            if parsed.path == "/api/sync":
                self._send(200, sync_library_schedule())
                return
            if parsed.path == "/api/settings":
                settings = load_settings()
                settings.update({k: v for k, v in body.items() if k in DEFAULT_SETTINGS or k in {"layout", "theme"}})
                save_json(SETTINGS_PATH, settings)
                self._send(200, settings)
                return
            if parsed.path == "/api/library/add":
                shows = load_library()
                sid = int(body["id"])
                if not any(int(s["id"]) == sid for s in shows):
                    shows.append(
                        {
                            "id": sid,
                            "idMal": body.get("idMal"),
                            "title": body.get("title"),
                            "titles": body.get("titles") or {},
                            "cover": body.get("cover"),
                            "color": body.get("color"),
                            "episodes": body.get("episodes"),
                            "format": body.get("format"),
                            "status": body.get("status"),
                            "season": body.get("season"),
                            "seasonYear": body.get("seasonYear"),
                            "nextSubEpisode": body.get("nextSubEpisode"),
                            "nextSubAt": body.get("nextSubAt"),
                            "watchedSub": body.get("watchedSub", 0),
                            "watchedDub": body.get("watchedDub", 0),
                            "note": "",
                            "addedAt": now_utc().isoformat(),
                        }
                    )
                    save_library(shows)
                    db_add_library_show(shows[-1])
                    build_library_schedule()
                self._send(200, self._library_payload())
                return
            if parsed.path == "/api/library/remove":
                sid = int(body["id"])
                save_library([s for s in load_library() if int(s["id"]) != sid])
                db_remove_library_show(sid)
                build_library_schedule()
                self._send(200, self._library_payload())
                return
            if parsed.path == "/api/library/progress":
                sid = int(body["id"])
                shows = load_library()
                for show in shows:
                    if int(show["id"]) == sid:
                        if "watchedSub" in body:
                            show["watchedSub"] = max(0, int(body["watchedSub"]))
                        if "watchedDub" in body:
                            show["watchedDub"] = max(0, int(body["watchedDub"]))
                        if "note" in body:
                            show["note"] = str(body["note"])
                save_library(shows)
                self._send(200, self._library_payload())
                return
        except Exception as exc:  # noqa: BLE001
            self._send(500, {"error": str(exc)})
            return
        self._send(404, {"error": "not found"})

    def _library_payload(self) -> dict:
        lang = load_settings().get("titleLanguage", "english")
        shows = load_library()
        sub_map, dub_map, dub_feed = build_maps()
        enriched = []
        for show in shows:
            item = dict(show)
            if not item.get("title") and item.get("titles"):
                item["title"] = pick_title(item.get("titles"), lang)
            enriched.append(enrich_show(item, sub_map, dub_map, dub_feed))
        enriched.sort(key=lambda s: (s.get("nextEvents") or [{"ts": 10**12}])[0]["ts"])
        return {"shows": enriched}

def open_window(url: str, width: int, height: int) -> None:
    """Dev fallback: open a Chrome --app window when launched from a terminal.

    The Plasma plasmoid does not use this path. It loads the same URL inside
    plasmashell via Qt WebEngine. Prefer ./install-desktop.sh on Nobara KDE.
    """
    candidates = [
        ["google-chrome-stable", f"--app={url}", f"--window-size={width},{height}", "--class=SeasonalTracker"],
        ["google-chrome", f"--app={url}", f"--window-size={width},{height}", "--class=SeasonalTracker"],
        ["chromium-browser", f"--app={url}", f"--window-size={width},{height}", "--class=SeasonalTracker"],
        ["chromium", f"--app={url}", f"--window-size={width},{height}", "--class=SeasonalTracker"],
        ["brave-browser", f"--app={url}", f"--window-size={width},{height}"],
        ["flatpak", "run", "com.google.Chrome", f"--app={url}", f"--window-size={width},{height}"],
        ["firefox", "--new-window", url],
    ]
    for cmd in candidates:
        bin_name = cmd[0]
        if bin_name != "flatpak":
            from shutil import which

            if not which(bin_name):
                continue
        try:
            import subprocess

            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
        except OSError:
            continue
    webbrowser.open(url)


def main() -> None:
    # --no-browser is what the systemd user unit passes so plasmashell (or
    # launch-window.sh) can attach to an already-running local server.
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    STATIC.mkdir(parents=True, exist_ok=True)
    try:
        build_library_schedule()
    except Exception as exc:  # noqa: BLE001
        print(f"Schedule refresh skipped: {exc}", file=sys.stderr)

    port = int(os.environ.get("SEASONAL_TRACKER_PORT", "8765"))
    host = os.environ.get("SEASONAL_TRACKER_HOST", "127.0.0.1")
    no_browser = "--no-browser" in sys.argv
    if "--port" in sys.argv:
        port = int(sys.argv[sys.argv.index("--port") + 1])

    httpd = ThreadingHTTPServer((host, port), Handler)
    url = f"http://{host}:{port}/"
    print(f"Seasonal Tracker  →  {url}")
    print(f"Library file      →  {LIBRARY_PATH}")
    if not no_browser:
        threading.Timer(0.4, lambda: open_window(url, 1180, 760)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
