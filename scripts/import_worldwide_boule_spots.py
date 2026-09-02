"""Import strictly tagged OpenStreetMap boule pitches outside Europe."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

import requests
from shapely.geometry import Point, box, shape
from shapely.ops import unary_union
from shapely.prepared import prep

OVERPASS_URLS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
)
SPORTS = ("boules", "petanque", "boule")
IMPORTER_VERSION = 3
NATURAL_EARTH_URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/"
    "geojson/ne_110m_admin_0_countries.geojson"
)
PRIORITY_REGIONS = (
    (20, -130, 55, -55),  # North America
    (-60, -85, 15, -30),  # South America
    (-35, 10, 38, 55),    # Africa
    (5, 45, 55, 150),     # Asia
    (-48, 110, -10, 180), # Australia and New Zealand
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-path", type=Path, required=True)
    parser.add_argument("--max-tiles", type=int, default=25)
    parser.add_argument("--tile-size", type=int, default=2)
    parser.add_argument("--delay-seconds", type=int, default=12)
    parser.add_argument("--supabase-url", required=True)
    parser.add_argument("--supabase-key", required=True)
    return parser.parse_args()


def intersects(tile: tuple[int, int, int, int], bounds: tuple[int, int, int, int]) -> bool:
    south, west, north, east = tile
    min_lat, min_lon, max_lat, max_lon = bounds
    return south < max_lat and north > min_lat and west < max_lon and east > min_lon


def load_land_masks(session: requests.Session) -> tuple[Any, Any]:
    response = session.get(NATURAL_EARTH_URL, timeout=60)
    response.raise_for_status()
    features = response.json()["features"]
    non_europe = []
    europe = []
    for feature in features:
        geometry = shape(feature["geometry"])
        continent = feature["properties"].get("CONTINENT")
        if continent == "Antarctica":
            continue
        if continent == "Europe":
            europe.append(geometry)
        else:
            non_europe.append(geometry)
    return prep(unary_union(non_europe)), prep(unary_union(europe))


def build_tiles(tile_size: int, non_europe_land: Any) -> list[tuple[int, int, int, int]]:
    tiles: list[tuple[int, int, int, int]] = []
    for south in range(-90, 90, tile_size):
        for west in range(-180, 180, tile_size):
            tile = (south, west, min(south + tile_size, 90), min(west + tile_size, 180))
            if non_europe_land.intersects(box(tile[1], tile[0], tile[3], tile[2])):
                tiles.append(tile)

    priority_tiles = []
    priority_keys = set()
    for region in PRIORITY_REGIONS:
        for tile in tiles:
            if intersects(tile, region) and tile not in priority_keys:
                priority_tiles.append(tile)
                priority_keys.add(tile)
    return priority_tiles + [tile for tile in tiles if tile not in priority_keys]


def build_query(tile: tuple[int, int, int, int]) -> str:
    south, west, north, east = tile
    clauses = [
        f'{element_type}["leisure"="pitch"]["sport"~"^(boules|petanque|boule)$"]({south},{west},{north},{east});'
        for element_type in ("node", "way", "relation")
    ]
    return f"[out:json][timeout:120];({''.join(clauses)});out center tags;"


def fetch_elements(tile: tuple[int, int, int, int]) -> list[dict[str, Any]]:
    query = build_query(tile)
    for attempt in range(1, 4):
        errors = []
        for url in OVERPASS_URLS:
            try:
                session = requests.Session()
                session.headers["User-Agent"] = "BouleSpot-OSM-Importer/2.0 (https://loutk.github.io/BouleSpot/)"
                response = session.get(url, params={"data": query}, timeout=180)
                response.raise_for_status()
                payload = response.json()
                timestamp = payload.get("osm3s", {}).get("timestamp_osm_base", "")
                if not isinstance(timestamp, str) or len(timestamp) < 20 or "T" not in timestamp:
                    raise ValueError("Overpass returned no valid data timestamp.")
                return payload.get("elements", [])
            except (requests.RequestException, ValueError, json.JSONDecodeError) as error:
                errors.append(f"{url}: {error}")
        if attempt == 3:
            raise RuntimeError(f"Overpass request failed for {tile}: {'; '.join(errors)}")
        time.sleep(attempt * 30)
    raise AssertionError("Unreachable")


def normalize_rows(elements: list[dict[str, Any]], europe_land: Any) -> list[dict[str, Any]]:
    rows_by_id = {}
    for element in elements:
        tags = element.get("tags", {})
        if tags.get("leisure") != "pitch" or tags.get("sport") not in SPORTS:
            continue

        element_type = element.get("type")
        if element_type == "node":
            lat, lon = element.get("lat"), element.get("lon")
        else:
            center = element.get("center", {})
            lat, lon = center.get("lat"), center.get("lon")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        if europe_land.contains(Point(lon, lat)):
            continue

        location_id = f"osm-{element_type}-{element['id']}"
        rows_by_id[location_id] = {
            "id": location_id,
            "name": tags.get("name", "Jeu de boules baan"),
            "lat": lat,
            "lon": lon,
            "source": "OpenStreetMap",
        }
    return list(rows_by_id.values())


def insert_rows(session: requests.Session, url: str, key: str, rows: list[dict[str, Any]]) -> None:
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=ignore-duplicates",
    }
    endpoint = f"{url.rstrip('/')}/rest/v1/user_locations?on_conflict=id"
    for offset in range(0, len(rows), 100):
        response = session.post(endpoint, headers=headers, json=rows[offset : offset + 100], timeout=60)
        response.raise_for_status()


def load_state(path: Path, tile_size: int) -> dict[str, Any]:
    if not path.exists():
        return {
            "importer_version": IMPORTER_VERSION,
            "tile_size": tile_size,
            "next_tile": 0,
            "completed_tiles": 0,
            "candidates": 0,
            "failed_tiles": [],
        }
    state = json.loads(path.read_text(encoding="utf-8"))
    if state.get("importer_version") != IMPORTER_VERSION or state.get("tile_size") != tile_size:
        raise ValueError("State belongs to a different importer version or tile size.")
    state.setdefault("failed_tiles", [])
    return state


def main() -> None:
    args = parse_args()
    if args.max_tiles < 1:
        raise ValueError("--max-tiles must be at least 1.")

    session = requests.Session()
    session.headers["User-Agent"] = "BouleSpot-OSM-Importer/1.0 (https://loutk.github.io/BouleSpot/)"
    non_europe_land, europe_land = load_land_masks(session)
    state = load_state(args.state_path, args.tile_size)
    tiles = build_tiles(args.tile_size, non_europe_land)
    processed = 0

    while state["next_tile"] < len(tiles) and processed < args.max_tiles:
        tile = tiles[state["next_tile"]]
        tile_number = state["next_tile"] + 1
        print(f"Tile {tile_number}/{len(tiles)}: {tile}", flush=True)
        try:
            rows = normalize_rows(fetch_elements(tile), europe_land)
            insert_rows(session, args.supabase_url, args.supabase_key, rows)
            print(f"  Imported {len(rows)} strict candidates.", flush=True)
            state["completed_tiles"] += 1
            state["candidates"] += len(rows)
        except RuntimeError as error:
            print(f"  Deferred after retries: {error}", flush=True)
            state["failed_tiles"].append({"tile_number": tile_number, "bounds": tile})

        state["next_tile"] += 1
        args.state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        processed += 1
        if processed < args.max_tiles and state["next_tile"] < len(tiles):
            time.sleep(args.delay_seconds)

    print(
        f"Finished {processed} tiles; total successful: {state['completed_tiles']}/{len(tiles)}; "
        f"deferred: {len(state['failed_tiles'])}.",
        flush=True,
    )


if __name__ == "__main__":
    main()
