/**
 * MapLibre style definitions.
 *
 * No Google Maps, no API key, no billing. Basemap tiles come from
 * OpenStreetMap-compatible raster endpoints.
 *
 * OFFLINE BEHAVIOUR — read this before judging a blank map:
 *   The AI navigation pipeline (sensors -> ONNX -> frozen fusion -> dead
 *   reckoning -> lat/lon) is fully on-device and never touches the network.
 *   Basemap *tiles*, however, are fetched over HTTP and cached by MapLibre.
 *   With no network and no warm cache, the basemap renders as the flat
 *   background colour defined below, and every navigation overlay — GNSS track,
 *   AI dead-reckoning track, reference track, vehicle puck, accuracy circle,
 *   outage markers — still draws correctly on top of it, because those are
 *   GeoJSON layers held in memory.
 *
 *   That is a deliberate trade: a genuinely offline worldwide basemap means
 *   bundling or downloading an MBTiles/PMTiles dataset, which is far too large
 *   to ship in an APK. MapLibre's `OfflineManager` can pre-download a bounded
 *   region if a specific demo area is ever needed; that is not wired up here.
 */
import type { StyleSpecification } from '@maplibre/maplibre-react-native';

/** The two basemaps offered. Both are free and need no key. */
export type BasemapId = 'standard' | 'terrain';

interface BasemapSource {
  tiles: string[];
  attribution: string;
  maxzoom: number;
}

const SOURCES: Record<BasemapId, BasemapSource> = {
  standard: {
    tiles: [
      'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
      'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
      'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
    ],
    attribution: '© OpenStreetMap contributors',
    maxzoom: 19,
  },
  terrain: {
    tiles: [
      'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
      'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
    ],
    attribution: '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)',
    maxzoom: 17,
  },
};

/**
 * Build a style.
 *
 * The background layer is painted first and always renders, so the map never
 * goes white-and-empty when tiles are unavailable — the trajectories stay
 * readable against the app's own ground colour.
 *
 * In dark mode the raster layer is desaturated and darkened with the raster
 * paint properties, which reproduces the intent of the previous Google dark
 * style (roads and labels recede so the three trajectories are the brightest
 * thing on screen) without needing a vector style server.
 */
export function buildMapStyle(
  basemap: BasemapId,
  dark: boolean,
  backgroundColor: string,
): StyleSpecification {
  const source = SOURCES[basemap];
  return {
    version: 8,
    // MapLibre requires a glyphs endpoint only for symbol layers; this style
    // has none, so it is omitted and nothing is fetched for text.
    sources: {
      basemap: {
        type: 'raster',
        tiles: source.tiles,
        tileSize: 256,
        maxzoom: source.maxzoom,
        attribution: source.attribution,
      },
    },
    layers: [
      {
        id: 'ground',
        type: 'background',
        paint: { 'background-color': backgroundColor },
      },
      {
        id: 'basemap',
        type: 'raster',
        source: 'basemap',
        // Fully desaturated in both schemes. The basemap is context, not
        // content: the only saturated pixels on screen should be the two
        // trajectories and the vehicle, so the GNSS -> AI handover reads
        // instantly. A full-colour OSM raster competes with them.
        paint: dark
          ? {
              'raster-brightness-max': 0.55,
              'raster-saturation': -1,
              'raster-contrast': 0.15,
              'raster-opacity': 0.8,
            }
          : {
              'raster-saturation': -1,
              'raster-brightness-min': 0.18,
              'raster-contrast': -0.05,
              'raster-opacity': 0.9,
            },
      },
    ],
  };
}

export const BASEMAP_ATTRIBUTION = (basemap: BasemapId) => SOURCES[basemap].attribution;
