"""Phases 5-6: final test evaluation of the FROZEN fusion configuration, plus attribution.

Runs once. The fusion family, the grid, the selection rule and the selected parameter were
all fixed on validation before this script was executed (frozen_fusion_config.json).
"""
import os, json
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from phase2_4_fusion_select import (dead_reckon, v_delta_stride, v_abs_anchored,
                                    complementary, K, DT, OUTAGES, STEP_S)

HERE = os.path.dirname(os.path.abspath(__file__))
DENSE = os.path.join(HERE, 'predictions', 'dense', 'test')
RES = os.path.join(HERE, 'test_results'); os.makedirs(RES, exist_ok=True)
PLOTS = os.path.join(HERE, 'plots'); os.makedirs(PLOTS, exist_ok=True)

FROZEN = json.load(open(os.path.join(HERE, 'frozen_fusion_config.json')))
SEL = FROZEN['selected_config']
assert SEL.startswith('cf_tau'), SEL
TAU = float(SEL.replace('cf_tau', ''))
print(f'frozen configuration: {SEL}  (complementary filter, tau = {TAU} s)')


def yaw_metrics(y, p):
    e = p - y
    ss = np.sum((y - y.mean()) ** 2)
    return dict(MAE=float(np.mean(np.abs(e))), RMSE=float(np.sqrt(np.mean(e ** 2))),
                R2=float(1 - np.sum(e ** 2) / ss), mean_error=float(e.mean()),
                n=int(len(y)))


def main():
    frames = {f[:-8]: pd.read_parquet(os.path.join(DENSE, f))
              for f in sorted(os.listdir(DENSE))}
    res = {'frozen': FROZEN}

    # ---- yaw-rate quality of the two frozen heads, on dense test data
    allok = pd.concat([d[d.ok] for d in frames.values()])
    res['yaw_metrics'] = {
        'baseline_head': yaw_metrics(allok.yaw_true.to_numpy(float),
                                     allok.yaw_pred_base.to_numpy(float)),
        'delta_v_head': yaw_metrics(allok.yaw_true.to_numpy(float),
                                    allok.yaw_pred_dv.to_numpy(float))}

    rows = []
    for sid, d in frames.items():
        ok = d.ok.to_numpy()
        vt, wt = d.v_true.to_numpy(float), d.yaw_true.to_numpy(float)
        va, dv = d.v_abs_pred.to_numpy(float), d.dv_pred.to_numpy(float)
        wb, wp = d.yaw_pred_base.to_numpy(float), d.yaw_pred_dv.to_numpy(float)
        for T in OUTAGES:
            L = int(T / DT)
            for s0 in range(0, len(d) - L, int(STEP_S / DT)):
                sl = slice(s0, s0 + L)
                if not ok[sl].all():
                    continue
                v0 = vt[s0]
                gx, gy, gh = dead_reckon(vt[sl], wt[sl])
                dist = float(np.sum(vt[sl] * DT))
                vaa = v_abs_anchored(va[sl], v0)
                vds = v_delta_stride(dv[sl], v0)
                vf = complementary(dv[sl], vaa, v0, TAU)
                variants = {
                    # as originally frozen in experiments 1 and 2 (own yaw head)
                    'baseline_as_frozen': (va[sl], wb[sl]),
                    'deltav_as_frozen': (vds, wp[sl]),
                    # controlled: same anchor AND same yaw for every velocity estimator
                    'ctl_baseline_anchored': (vaa, wp[sl]),
                    'ctl_deltav': (vds, wp[sl]),
                    'ctl_FUSED': (vf, wp[sl]),
                    # Phase 6 attribution
                    'attr_fused_v_oracle_yaw': (vf, wt[sl]),
                    'attr_oracle_v_pred_yaw': (vt[sl], wp[sl]),
                    'attr_fused_v_debiased': (vf - np.mean(vf - vt[sl]), wp[sl])}
                for name, (vv, ww) in variants.items():
                    x, y, h = dead_reckon(vv, ww)
                    e = np.hypot(x - gx, y - gy)
                    rows.append(dict(variant=name, session=sid, outage_s=T, start=s0,
                                     distance_m=dist, final_err=float(e[-1]),
                                     traj_rmse=float(np.sqrt(np.mean(e ** 2))),
                                     mean_err=float(e.mean()), max_err=float(e.max()),
                                     heading_err_deg=float(np.degrees(np.arctan2(
                                         np.sin(h[-1] - gh[-1]), np.cos(h[-1] - gh[-1])))),
                                     drift_per_min=float(e[-1] / (T / 60.0)),
                                     vel_rmse=float(np.sqrt(np.mean((vv - vt[sl]) ** 2)))))
        print(f'  {sid}: done', flush=True)

    R = pd.DataFrame(rows)
    R.to_csv(os.path.join(RES, 'test_dead_reckoning.csv'), index=False)
    agg = R.groupby(['variant', 'outage_s']).agg(
        n=('final_err', 'size'),
        median_final_err=('final_err', 'median'), mean_final_err=('final_err', 'mean'),
        p90_final_err=('final_err', lambda s: s.quantile(.9)),
        median_traj_rmse=('traj_rmse', 'median'), median_mean_err=('mean_err', 'median'),
        median_abs_heading_err=('heading_err_deg', lambda s: s.abs().median()),
        median_drift_per_min=('drift_per_min', 'median'),
        median_vel_rmse=('vel_rmse', 'median'),
        median_distance_m=('distance_m', 'median')).round(3).reset_index()
    agg.to_csv(os.path.join(RES, 'test_summary.csv'), index=False)
    res['test_summary'] = agg.to_dict('records')

    pd.set_option('display.width', 260)
    piv = R.pivot_table(index='variant', columns='outage_s', values='final_err',
                        aggfunc='median').round(2)
    print('\n=== TEST median final position error (m) ===')
    print(piv.to_string())

    base = piv.loc['baseline_as_frozen']
    ctl = piv.loc['ctl_baseline_anchored']
    print('\n=== % change vs baseline_as_frozen (negative = better) ===')
    print(((piv.loc[['deltav_as_frozen', 'ctl_baseline_anchored', 'ctl_deltav', 'ctl_FUSED']]
            .div(base, axis=1) - 1) * 100).round(1).to_string())
    print('\n=== % change vs ctl_baseline_anchored (controlled: same anchor + same yaw) ===')
    print(((piv.loc[['ctl_deltav', 'ctl_FUSED']].div(ctl, axis=1) - 1) * 100).round(1).to_string())
    res['pct_vs_baseline_as_frozen'] = (((piv.div(base, axis=1) - 1) * 100).round(2)).to_dict()
    res['pct_vs_ctl_baseline'] = (((piv.div(ctl, axis=1) - 1) * 100).round(2)).to_dict()

    print('\n=== median velocity RMSE (m/s) ===')
    print(R.pivot_table(index='variant', columns='outage_s', values='vel_rmse',
                        aggfunc='median').round(3).to_string())
    print('\n=== median |heading error| (deg) ===')
    print(R.pivot_table(index='variant', columns='outage_s', values='heading_err_deg',
                        aggfunc=lambda s: s.abs().median()).round(2).to_string())

    # ---- plots
    fig, ax = plt.subplots(figsize=(7.5, 5))
    for v, lab in [('ctl_baseline_anchored', 'absolute-v (anchored)'),
                   ('ctl_deltav', 'delta-v'), ('ctl_FUSED', f'FUSED ({SEL})')]:
        ax.plot(piv.columns, piv.loc[v].values, marker='o', label=lab)
    ax.set_xscale('log'); ax.set_yscale('log'); ax.grid(alpha=.3, which='both')
    ax.set_xlabel('outage duration (s)'); ax.set_ylabel('median final position error (m)')
    ax.legend(); ax.set_title('Test (unseen driver B) — common anchor and yaw')
    fig.tight_layout(); fig.savefig(os.path.join(PLOTS, 'drift_comparison_test.png'), dpi=120)
    plt.close(fig)

    for sid, d in frames.items():
        for T in [60, 300]:
            L = int(T / DT)
            cand = [s for s in range(0, len(d) - L, int(STEP_S / DT))
                    if d.ok.values[s:s + L].all()]
            if not cand:
                continue
            s0 = cand[len(cand) // 2]
            sl = slice(s0, s0 + L)
            vt, wt = d.v_true.to_numpy(float)[sl], d.yaw_true.to_numpy(float)[sl]
            v0 = vt[0]
            vaa = v_abs_anchored(d.v_abs_pred.to_numpy(float)[sl], v0)
            vds = v_delta_stride(d.dv_pred.to_numpy(float)[sl], v0)
            vf = complementary(d.dv_pred.to_numpy(float)[sl], vaa, v0, TAU)
            wp = d.yaw_pred_dv.to_numpy(float)[sl]
            gx, gy, _ = dead_reckon(vt, wt)
            fig, ax = plt.subplots(1, 3, figsize=(17, 5))
            for v, lab, st in [(vaa, 'absolute-v', '--'), (vds, 'delta-v', '-.'),
                               (vf, 'FUSED', ':')]:
                x, y, _ = dead_reckon(v, wp)
                ax[0].plot(x, y, st, lw=1.8, label=lab)
                ax[1].plot(np.arange(L) * DT, np.hypot(x - gx, y - gy), st, label=lab)
                ax[2].plot(np.arange(L) * DT, v, st, label=lab)
            ax[0].plot(gx, gy, 'k', lw=2, label='ground truth')
            ax[0].set_aspect('equal'); ax[0].legend(); ax[0].grid(alpha=.3)
            ax[0].set_title(f'{sid} — {T}s outage'); ax[0].set_xlabel('x (m)'); ax[0].set_ylabel('y (m)')
            ax[1].set_xlabel('time into outage (s)'); ax[1].set_ylabel('position error (m)')
            ax[1].legend(); ax[1].grid(alpha=.3); ax[1].set_title('error growth')
            ax[2].plot(np.arange(L) * DT, vt, 'k', lw=2, label='true v')
            ax[2].set_xlabel('time into outage (s)'); ax[2].set_ylabel('v (m/s)')
            ax[2].legend(); ax[2].grid(alpha=.3); ax[2].set_title('velocity')
            fig.tight_layout()
            fig.savefig(os.path.join(PLOTS, f'test_traj_{sid}_{T}s.png'), dpi=120)
            plt.close(fig)

    res['test_used_for_selection'] = False
    json.dump(res, open(os.path.join(RES, 'metrics.json'), 'w'), indent=2, default=float)
    print('\nwrote test_results/metrics.json')


if __name__ == '__main__':
    main()
