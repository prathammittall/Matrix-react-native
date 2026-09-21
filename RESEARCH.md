# RESEARCH — what MATRIX is built on, and what to build next

A survey of the literature and public implementations that bear on GNSS-denied
vehicle positioning from a smartphone IMU, and a concrete, ranked roadmap for
this codebase. Written to be argued with: every recommendation says what it
would cost and what would have to be true for it to help.

---

## 1. The problem, stated precisely

Given a window of raw inertial signal from a phone rigidly (or semi-rigidly)
mounted in a moving road vehicle, and a known position, velocity and heading at
the moment GNSS was lost, estimate position for the duration of the outage.

Three things make this hard and they are worth separating, because different
literature attacks different ones:

| | Problem | Why it is hard |
|---|---|---|
| **A** | **Speed** | double-integrating MEMS acceleration diverges quadratically |
| **B** | **Heading** | gyro bias integrates linearly; after ~300 s it dominates the error |
| **C** | **Frame** | the phone's axes are not the vehicle's, and the relationship is unknown and can change |

MATRIX currently addresses **A** with a learned model, **B** with a learned yaw
rate anchored to the last GNSS bearing, and **C** with per-session frame fitting
during preprocessing. **C is the weakest of the three in deployment**, because
the app does no live frame estimation at all — it inherits whatever the training
distribution of mounting orientations was.

---

## 2. The lineage this project sits in

### 2.1 IO-VNBD and the Onyekpe line — the direct ancestor

- **IO-VNBD** — Onyekpe, Palade, Kanarachos, Szkolnik (2020/2021).
  [arXiv:2005.01701](https://arxiv.org/abs/2005.01701) ·
  [Data in Brief](https://www.sciencedirect.com/science/article/pii/S2352340921001694) ·
  [github.com/onyekpeu/IO-VNBD](https://github.com/onyekpeu/IO-VNBD)

  The corpus this project trains on. Recorded on public roads in the UK, Nigeria
  and France with a research vehicle: GPS, vehicle ECU and wheel-speed channels,
  plus an Android phone logging IMU at 10 Hz. The dataset exists specifically
  because there was no public benchmark for *learning INS error* — which is the
  framing that makes the whole approach coherent.

- **WhONet — Wheel Odometry neural Network** — Onyekpe et al., *Engineering
  Applications of AI* 105 (2021).
  [arXiv:2104.02581](https://arxiv.org/abs/2104.02581)

  A recurrent network that learns the *uncertainty* in wheel-speed
  measurements — slip, tyre pressure, wear, wet and muddy roads — and corrects
  displacement accordingly. Evaluated on roundabouts, sharp cornering, hard
  braking and wet roads, over 30/60/120/180 s outages across 493 km, reporting
  up to a **93 % reduction in positioning error at 180 s** against uncorrected
  wheel odometry.

  **Relevance and the honest caveat:** WhONet's input is the wheel encoder.
  MATRIX has no wheel encoder — it is a phone in a cradle. The *method* (learn
  the error, not the signal) transfers directly; the *inputs* do not. Quoting
  WhONet's numbers as if they were MATRIX's would be dishonest, and the app's
  About screen is careful not to.

- **R-WhONet** — recalibration by transfer learning.
  [arXiv:2209.05877](https://arxiv.org/abs/2209.05877)

  Adapts a trained WhONet to a new vehicle with different tyre pressure, wear,
  size or driving behaviour. **This is the single most directly applicable idea
  in the whole survey for MATRIX's biggest stated limitation** — one phone, one
  vehicle, three drivers. See §4.3.

### 2.2 AI-IMU Dead-Reckoning — the most important paper we have not used yet

- Brossard, Barrau, Bonnabel, *IEEE T-IV* (2020).
  [arXiv:1904.06064](https://arxiv.org/abs/1904.06064) ·
  [github.com/mbrossar/ai-imu-dr](https://github.com/mbrossar/ai-imu-dr)

  IMU-only dead reckoning for wheeled vehicles built on an **Invariant Extended
  Kalman Filter**, where a small CNN *dynamically adapts the filter's noise
  covariances*. On the KITTI odometry benchmark it reaches ~1.10 % translational
  error — competitive with LiDAR and stereo methods, using an IMU alone.

  The mechanism worth stealing is not the network. It is the **pseudo-
  measurements**: a wheeled vehicle moving normally has approximately zero
  lateral velocity and zero vertical velocity in its own body frame. These
  *non-holonomic constraints* (NHC) are free information, available at every
  timestep, with no extra sensor. The learned part is deciding *how much to
  trust them right now* — because they are violated during slip, sharp
  cornering, and speed bumps, and a filter that trusts them blindly through a
  skid will confidently produce a wrong answer.

  **Partly adopted.** The gating idea — trust a motion assumption only when the
  signal says it holds — is what `motion-constraints.ts` does for ZUPT. The
  lateral-velocity constraint itself turned out to be structural in MATRIX's
  formulation rather than something to add; see §4.1. The genuinely unadopted
  part is the *filter*: MATRIX fuses with a fixed-τ complementary filter, not an
  IEKF with learned covariances, so it has no uncertainty to report. See §4.2.

### 2.3 Learned inertial odometry more broadly

| Work | Domain | What transfers |
|---|---|---|
| **IONet** (Chen et al., AAAI 2018) | pedestrian | the original "regress displacement from an IMU window" framing MATRIX's Δv model is a descendant of |
| **RoNIN** (Herath et al., ICRA 2020) | pedestrian | heading-agnostic coordinate frames — velocity regressed in a frame that does not depend on device orientation. Directly relevant to problem **C** |
| **TLIO** (Liu et al., RA-L 2020) | pedestrian | learned displacement *and its uncertainty*, fed to an EKF as a measurement with a real covariance. The pattern to copy if MATRIX ever moves from a complementary filter to a Kalman filter |
| **Zero-velocity update (ZUPT)** literature | pedestrian, vehicle | detect stationarity from IMU statistics and clamp velocity to zero. Cheap, robust, large payoff at traffic lights and in car parks |

**A caution about the pedestrian work.** RoNIN and TLIO are trained on humans
walking, where the IMU is dominated by gait — a strong, quasi-periodic signal.
A car's IMU signature is nothing like it: much lower amplitude, dominated by
engine and road vibration, with the informative content in slow longitudinal and
yaw dynamics. Their *architectures and framings* transfer. Their *weights* do
not, and neither do their reported error figures.

### 2.4 Tooling

- [github.com/builtbyanish/iovnbd-ml-pipeline](https://github.com/builtbyanish/iovnbd-ml-pipeline) —
  a public Python pipeline for extracting, cleaning and merging IO-VNBD's
  fragmented per-trip CSVs into ML-ready datasets. Worth reading as a
  cross-check on our own `pass1..pass12` conclusions — particularly the
  duplicate-view and GPS-cadence findings, which are the two that most obviously
  bite anyone approaching this corpus fresh.

---

## 3. Where MATRIX actually stands

| Capability | Status |
|---|---|
| Learned Δv + yaw rate from raw IMU | done, frozen, exported to ONNX, running on-device |
| Complementary fusion with an absolute-velocity anchor | done, frozen, ported to TS with golden-vector parity |
| Exact 10 Hz input contract on a live phone | **done** — fixed sampling grid |
| Outage detection that does not fire on noise | **done** — time-based confirmation + hysteresis |
| Zero-velocity detection (ZUPT) | **done** — `mobile/src/services/motion-constraints.ts` |
| ZUPT-aided yaw-rate bias removal | **done** — same module |
| Non-holonomic constraints | structural: the frozen `deadReckon` advances only along the heading, so there is no lateral velocity to constrain |
| Live phone-to-vehicle frame estimation | **not done** — inherited from training only |
| Uncertainty estimate on the position | **not done** — the app shows a point, not an ellipse |
| Map matching | **not done** |
| Per-device calibration / recalibration | **not done** |

The first six rows are the product. The rest is the roadmap, ranked below.

---

## 4. Roadmap, in order of value per unit of risk

### 4.1 Zero-velocity and non-holonomic constraints — **done, needs measuring**

> **Status:** implemented in `mobile/src/services/motion-constraints.ts`, applied
> to the frozen pipeline's output and re-integrated through the frozen
> `deadReckon`, switchable from Settings. What remains is the part that needs a
> vehicle: the thresholds below are reasoned from the physics and the sensor
> noise floor, and have **not** been tuned against the VBOX reference on the test
> split. Until they are, treat the improvement as expected rather than measured.
>
> NHC turned out to be structural rather than something to add — the frozen
> formulation has no lateral velocity state — and that is recorded in the module
> so nobody later adds a no-op believing it does something.

**What:** two post-processing constraints applied to the frozen pipeline's
*output*, not to the model:

1. **ZUPT.** When the IMU's rolling variance over ~1 s falls below a threshold
   on all six channels, the vehicle is stationary. Clamp velocity to 0 and stop
   integrating position. Traffic lights, junctions and car parks are a large
   fraction of any urban outage, and every second spent stationary is currently
   a second of accumulating drift for no reason at all.
2. **NHC.** Reject the lateral component of the estimated velocity in the
   vehicle body frame, gated on turn rate — because the constraint is violated
   exactly when the vehicle is cornering hard or slipping, which is when
   applying it would do the most damage.

**Why first:** it is the largest expected error reduction for the least risk,
and it is provably *outside* the frozen boundary — the models, the scaler, τ and
the dead-reckoning maths are untouched. It is a filter on the output. It can be
unit-tested against the existing dense predictions in
`model/experiments/complementary_fusion/predictions/dense/` with no retraining
and no new data collection.

**Risk:** a false-positive ZUPT while crawling in traffic freezes the position.
The detector must be conservative and the threshold has to be validated against
the VBOX reference on the test split, not guessed.

**Where it went:** `motion-constraints.ts`, beside `frozen-fusion.ts`, applied
after `fuseAndDeadReckon`. The property pinned by test is the important one:
with constraints disabled the re-integrated track is bit-identical to the frozen
one, so the benchmark figures remain measurable. A Python reference
implementation for the backend path is still outstanding.

### 4.2 An uncertainty estimate

**What:** report a growing error radius, not a point. Even a calibrated
empirical model — error as a function of outage duration and mean speed, fitted
on the test split — would be a large honesty improvement over a puck that looks
exactly as confident at 300 s as at 3 s.

**Why:** the app's own About screen says drift reaches hundreds of metres at
300 s. The interface should *show* that, continuously, rather than stating it in
a paragraph nobody reads while driving. This is a UI change backed by a
regression fit; it needs no retraining.

**Risk:** low. The main danger is presenting a fitted radius as if it were a
principled covariance. Label it as what it is.

### 4.3 Recalibration for a new phone or vehicle — the R-WhONet idea

**What:** a short supervised "learning drive" with good GNSS, from which a small
per-device correction is fitted — a scale factor on Δv and a gyro bias
estimate — leaving the frozen weights alone.

**Why:** this attacks the single limitation most likely to be raised about the
project, namely that it was trained on one Huawei P20 Pro in one Ford Fiesta.
R-WhONet demonstrates the transfer-learning form of this idea works for a
related problem.

**Risk:** medium. It introduces per-device state, and a badly fitted correction
is worse than none. It must be reversible and visible to the user.

### 4.4 Live frame estimation

**What:** estimate the phone-to-vehicle rotation during the GNSS-good phase,
from the correlation between GNSS-derived acceleration/heading change and the
IMU, and apply it as an input rotation.

**Why:** problem **C**. Today a user who mounts the phone differently from the
training distribution gets a silently worse result with no indication.

**Risk:** high, and this one touches the input contract. A rotation applied
before the scaler changes what the frozen model sees. It would need the same
level of validation the yaw-sign convention got, and it is the kind of change
that should be gated behind a setting and measured before it is trusted.

### 4.5 Map matching

**What:** snap the dead-reckoned track to the road network.

**Why:** the largest single accuracy win available, because a vehicle in a
tunnel is on a *known road*, and that is enormously strong prior information.

**Risk:** it is a different project. It needs offline road geometry on the
device, and it makes the system's output no longer a pure inertial estimate —
which changes what the demo is claiming. Worth doing; worth doing *last*, and
worth labelling clearly in the UI when it is on.

### What deliberately is **not** on this roadmap

- **Retraining, or any change under `model/`.** The frozen system is verified
  byte-for-byte and its numbers are reported against that verification. Every
  item above is additive and lives outside that boundary.
- **Quantising the ONNX graphs.** 151k parameters run in single-figure
  milliseconds on CPU. There is no latency problem to trade accuracy for.
- **Porting a pedestrian model.** See the caution in §2.3.

---

## 5. How to evaluate any of this honestly

The evaluation protocol already in place is the right one and should not be
weakened to make a new feature look good:

- **Split by driver, never by random window.** A random split over a 10 Hz
  series leaks neighbouring samples across the boundary; the resulting numbers
  are meaningless and always flattering.
- **Report at fixed outage horizons** — 10 s, 30 s, 60 s, 120 s, 180 s, 300 s —
  because a single mean error hides the quadratic shape that is the entire
  story.
- **Report the distribution, not just the mean.** The 95th percentile is what a
  safety case is written against.
- **Freeze before testing.** The test split is touched once, after selection is
  complete. `phase5_test.py` exists to be run exactly once.
- **State the coverage.** `inferredS` versus `durationS` on an outage is the
  honest measure of how much of it the model actually saw. If windows were
  dropped, the error figure is not comparable to one where none were.

---

## 6. Sources

- [IO-VNBD: Inertial and Odometry Benchmark Dataset for Ground Vehicle Positioning](https://arxiv.org/abs/2005.01701)
- [IO-VNBD in Data in Brief](https://www.sciencedirect.com/science/article/pii/S2352340921001694)
- [IO-VNBD dataset repository](https://github.com/onyekpeu/IO-VNBD)
- [WhONet: Wheel Odometry Neural Network for Vehicular Localisation in GNSS-Deprived Environments](https://arxiv.org/abs/2104.02581)
- [R-WhONet: Recalibrated Wheel Odometry Neural Network using Transfer Learning](https://arxiv.org/abs/2209.05877)
- [AI-IMU Dead-Reckoning](https://arxiv.org/abs/1904.06064)
- [ai-imu-dr reference implementation](https://github.com/mbrossar/ai-imu-dr)
- [iovnbd-ml-pipeline — a public IO-VNBD cleaning pipeline](https://github.com/builtbyanish/iovnbd-ml-pipeline)
