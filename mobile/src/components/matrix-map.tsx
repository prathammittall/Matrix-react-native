import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
  Marker,
  type CameraRef,
  type LngLatBounds,
} from '@maplibre/maplibre-react-native';
import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Radius, Spacing, useColors, useIsDark } from '@/theme';
import { decimate, regionFor, type Region } from '@/services/track';
import type { LatLng } from '@/types';
import { Txt } from './ui/primitives';
import { buildMapStyle, type BasemapId } from './map-style';

export interface MapTrack {
  id: string;
  points: LatLng[];
  /** resolved colour, so callers control the legend and the line together */
  color: string;
  width?: number;
  dashed?: boolean;
  opacity?: number;
}

export interface MapMarkerSpec {
  id: string;
  coordinate: LatLng;
  title: string;
  description?: string;
  color: string;
  /** hollow ring instead of a filled pin */
  hollow?: boolean;
}

export interface MatrixMapHandle {
  fitTo: (points: LatLng[], padding?: number) => void;
  center: (p: LatLng, zoomDelta?: number) => void;
}

export interface MatrixMapProps {
  tracks?: MapTrack[];
  markers?: MapMarkerSpec[];
  /** live vehicle position; drawn as a heading-aware puck */
  vehicle?: {
    coordinate: LatLng;
    headingDeg: number | null;
    tone: string;
    /** the position is the last one known, not a current one — drawn hollow
     *  so a held position can never be mistaken for a live fix */
    stale?: boolean;
  } | null;
  /** shaded disc showing GNSS horizontal accuracy */
  accuracyM?: number | null;
  initialRegion?: Region | null;
  mapType?: BasemapId;
  followVehicle?: boolean;
  style?: StyleProp<ViewStyle>;
  onPanDrag?: () => void;
  accessibilityLabel?: string;
}

/** Region half-width to a MapLibre zoom level (Web Mercator, 360° at z=0). */
function zoomForDelta(latitudeDelta: number): number {
  const d = Math.max(latitudeDelta, 1e-6);
  return Math.max(1, Math.min(18, Math.log2(360 / d) - 0.2));
}

function toLngLat(p: LatLng): [number, number] {
  return [p.longitude, p.latitude];
}

function boundsOf(points: LatLng[]): LngLatBounds | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
    west = Math.min(west, p.longitude);
    east = Math.max(east, p.longitude);
    south = Math.min(south, p.latitude);
    north = Math.max(north, p.latitude);
  }
  if (!Number.isFinite(west)) return null;
  return [west, south, east, north];
}

/**
 * A geodesic circle as a GeoJSON polygon.
 *
 * MapLibre's circle layer takes a radius in screen pixels, but GNSS accuracy is
 * in metres and has to stay the right size as the user zooms — so the disc is
 * built as a real polygon instead.
 */
function circlePolygon(centre: LatLng, radiusM: number, steps = 48): GeoJSON.Feature {
  const latRad = (centre.latitude * Math.PI) / 180;
  const dLat = radiusM / 111_320;
  const dLon = radiusM / (111_320 * Math.max(Math.cos(latRad), 1e-6));
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = (i / steps) * 2 * Math.PI;
    ring.push([centre.longitude + dLon * Math.cos(t), centre.latitude + dLat * Math.sin(t)]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

/**
 * The map surface.
 *
 * MapLibre + OpenStreetMap raster tiles: no Google Maps SDK, no API key, no
 * billing. The component's props are unchanged from the previous Google Maps
 * implementation, so every caller (live navigation, demo, session detail,
 * outage detail) keeps working without modification.
 *
 * Every polyline is decimated before it reaches the native map — a 300 s outage
 * produces 3000 dead-reckoned points and redrawing all of them on each update
 * is the single most expensive thing this screen can do.
 */
export const MatrixMap = forwardRef<MatrixMapHandle, MatrixMapProps>(function MatrixMap(
  {
    tracks = [],
    markers = [],
    vehicle,
    accuracyM,
    initialRegion,
    mapType = 'standard',
    followVehicle = true,
    style,
    onPanDrag,
    accessibilityLabel = 'Navigation map',
  },
  ref,
) {
  const c = useColors();
  const isDark = useIsDark();
  const cameraRef = useRef<CameraRef>(null);

  useImperativeHandle(ref, () => ({
    fitTo(points, padding = 64) {
      const bounds = boundsOf(points);
      if (!bounds) return;
      cameraRef.current?.fitBounds(bounds, {
        padding: { top: padding, right: padding, bottom: padding, left: padding },
        duration: 500,
      });
    },
    center(p, zoomDelta = 0.004) {
      cameraRef.current?.easeTo({
        center: toLngLat(p),
        zoom: zoomForDelta(zoomDelta),
        duration: 400,
      });
    },
  }));

  const region = useMemo(
    () =>
      initialRegion ??
      regionFor(tracks.flatMap((t) => t.points)) ??
      // Coventry — where the IO-VNBD drives were recorded; only used before a fix
      { latitude: 52.4068, longitude: -1.5197, latitudeDelta: 0.05, longitudeDelta: 0.05 },
    [initialRegion, tracks],
  );

  const mapStyle = useMemo(
    () => buildMapStyle(mapType, isDark, c.background),
    [mapType, isDark, c.background],
  );

  const drawn = useMemo(
    () =>
      tracks
        .filter((t) => t.points.length > 1)
        .map((t) => ({
          ...t,
          feature: {
            type: 'Feature' as const,
            properties: {},
            geometry: {
              type: 'LineString' as const,
              coordinates: decimate(t.points).map(toLngLat),
            },
          },
        })),
    [tracks],
  );

  if (Platform.OS === 'web') {
    return (
      <View style={[styles.fallback, { backgroundColor: c.surfaceSunken, borderColor: c.border }, style]}>
        <Txt variant="bodyStrong">Map preview is not available on web</Txt>
        <Txt variant="caption" color="textSecondary" style={{ textAlign: 'center' }}>
          MapLibre here is a native module. Run the app on Android or iOS with{' '}
          <Txt variant="caption" style={{ fontFamily: Platform.select({ default: 'monospace' }) }}>
            npx expo run:android
          </Txt>{' '}
          to see live navigation.
        </Txt>
      </View>
    );
  }

  return (
    <Map
      style={[StyleSheet.absoluteFill, style]}
      mapStyle={mapStyle}
      accessibilityLabel={accessibilityLabel}
      logo={false}
      attribution
      attributionPosition={{ bottom: 8, right: 8 }}
      compass
      compassPosition={{ top: 8, right: 8 }}
      scaleBar={false}
      touchPitch={false}
      onRegionIsChanging={(e) => {
        if (e.nativeEvent.userInteraction) onPanDrag?.();
      }}>
      <Camera
        ref={cameraRef}
        initialViewState={{
          center: [region.longitude, region.latitude],
          zoom: zoomForDelta(region.latitudeDelta),
        }}
        {...(followVehicle && vehicle ? { center: toLngLat(vehicle.coordinate) } : {})}
      />

      {accuracyM && vehicle ? (
        <GeoJSONSource
          id="accuracy-src"
          data={circlePolygon(vehicle.coordinate, Math.min(accuracyM, 250))}>
          <Layer
            id="accuracy-fill"
            type="fill"
            paint={{ 'fill-color': c.accent, 'fill-opacity': 0.1 }}
          />
          <Layer
            id="accuracy-line"
            type="line"
            paint={{ 'line-color': c.accent, 'line-opacity': 0.4, 'line-width': 1 }}
          />
        </GeoJSONSource>
      ) : null}

      {drawn.map((t) => (
        <GeoJSONSource key={t.id} id={`track-${t.id}`} data={t.feature}>
          <Layer
            id={`track-${t.id}-line`}
            type="line"
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{
              'line-color': t.color,
              'line-width': t.width ?? 5,
              'line-opacity': t.opacity ?? 1,
              ...(t.dashed ? { 'line-dasharray': [2, 1.6] } : {}),
            }}
          />
        </GeoJSONSource>
      ))}

      {markers.map((m) => (
        <Marker key={m.id} id={m.id} lngLat={toLngLat(m.coordinate)} anchor="center">
          <View
            accessible
            accessibilityLabel={m.description ? `${m.title}. ${m.description}` : m.title}
            style={[
              styles.marker,
              { backgroundColor: m.hollow ? 'transparent' : m.color, borderColor: m.color },
            ]}
          />
        </Marker>
      ))}

      {vehicle ? (
        <Marker id="vehicle" lngLat={toLngLat(vehicle.coordinate)} anchor="center">
          <View
            accessible
            accessibilityLabel="Vehicle"
            style={[styles.puckWrap, { transform: [{ rotate: `${vehicle.headingDeg ?? 0}deg` }] }]}>
            <View style={[styles.puckHalo, { backgroundColor: `${vehicle.tone}33` }]} />
            <View
              style={[
                styles.puck,
                {
                  backgroundColor: vehicle.stale ? 'transparent' : vehicle.tone,
                  borderColor: vehicle.stale ? vehicle.tone : c.surface,
                  borderWidth: vehicle.stale ? 3 : 2,
                },
              ]}
            />
            <View style={[styles.puckNose, { borderBottomColor: vehicle.tone }]} />
          </View>
        </Marker>
      ) : null}
    </Map>
  );
});

const styles = StyleSheet.create({
  fallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    padding: Spacing.xl,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  marker: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2.5,
  },
  puckWrap: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  puckHalo: { position: 'absolute', width: 40, height: 40, borderRadius: 20 },
  puck: { width: 18, height: 18, borderRadius: 9, borderWidth: 3 },
  puckNose: {
    position: 'absolute',
    top: 2,
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderBottomWidth: 8,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
});
