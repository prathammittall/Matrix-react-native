# MATRIX — mobile app

AI dead reckoning for GNSS-denied navigation. Expo / React Native client for the
frozen MATRIX model.

**Full operating manual: [`../FRONTEND_RUN.md`](../FRONTEND_RUN.md)**
(prerequisites, environment variables, Google Maps setup, backend, Demo Mode,
architecture diagram, troubleshooting, production builds).

## Quick start

```bash
npm install
cp .env.example .env          # then fill in the Google Maps keys and API URL
npx expo run:android          # build + install the dev client (once)
npx expo start --dev-client   # afterwards
```

> Expo Go will not work — `react-native-maps` is a native module and needs a
> development build.

**The AI model runs on the phone by default** — the frozen weights are bundled
as ONNX graphs and executed with ONNX Runtime, so navigation, dead reckoning and
Demo Mode all work with no network. The inference service is optional, and is a
second way to run the same frozen model:

```bash
python -m uvicorn matrix_service.api:app --app-dir backend --host 0.0.0.0 --port 8000
```

Switch between them in **Settings → AI inference**.

## Release APK

```bash
npx expo prebuild --platform android --clean
cd android && ./gradlew assembleRelease
```

On Windows this repository hits two path gotchas (spaces in the project path,
and backslashes in `local.properties`). Both are documented with the fix in
[`../FRONTEND_RUN.md`](../FRONTEND_RUN.md) section 14.

## Scripts

| Command | Purpose |
|---|---|
| `npm test` | 153 unit tests (GNSS states, buffering, API contract, mode switching, polylines, on-device inference, frozen-filter parity) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | expo lint |
| `npm run android` / `ios` / `web` | start on a platform |

## Layout

```
src/
  app/          screens (expo-router file routes)
  components/   reusable components + ui/ kit
  services/     sensors, gnss, navigation-engine, api, storage, demo-player, track,
                ondevice-inference, frozen-fusion, inference-backend, geo
  hooks/        use-engine, use-settings
  theme/        design tokens
  types/        domain contracts
__tests__/      unit tests
```

Position during an outage comes from an inference backend running the frozen
model — on-device or the service. The maths is never re-derived: the weights are
an export of the frozen checkpoints, verified against PyTorch, and
`frozen-fusion.ts` is pinned to the frozen Python by golden-vector tests. See
`../backend/README.md`.
