/* Test environment shims.
 *
 * The suite targets the LOGIC layer — GNSS classification, sensor buffering,
 * request/response contracts, mode switching, polyline maths. Those modules
 * import Expo native modules at the top level, so the handful of native surfaces
 * they touch are stubbed here. Nothing model-related is stubbed: the frozen
 * pipeline lives on the backend and is covered by backend/tools/*.py.
 */
jest.mock('expo-sensors', () => ({
  Accelerometer: {
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    setUpdateInterval: jest.fn(),
    isAvailableAsync: jest.fn(async () => true),
    requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
  },
  Gyroscope: {
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    setUpdateInterval: jest.fn(),
    isAvailableAsync: jest.fn(async () => true),
    requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
  },
}));

jest.mock('expo-location', () => ({
  Accuracy: { BestForNavigation: 6 },
  PermissionStatus: { GRANTED: 'granted', DENIED: 'denied' },
  hasServicesEnabledAsync: jest.fn(async () => true),
  requestForegroundPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  getForegroundPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  watchPositionAsync: jest.fn(async () => ({ remove: jest.fn() })),
}));

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (k) => (store.has(k) ? store.get(k) : null)),
      setItem: jest.fn(async (k, v) => void store.set(k, v)),
      removeItem: jest.fn(async (k) => void store.delete(k)),
      clear: jest.fn(async () => void store.clear()),
    },
  };
});

/* On-device inference: the native ONNX Runtime module and the asset resolver.
 * The stub returns a deterministic value per window so the window-formation,
 * scaling and un-scaling logic can be asserted without a device. Numerical
 * fidelity of the real graph is covered by backend/tools/export_onnx.py, which
 * verifies ONNX against PyTorch on real test windows before writing the files. */
jest.mock('expo-file-system', () => ({
  File: class {
    constructor(uri) { this.uri = uri; }
    async arrayBuffer() { return new ArrayBuffer(8); }
  },
}));

jest.mock('expo-asset', () => ({
  Asset: {
    fromModule: () => ({
      downloaded: true,
      localUri: 'file:///stub/model.onnx',
      uri: 'file:///stub/model.onnx',
      downloadAsync: jest.fn(async () => undefined),
    }),
  },
}));

jest.mock('onnxruntime-react-native', () => {
  class Tensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }
  // Both graphs return the same value in SCALED space, so a test can assert the
  // un-scaling without depending on which session was created first.
  const SCALED = 0.5;
  const makeSession = () => ({
    run: jest.fn(async (feeds) => {
      const batch = feeds.window.dims[0];
      const out = new Float32Array(batch * 2);
      for (let i = 0; i < batch; i += 1) {
        out[i * 2] = SCALED;        // scaled output 0
        out[i * 2 + 1] = -SCALED;   // scaled output 1
      }
      return { prediction: { data: out, dims: [batch, 2] } };
    }),
    release: jest.fn(async () => undefined),
  });
  return {
    Tensor,
    SCALED_STUB_OUTPUT: SCALED,
    InferenceSession: { create: jest.fn(async () => makeSession()) },
  };
});

