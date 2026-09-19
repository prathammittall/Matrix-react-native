/**
 * Expo config plugin: force `expo.useLegacyPackaging=true` in gradle.properties.
 *
 * Why this exists
 * ---------------
 * With legacy packaging OFF (the Expo default), native `.so` libraries are
 * stored UNCOMPRESSED and 4 KB page-aligned inside the APK and mapped straight
 * from it (`android:extractNativeLibs="false"`). On arm64 devices that use a
 * 16 KB memory page size — a growing share of Android 15+ hardware — libraries
 * aligned to only 4 KB fail to load, so the app shows a blank screen and then
 * crashes on launch. Devices with the traditional 4 KB page size load the same
 * APK fine, which is why the crash appears on "some phones but not others".
 *
 * Turning legacy packaging ON compresses the libraries and extracts them to the
 * filesystem at install time, so their alignment inside the APK no longer
 * matters and the 16 KB-page devices work. It also shrinks the APK, which eases
 * the "download gets stuck" reports on large sideloaded files.
 *
 * `android/` is generated, so without this plugin `expo prebuild --clean`
 * resets the flag to false and the crash returns. Verify after a prebuild:
 *   grep useLegacyPackaging android/gradle.properties   # -> ...=true
 */
const { withGradleProperties } = require('@expo/config-plugins');

const KEY = 'expo.useLegacyPackaging';

module.exports = function withLegacyPackaging(config) {
  return withGradleProperties(config, (cfg) => {
    const props = cfg.modResults;
    const existing = props.find(
      (item) => item.type === 'property' && item.key === KEY
    );
    if (existing) {
      existing.value = 'true';
    } else {
      props.push({ type: 'property', key: KEY, value: 'true' });
    }
    return cfg;
  });
};
