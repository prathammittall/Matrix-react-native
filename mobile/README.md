# MATRIX — mobile app

AI dead reckoning for GNSS-denied navigation. Expo / React Native client for the
frozen MATRIX model.

**Full operating manual: [`../FRONTEND_RUN.md`](../FRONTEND_RUN.md)**
(prerequisites, environment variables, backend, Demo Mode, architecture
diagram, troubleshooting, production builds).

## Quick start

```bash
npm install
cp .env.example .env          # optional: inference-service URL. There is no map key.
npx expo run:android          # build + install the dev client (once)
npx expo start --dev-client   # afterwards
```

> Expo Go will not work — MapLibre is a native module and needs a development
> build.

**There is no map API key anywhere in this app.** The basemap is MapLibre over
OpenStreetMap raster tiles; place search and road routing use Nominatim and
OSRM, which are keyless too.

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
| `npm test` | 215 unit tests (GNSS states, buffering, API contract, mode switching, polylines, on-device inference, frozen-filter parity, route
planning, turn-by-turn guidance) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | expo lint |
| `npm run android` / `ios` / `web` | start on a platform |

## Layout

```
src/
  app/          screens (expo-router file routes)
  components/   reusable components + ui/ kit
  services/     sensors, gnss, navigation-engine, api, storage, demo-player, track,
                ondevice-inference, frozen-fusion, inference-backend, geo,
                routing, guidance
  hooks/        use-engine, use-settings, use-guidance
  theme/        design tokens
  types/        domain contracts
__tests__/      unit tests
```

## Turn-by-turn guidance

Enter a start and a destination on the **Navigate** tab and the app guides the
drive the way a consumer navigation app does: a manoeuvre banner, a countdown to
the next turn, ETA, distance remaining, and the driven part of the route dimmed
behind the vehicle.

The reason it is here is the outage case. Route search and planning touch the
network exactly once, while the vehicle is stopped; the resulting route —
geometry, cumulative distances, every manoeuvre with its offset from the origin
— is then held on the device and in AsyncStorage. `services/guidance.ts` is a
set of pure functions over that object and the engine's single `position` field,
and it never asks where that position came from. So when GNSS drops and
`navigation-engine.ts` switches `position` to the dead-reckoned estimate,
guidance carries on in the same frame: no re-planning, no network, no
"recalculating".

Two things do change with the source, both deliberate:

* the off-route threshold widens with outage duration, because an inertial
  position drifts whether or not the driver did anything wrong
  (`offRouteAllowanceM`); and
* automatic re-planning is disabled during an outage — it needs a network and a
  trustworthy start point, and an outage has neither. The planned line stays on
  screen for the driver to rejoin.

Position during an outage comes from an inference backend running the frozen
model — on-device or the service. The maths is never re-derived: the weights are
an export of the frozen checkpoints, verified against PyTorch, and
`frozen-fusion.ts` is pinned to the frozen Python by golden-vector tests. See
`../backend/README.md`.
