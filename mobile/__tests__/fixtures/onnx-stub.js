/* Jest cannot parse a binary ONNX graph. In the app these files are resolved by
 * Metro as assets (see metro.config.js) and handed to ONNX Runtime as a file
 * path; in tests the ORT module itself is mocked, so the module id is all that
 * matters here. */
module.exports = 'onnx-asset-stub';
