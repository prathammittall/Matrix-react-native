/**
 * Expo dynamic configuration.
 *
 * `app.json` holds everything static; this file layers on what comes from the
 * environment.
 *
 * There is NO map API key. Maps are rendered by MapLibre from OpenStreetMap
 * tiles, so the app has no Google Maps SDK, no key to restrict and no billing
 * account to keep alive.
 *
 * Environment variables:
 *   EXPO_PUBLIC_MATRIX_API_URL   base URL of the OPTIONAL inference service
 *                                (diagnostics and session upload only —
 *                                navigation inference runs on-device)
 *   ANDROID_PACKAGE / IOS_BUNDLE_ID   app identifiers
 */

const LOCATION_WHY =
  'MATRIX uses your location to show your position on the map and to anchor the AI ' +
  'dead-reckoning estimate when the GNSS signal is lost.';

module.exports = ({ config }) => ({
  ...config,
  name: 'MATRIX',
  slug: 'matrix',
  scheme: 'matrix',
  userInterfaceStyle: 'automatic',
  extra: {
    ...config.extra,
    // Kept so Diagnostics can state plainly that no map key is needed.
    mapProvider: 'maplibre-osm',
    requiresMapApiKey: false,
  },
  ios: {
    ...config.ios,
    bundleIdentifier: process.env.IOS_BUNDLE_ID ?? 'com.matrix.deadreckoning',
    supportsTablet: true,
    infoPlist: {
      ...(config.ios && config.ios.infoPlist),
      NSLocationWhenInUseUsageDescription: LOCATION_WHY,
      NSLocationAlwaysAndWhenInUseUsageDescription: LOCATION_WHY,
      NSMotionUsageDescription:
        'MATRIX reads the accelerometer and gyroscope to estimate your position while ' +
        'the GNSS signal is unavailable. Motion data is used for navigation only.',
      UIBackgroundModes: ['location'],
    },
  },
  android: {
    ...config.android,
    package: process.env.ANDROID_PACKAGE ?? 'com.matrix.deadreckoning',
    permissions: [
      'ACCESS_COARSE_LOCATION',
      'ACCESS_FINE_LOCATION',
      'HIGH_SAMPLING_RATE_SENSORS',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_LOCATION',
    ],
  },
  plugins: [
    ...(config.plugins ?? []),
    [
      'expo-location',
      {
        locationAlwaysAndWhenInUsePermission: LOCATION_WHY,
        locationWhenInUsePermission: LOCATION_WHY,
        isAndroidForegroundServiceEnabled: true,
      },
    ],
    [
      'expo-sensors',
      {
        motionPermission:
          'MATRIX reads the accelerometer and gyroscope to estimate your position while ' +
          'the GNSS signal is unavailable.',
      },
    ],
    // MapLibre replaces Google Maps. `locationEngine: 'default'` keeps Google
    // Play Services out of the build entirely — the app already gets its fixes
    // from expo-location, so the map needs no location engine of its own.
    ['@maplibre/maplibre-react-native', { android: { locationEngine: 'default' } }],
    // onnxruntime-react-native is not picked up by autolinking as a
    // ReactPackage, so MainApplication has to register it by hand. Without
    // this the on-device model is unreachable. See the plugin for detail.
    './plugins/with-onnxruntime-package',
    // Forces expo.useLegacyPackaging=true so native .so libs are compressed and
    // extracted at install. Without it, 16 KB-page arm64 devices (Android 15+)
    // crash to a blank screen on launch. See the plugin for detail.
    './plugins/with-legacy-packaging',
  ],
});
