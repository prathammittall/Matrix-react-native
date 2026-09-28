#!/usr/bin/env python3
"""
Prepare an offline road graph for map-matching from OpenStreetMap.

Map-matching needs a road network on the device. This script downloads the
drivable `highway` ways inside a bounding box from the Overpass API and writes a
compact JSON graph that `src/services/road-graph.ts` loads directly:

    { "ways": [ { "id": <int>, "nodes": [[lat, lon], ...] }, ... ] }

The result is bundled under `assets/maps/` and shipped in the app, so no network
is needed at run time. Prepare one graph per operating region ahead of the drive.

Usage
-----
    # bounding box: south west north east  (decimal degrees)
    python scripts/fetch-osm-graph.py --bbox 52.376 -1.599 52.463 -1.490 \
        --out assets/maps/coventry_road_graph.json

    # or a centre point plus a radius in kilometres
    python scripts/fetch-osm-graph.py --center 52.4068 -1.5197 --radius-km 3 \
        --out assets/maps/coventry_road_graph.json

Notes
-----
* Overpass is a shared free service; keep bounding boxes to a town or a few km.
  A ~1 x 1 km urban box is ~50 KB. Larger regions are fine but grow the bundle.
* Only drivable road classes are kept (motorway..residential, service, plus the
  *_link ramps), so footpaths and cycleways do not pull the vehicle off-road.
"""
import argparse
import json
import math
import sys
import urllib.parse
import urllib.request

OVERPASS = "https://overpass-api.de/api/interpreter"

DRIVABLE = {
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "unclassified", "residential", "living_street", "service", "road",
    "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
}


def bbox_from_center(lat, lon, radius_km):
    dlat = radius_km / 111.32
    dlon = radius_km / (111.32 * math.cos(math.radians(lat)))
    return (lat - dlat, lon - dlon, lat + dlat, lon + dlon)


def fetch(bbox):
    south, west, north, east = bbox
    query = (
        "[out:json][timeout:90];"
        f'(way["highway"]({south},{west},{north},{east}););'
        "out geom;"
    )
    url = OVERPASS + "?" + urllib.parse.urlencode({"data": query})
    req = urllib.request.Request(url, headers={"User-Agent": "matrix-dr/1.0 (map-matching prep)"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.load(resp)


def to_graph(overpass):
    ways = []
    for el in overpass.get("elements", []):
        if el.get("type") != "way":
            continue
        if (el.get("tags") or {}).get("highway") not in DRIVABLE:
            continue
        geom = el.get("geometry")
        if not geom:
            continue
        nodes = [[round(g["lat"], 6), round(g["lon"], 6)] for g in geom]
        if len(nodes) >= 2:
            ways.append({"id": el["id"], "nodes": nodes})
    return {"ways": ways}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--bbox", nargs=4, type=float, metavar=("S", "W", "N", "E"),
                   help="bounding box: south west north east")
    g.add_argument("--center", nargs=2, type=float, metavar=("LAT", "LON"),
                   help="centre point; use with --radius-km")
    ap.add_argument("--radius-km", type=float, default=3.0, help="radius for --center (default 3)")
    ap.add_argument("--out", required=True, help="output JSON path")
    args = ap.parse_args()

    bbox = tuple(args.bbox) if args.bbox else bbox_from_center(args.center[0], args.center[1], args.radius_km)
    print(f"Fetching drivable roads for bbox S,W,N,E = {bbox} ...", file=sys.stderr)
    graph = to_graph(fetch(bbox))
    n_nodes = sum(len(w["nodes"]) for w in graph["ways"])
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(graph, fh, separators=(",", ":"))
    print(f"Wrote {args.out}: {len(graph['ways'])} ways, {n_nodes} nodes.", file=sys.stderr)
    if not graph["ways"]:
        print("WARNING: no roads returned — check the bounding box.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
