/**
 * Expo config plugin: register OnnxruntimePackage in MainApplication.
 *
 * Why this exists
 * ---------------
 * `onnxruntime-react-native` ships no `react-native.config.js` and no codegen
 * spec. Expo's autolinking therefore resolves its Gradle *project* — the Java
 * classes and the native `.so` are compiled into the app — but reports
 * `"packages": []` for it, so `OnnxruntimePackage` never reaches the generated
 * `PackageList.java`.
 *
 * The visible symptom is that `NativeModules.Onnxruntime` is `null`, and the
 * first inference dies on `TypeError: Cannot read property 'install' of null`.
 * That looked like a New Architecture problem and was misdiagnosed as one; it
 * is plain missing registration. Adding the package by hand is the escape
 * hatch the Expo template documents in this exact spot.
 *
 * Verify after a prebuild — this must list OnnxruntimePackage:
 *   grep -r OnnxruntimePackage android/app/src/main/java
 *
 * `android/` is generated, so without this plugin `expo prebuild --clean`
 * throws the registration away and the app regresses to that crash.
 */
const { withMainApplication } = require('@expo/config-plugins');

const IMPORT = 'import ai.onnxruntime.reactnative.OnnxruntimePackage';
const CALL = 'add(OnnxruntimePackage())';

function addImport(src) {
  if (src.includes(IMPORT)) return src;

  const lines = src.split('\n');
  let last = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('import ')) last = i;
  }
  if (last === -1) {
    throw new Error('with-onnxruntime-package: no imports found in MainApplication');
  }
  lines.splice(last + 1, 0, IMPORT);
  return lines.join('\n');
}

function addPackage(src) {
  if (src.includes(CALL)) return src;

  // The template's placeholder comment sits inside `PackageList(this).packages
  // .apply { ... }` — the one spot where an extra package belongs.
  const anchor = 'PackageList(this).packages.apply {';
  const at = src.indexOf(anchor);
  if (at === -1) {
    throw new Error(
      'with-onnxruntime-package: PackageList(this).packages.apply { not found — ' +
        'the Expo template changed, update this plugin'
    );
  }
  const end = at + anchor.length;
  return (
    src.slice(0, end) +
    '\n          // Registered by hand: autolinking reports no ReactPackage for' +
    '\n          // onnxruntime-react-native. See plugins/with-onnxruntime-package.js.' +
    `\n          ${CALL}` +
    src.slice(end)
  );
}

module.exports = function withOnnxruntimePackage(config) {
  return withMainApplication(config, (cfg) => {
    if (cfg.modResults.language !== 'kt') {
      throw new Error(
        `with-onnxruntime-package: expected a Kotlin MainApplication, got "${cfg.modResults.language}"`
      );
    }
    cfg.modResults.contents = addPackage(addImport(cfg.modResults.contents));
    return cfg;
  });
};
