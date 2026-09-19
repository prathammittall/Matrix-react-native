// Learn more: https://docs.expo.dev/guides/customizing-metro/
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// The frozen models ship inside the app as ONNX graphs so dead reckoning works
// with no network. Registering the extension here is what puts them in the
// binary: Metro packages them as assets, and `Asset.fromModule(require(...))`
// in src/services/ondevice-inference.ts unpacks them at runtime. Without this
// Metro would try to parse a 591 KB protobuf as JavaScript.
config.resolver.assetExts.push('onnx', 'ort');

module.exports = config;
