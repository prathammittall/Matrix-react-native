"""Phases 2-4: fusion methods, validation dead reckoning, and frozen selection.

VALIDATION ONLY. The test dense files are never opened here.

Fair-comparison rule (as specified): every velocity estimator receives the SAME
ground-truth velocity anchor v0 at the start of each outage, and every estimator is
paired with the SAME predicted yaw rate, so differences are attributable to velocity alone.
"""
import os, json
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DENSE = os.path.join(HERE, 'predictions', 'dense', 'validation')
OUT = os.path.join(HERE, 'validation_results')
os.makedirs(OUT, exist_ok=True)
K, DT = 5, 0.1
OUTAGES = [10, 30, 60, 120, 300]
STEP_S = 30
ALPHAS = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
TAUS = [1, 2, 5, 10, 20, 30, 60, 120, 300, 1000]


def dead_reckon(v, yaw, dt=DT):
    h = np.cumsum(yaw * dt)
    hm = np.concatenate([[0.0], h[:-1]]) + yaw * dt / 2.0
    return np.cumsum(v * np.cos(hm) * dt), np.cumsum(v * np.sin(hm) * dt), h


def v_delta_stride(dv, v0):
    """Frozen Experiment-dv reconstruction: v[t] = v[t-k] + dv[t] on a stride-k lattice."""
    n = len(dv)
    v = np.full(n, np.nan)
    lat = np.arange(0, n, K)
    cur = v0
    v[0] = v0
    for j in range(1, len(lat)):
        cur = cur + dv[lat[j]]
        v[lat[j]] = cur
    idx = lat[~np.isnan(v[lat])]
    return np.maximum(np.interp(np.arange(n), idx, v[idx]), 0.0)


def v_delta_steps(dv, v0):
    """Per-step increments: inc[t] = dv_k[t] / k. Used by the complementary filter."""
    return np.maximum(v0 + np.cumsum(dv / K), 0.0)


def v_abs_anchored(va, v0):
    return np.maximum(va - (va[0] - v0), 0.0)


def complementary(dv, va_anch, v0, tau):
    """v <- (1 - dt/tau)(v + inc) + (dt/tau) v_abs   : dv for dynamics, v_abs as anchor."""
    inc = dv / K
    g = DT / tau
    n = len(dv)
    v = np.empty(n)
    v[0] = v0
    for t in range(1, n):
        prop = v[t - 1] + inc[t]
        v[t] = (1.0 - g) * prop + g * va_anch[t]
    return np.maximum(v, 0.0)


def main():
    segs = []
    for f in sorted(os.listdir(DENSE)):
        d = pd.read_parquet(os.path.join(DENSE, f))
        ok = d.ok.to_numpy()
        vt = d.v_true.to_numpy(float)
        wt = d.yaw_true.to_numpy(float)
        va = d.v_abs_pred.to_numpy(float)
        dv = d.dv_pred.to_numpy(float)
        wp = d.yaw_pred_dv.to_numpy(float)      # common yaw for every variant
        for T in OUTAGES:
            L = int(T / DT)
            for s0 in range(0, len(d) - L, int(STEP_S / DT)):
                sl = slice(s0, s0 + L)
                if not ok[sl].all():
                    continue
                segs.append((d.session_id.iloc[0], T, s0, vt[sl].copy(), wt[sl].copy(),
                             va[sl].copy(), dv[sl].copy(), wp[sl].copy()))
    print(f'validation segments: {len(segs)}')

    rows = []
    for sid, T, s0, vt, wt, va, dv, wp in segs:
        v0 = vt[0]
        gx, gy, gh = dead_reckon(vt, wt)
        vaa = v_abs_anchored(va, v0)
        vds = v_delta_stride(dv, v0)
        vdp = v_delta_steps(dv, v0)
        cand = {'REF_abs_anchored': vaa, 'REF_dv_stride': vds, 'REF_dv_steps': vdp}
        for a in ALPHAS:
            cand[f'fixed_a{a:.1f}'] = a * vds + (1 - a) * vaa
        for tau in TAUS:
            cand[f'cf_tau{tau}'] = complementary(dv, vaa, v0, tau)
        for name, v in cand.items():
            x, y, h = dead_reckon(v, wp)
            e = np.hypot(x - gx, y - gy)
            rows.append(dict(config=name, session=sid, outage_s=T, start=s0,
                             final_err=float(e[-1]), traj_rmse=float(np.sqrt(np.mean(e ** 2))),
                             mean_err=float(e.mean()), max_err=float(e.max()),
                             heading_err_deg=float(np.degrees(np.arctan2(
                                 np.sin(h[-1] - gh[-1]), np.cos(h[-1] - gh[-1])))),
                             drift_per_min=float(e[-1] / (T / 60.0)),
                             vel_rmse=float(np.sqrt(np.mean((v - vt) ** 2)))))
    R = pd.DataFrame(rows)
    R.to_csv(os.path.join(OUT, 'phase3_validation_dr.csv'), index=False)

    pd.set_option('display.width', 260)
    piv = R.pivot_table(index='config', columns='outage_s', values='final_err',
                        aggfunc='median').round(2)
    print('\n=== VALIDATION median final position error (m) ===')
    print(piv.to_string())

    # ---- Phase 4 selection: prioritise the whole horizon profile, not one horizon.
    # Rank each configuration at every horizon, then average the ranks. A configuration
    # that wins one horizon but degrades another is penalised automatically.
    cfg = piv.drop(index=[c for c in piv.index if c.startswith('REF_')])
    ranks = cfg.rank(axis=0)
    mean_rank = ranks.mean(axis=1).sort_values()
    ref = piv.loc['REF_abs_anchored']
    rel = (cfg.div(ref, axis=1) - 1) * 100
    print('\n=== mean rank across the five horizons (1 = best) ===')
    print(mean_rank.head(12).round(2).to_string())
    print('\n=== % change vs anchored absolute-v baseline (negative = better) ===')
    print(rel.loc[mean_rank.index[:8]].round(1).to_string())

    best = mean_rank.index[0]
    worst_h = float(rel.loc[best].max())
    sel = dict(selected_config=best,
               mean_rank=float(mean_rank.iloc[0]),
               worst_horizon_change_pct=worst_h,
               median_final_err_by_outage={int(k): float(v) for k, v in cfg.loc[best].items()},
               pct_vs_abs_anchored={int(k): float(v) for k, v in rel.loc[best].items()},
               alphas_tested=ALPHAS, taus_tested=TAUS,
               yaw_source='delta_v model (common to every variant)',
               anchor='ground-truth velocity at outage start (common to every variant)',
               selection_rule='mean rank across 10/30/60/120/300 s on VALIDATION',
               test_used_for_selection=False)
    json.dump(sel, open(os.path.join(HERE, 'frozen_fusion_config.json'), 'w'), indent=2)
    print(f'\nSELECTED (frozen): {best}  mean_rank={mean_rank.iloc[0]:.2f}  '
          f'worst-horizon change {worst_h:+.1f}%')

    for m in ['vel_rmse', 'traj_rmse', 'drift_per_min']:
        R.pivot_table(index='config', columns='outage_s', values=m, aggfunc='median') \
            .round(3).to_csv(os.path.join(OUT, f'phase3_{m}.csv'))


if __name__ == '__main__':
    main()
