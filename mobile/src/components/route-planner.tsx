/**
 * Start / destination entry.
 *
 * The only part of the app that needs the network, and it needs it once: two
 * place names in, one route out. Everything after that — following the line,
 * counting down to the next turn, surviving a GNSS outage on the inertial
 * estimate — runs from the route object this screen produces.
 *
 * The start field defaults to the live position, which is what a driver wants
 * nine times out of ten and is also the only start point that is guaranteed to
 * be on a road the vehicle can actually reach.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { formatDistance, formatDuration } from '@/services/format';
import {
  planRoute,
  reverseGeocode,
  routeStore,
  RoutingError,
  searchPlaces,
} from '@/services/routing';
import type { Units } from '@/services/storage';
import { Radius, Spacing, useColors } from '@/theme';
import type { GeoPlace, LatLng, Route } from '@/types';
import { Button, ListRow } from './ui/controls';
import { Card, Divider, Row, Txt } from './ui/primitives';

/** Nominatim's usage policy is one request a second; typing is far faster. */
const SEARCH_DEBOUNCE_MS = 450;

type Field = 'origin' | 'destination';

export function RoutePlanner({
  /** the live position, when there is one */
  here,
  units,
  onPlanned,
}: {
  here: LatLng | null;
  units: Units;
  onPlanned: (route: Route) => void;
}) {
  const c = useColors();
  const [origin, setOrigin] = useState<GeoPlace | null>(null);
  const [destination, setDestination] = useState<GeoPlace | null>(null);
  const [active, setActive] = useState<Field>('destination');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeoPlace[]>([]);
  const [recents, setRecents] = useState<GeoPlace[]>([]);
  const [searching, setSearching] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Route | null>(null);

  const hereRef = useRef(here);
  hereRef.current = here;

  useEffect(() => {
    void routeStore.recents().then(setRecents);
  }, []);

  // Name the current position once a fix exists, so the start field reads
  // "Current location — Foleshill Road" rather than a pair of decimals.
  useEffect(() => {
    if (!here || origin) return;
    let alive = true;
    void reverseGeocode(here).then((p) => {
      if (alive) setOrigin(p);
    });
    return () => {
      alive = false;
    };
  }, [here, origin]);

  // Debounced search. The request is fired for the field being edited only.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    // `alive` lives in the effect scope, not the timeout's: a reply that lands
    // after the user has typed another character must not overwrite the newer
    // results, which is the classic search-as-you-type race.
    let alive = true;
    const id = setTimeout(() => {
      void searchPlaces(q, hereRef.current)
        .then((found) => {
          if (!alive) return;
          setResults(found);
          setError(found.length ? null : `Nothing found for “${q}”`);
        })
        .catch((err: unknown) => {
          if (!alive) return;
          setResults([]);
          setError(err instanceof RoutingError ? err.message : 'Place search failed');
        })
        .finally(() => {
          if (alive) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [query]);

  const choose = useCallback(
    (place: GeoPlace) => {
      if (active === 'origin') setOrigin(place);
      else setDestination(place);
      setQuery('');
      setResults([]);
      setError(null);
      setPreview(null);
    },
    [active],
  );

  const useCurrentLocation = useCallback(() => {
    const p = hereRef.current;
    if (!p) {
      setError('No position yet — start navigation so the receiver can get a fix.');
      return;
    }
    setError(null);
    void reverseGeocode(p).then(setOrigin);
    setActive('destination');
  }, []);

  const plan = useCallback(async () => {
    if (!origin || !destination) return;
    setPlanning(true);
    setError(null);
    try {
      const route = await planRoute(origin, destination);
      setPreview(route);
      setRecents(await routeStore.remember(destination));
    } catch (err) {
      setPreview(null);
      setError(err instanceof RoutingError ? err.message : 'Could not plan a route');
    } finally {
      setPlanning(false);
    }
  }, [origin, destination]);

  const swap = useCallback(() => {
    setOrigin(destination);
    setDestination(origin);
    setPreview(null);
  }, [origin, destination]);

  const suggestions = query.trim().length >= 2 ? results : recents;
  const suggestionLabel = query.trim().length >= 2 ? 'Results' : 'Recent destinations';

  return (
    <View style={{ gap: Spacing.md }}>
      <Card style={{ gap: Spacing.sm }}>
        <PlaceField
          label="From"
          place={origin}
          focused={active === 'origin'}
          query={active === 'origin' ? query : ''}
          placeholder="Search a starting point"
          onFocus={() => {
            setActive('origin');
            setQuery('');
          }}
          onChange={setQuery}
        />
        <Row gap={Spacing.sm} justify="space-between">
          <Pressable
            onPress={useCurrentLocation}
            accessibilityRole="button"
            accessibilityLabel="Use current location as the starting point"
            style={({ pressed }) => [
              styles.chip,
              { borderColor: c.border, backgroundColor: pressed ? c.surfaceRaised : 'transparent' },
            ]}>
            <Txt variant="caption" color="accent">
              Use current location
            </Txt>
          </Pressable>
          <Pressable
            onPress={swap}
            accessibilityRole="button"
            accessibilityLabel="Swap start and destination"
            style={({ pressed }) => [
              styles.chip,
              { borderColor: c.border, backgroundColor: pressed ? c.surfaceRaised : 'transparent' },
            ]}>
            <Txt variant="caption" color="textSecondary">
              Swap
            </Txt>
          </Pressable>
        </Row>
        <Divider />
        <PlaceField
          label="To"
          place={destination}
          focused={active === 'destination'}
          query={active === 'destination' ? query : ''}
          placeholder="Search a destination"
          onFocus={() => {
            setActive('destination');
            setQuery('');
          }}
          onChange={setQuery}
        />
      </Card>

      {error ? (
        <Txt variant="caption" style={{ color: c.warn }}>
          {error}
        </Txt>
      ) : null}

      {suggestions.length ? (
        <Card padded={false}>
          <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.md }}>
            <Row gap={Spacing.sm}>
              <Txt variant="micro" color="textTertiary">
                {suggestionLabel.toUpperCase()}
              </Txt>
              {searching ? <ActivityIndicator size="small" color={c.textTertiary} /> : null}
            </Row>
          </View>
          {suggestions.slice(0, 6).map((p, i, arr) => (
            <ListRow
              key={`${p.id}-${i}`}
              title={p.name}
              subtitle={p.address}
              last={i === arr.length - 1}
              onPress={() => choose(p)}
            />
          ))}
        </Card>
      ) : null}

      {preview ? (
        <Card style={{ gap: Spacing.sm }}>
          <Row justify="space-between">
            <Txt variant="label">{formatDistance(preview.distanceM, units)}</Txt>
            <Txt variant="label" color="textSecondary">
              {formatDuration(preview.durationS)}
            </Txt>
          </Row>
          <Txt variant="caption" color="textSecondary" numberOfLines={2}>
            {preview.steps.length} manoeuvres via {preview.provider}. The whole route is stored on
            the device, so guidance keeps running if the signal goes.
          </Txt>
          <Button label="Start guidance" onPress={() => onPlanned(preview)} fullWidth />
        </Card>
      ) : (
        <Button
          label="Get route"
          onPress={() => void plan()}
          loading={planning}
          disabled={!origin || !destination}
          fullWidth
          accessibilityHint="Plans a road route between the two places using OpenStreetMap data"
        />
      )}
    </View>
  );
}

function PlaceField({
  label,
  place,
  focused,
  query,
  placeholder,
  onFocus,
  onChange,
}: {
  label: string;
  place: GeoPlace | null;
  focused: boolean;
  query: string;
  placeholder: string;
  onFocus: () => void;
  onChange: (v: string) => void;
}) {
  const c = useColors();
  const showInput = focused && (query.length > 0 || !place);

  return (
    <View style={{ gap: 4 }}>
      <Txt variant="micro" color="textTertiary">
        {label.toUpperCase()}
      </Txt>
      {showInput || !place ? (
        <TextInput
          value={query}
          onChangeText={onChange}
          onFocus={onFocus}
          autoCapitalize="words"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel={`${label} place`}
          placeholder={placeholder}
          placeholderTextColor={c.textTertiary}
          style={[
            styles.input,
            {
              borderColor: focused ? c.accent : c.border,
              backgroundColor: c.surfaceSunken,
              color: c.text,
            },
          ]}
        />
      ) : (
        <Pressable
          onPress={onFocus}
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${place.name}. Tap to change`}
          style={[styles.input, styles.filled, { borderColor: c.border, backgroundColor: c.surfaceSunken }]}>
          <Txt variant="body" numberOfLines={1}>
            {place.name}
          </Txt>
          <Txt variant="caption" color="textTertiary" numberOfLines={1}>
            {place.address}
          </Txt>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 46,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
  },
  filled: { justifyContent: 'center', paddingVertical: Spacing.sm },
  chip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    borderRadius: Radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
