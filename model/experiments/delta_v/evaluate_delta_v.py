"""Delta-v test evaluation with anchored dead reckoning.

First and only use of the test split in this experiment. Formulation (k=5) and loss (Huber)
were both chosen on validation.

Fairness note: the dv model is given the true velocity at the start of each outage. To
compare like with like, the baseline absolute-v model is evaluated BOTH as originally
reported and with the SAME anchor information applied as a constant offset correction.
"""
import os, sys, json
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from dv_common import (DS, session_frame, dense, predict, load_ckpt,
                       reconstruct_velocity, dead_reckon, DT)

HERE = os.path.dirname(os.path.abspath(__file__))
BASE_PRED = os.path.join(HERE, '..', '..', 'baseline', 'predictions')
PLOTS = os.path.join(HERE, 'plots'); os.makedirs(PLOTS, exist_ok=True)
PRED = os.path.join(HERE, 'predictions'); os.makedirs(PRED, exist_ok=True)
K = 5
OUTAGES = [10, 30, 60, 120, 300]
STEP_S = 30


def m2(y, p, names):
    o = {}
    for i, n in enumerate(names):
        e = p[:, i] - y[:, i]
        ss = np.sum((y[:, i] - y[:, i].mean()) ** 2)
        o[n] = dict(MAE=float(np.mean(np.abs(e))), RMSE=float(np.sqrt(np.mean(e ** 2))),
                    R2=float(1 - np.sum(e ** 2) / ss), mean_error=float(e.mean()),
                    std_error=float(e.std()), n=int(len(y)))
    return o


def main():
    res = {}
    model, ck = load_ckpt(os.path.join(HERE, 'checkpoints', f'best_k{K}_huber.pt'))
    tmu, tsd = ck['target_mean'], ck['target_std']
    res['model'] = dict(k=K, loss='huber', best_epoch=int(ck['epoch']),
                        n_params=int(ck['n_params']),
                        val_r2_dv=float(ck['val_r2_dv']), val_r2_yaw=float(ck['val_r2_yaw']))

    # ---- windowed test metrics
    X = np.load(os.path.join(DS, 'test', 'X_test.npy'))
    t = pd.read_parquet(os.path.join(HERE, 'targets', 'dv_targets_test.parquet'))
    m = t[f'dv{K}_valid'].to_numpy(bool)
    y = np.c_[t[f'dv{K}'].to_numpy(float), t['yaw_rate'].to_numpy(float)][m]
    P = predict(model, X[m], tmu, tsd)
    res['test_metrics'] = m2(y, P, ['dv5', 'yaw_rate'])
    pd.DataFrame({'dv5_true': y[:, 0], 'dv5_pred': P[:, 0],
                  'yaw_true': y[:, 1], 'yaw_pred': P[:, 1]}).to_csv(
        os.path.join(PRED, 'predictions_test.csv'), index=False)

    # ---- dense predictions + anchored dead reckoning
    man = pd.read_csv(os.path.join(DS, 'split_manifest.csv'))
    sess = man[man.split == 'test'][['session_id', 'dataset_id']].values.tolist()
    rows, store = [], {}
    for sid, ds in sess:
        S = session_frame(ds, sid)
        Xd, ends, ok = dense(S)
        Pd = predict(model, Xd, tmu, tsd)
        gv = S.target_v_forward.to_numpy(float)[ends]
        gw = S.target_yaw_rate.to_numpy(float)[ends]
        bl = pd.read_parquet(os.path.join(BASE_PRED, f'dense_{sid}.parquet'))
        n = min(len(Pd), len(bl))
        d = pd.DataFrame({'session_id': sid, 'timestamp_s': S.timestamp_s.to_numpy(float)[ends][:n],
                          'gv': gv[:n], 'gw': gw[:n], 'ok': ok[:n],
                          'dv_pred': Pd[:n, 0], 'yaw_pred_dv': Pd[:n, 1],
                          'base_v': bl.p_v.to_numpy()[:n], 'base_yaw': bl.p_yaw.to_numpy()[:n],
                          'base_ok': bl.valid.to_numpy()[:n]})
        d.to_parquet(os.path.join(PRED, f'dense_{sid}.parquet'), index=False)
        store[sid] = d

        for T in OUTAGES:
            L = int(T / DT)
            for s0 in range(0, len(d) - L, int(STEP_S / DT)):
                sl = slice(s0, s0 + L)
                if not (d.ok.values[sl].all() and d.base_ok.values[sl].all()):
                    continue
                gvs, gws = d.gv.values[sl], d.gw.values[sl]
                v0 = gvs[0]
                gx, gy, gh = dead_reckon(gvs, gws)
                dist = float(np.sum(gvs * DT))
                v_dv = reconstruct_velocity(d.dv_pred.values[sl], K, v0, 'stride')
                bv = d.base_v.values[sl]
                variants = {
                    'A_baseline_raw': (bv, d.base_yaw.values[sl]),
                    'A2_baseline_anchored': (np.maximum(bv - (bv[0] - v0), 0.0),
                                             d.base_yaw.values[sl]),
                    'B_deltav_anchored': (v_dv, d.yaw_pred_dv.values[sl]),
                    'C_oracle_v_pred_yaw': (gvs, d.yaw_pred_dv.values[sl]),
                    'D_pred_v_oracle_yaw': (v_dv, gws)}
                for name, (vv, ww) in variants.items():
                    x, yy, h = dead_reckon(vv, ww)
                    e = np.hypot(x - gx, yy - gy)
                    rows.append(dict(session_id=sid, outage_s=T, start=s0, variant=name,
                                     distance_m=dist,
                                     final_err=float(e[-1]), mean_err=float(e.mean()),
                                     max_err=float(e.max()),
                                     traj_rmse=float(np.sqrt(np.mean(e ** 2))),
                                     heading_err_deg=float(np.degrees(np.arctan2(
                                         np.sin(h[-1] - gh[-1]), np.cos(h[-1] - gh[-1])))),
                                     drift_per_min=float(e[-1] / (T / 60.0)),
                                     vel_rmse=float(np.sqrt(np.mean((vv - gvs) ** 2)))))
        print(f'  {sid}: dense {len(d)}', flush=True)

    DR = pd.DataFrame(rows)
    DR.to_csv(os.path.join(PRED, 'dead_reckoning_outages.csv'), index=False)
    agg = DR.groupby(['variant', 'outage_s']).agg(
        n=('final_err', 'size'), median_final_err=('final_err', 'median'),
        mean_final_err=('final_err', 'mean'),
        p90_final_err=('final_err', lambda s: s.quantile(.9)),
        median_traj_rmse=('traj_rmse', 'median'), median_mean_err=('mean_err', 'median'),
        median_max_err=('max_err', 'median'),
        median_abs_heading_err=('heading_err_deg', lambda s: s.abs().median()),
        median_drift_per_min=('drift_per_min', 'median'),
        median_vel_rmse=('vel_rmse', 'median'),
        median_distance_m=('distance_m', 'median')).round(3).reset_index()
    agg.to_csv(os.path.join(PRED, 'dead_reckoning_summary.csv'), index=False)
    res['dead_reckoning'] = agg.to_dict('records')

    pd.set_option('display.width', 250)
    piv = DR.pivot_table(index='outage_s', columns='variant', values='final_err',
                         aggfunc='median').round(2)
    print('\n=== TEST median final position error (m) ===')
    print(piv.to_string())
    res['comparison_median_final_err'] = piv.to_dict()

    # ---- plots
    for sid, d in store.items():
        for T in [60, 300]:
            L = int(T / DT)
            cand = [s for s in range(0, len(d) - L, int(STEP_S / DT))
                    if d.ok.values[s:s + L].all() and d.base_ok.values[s:s + L].all()]
            if not cand:
                continue
            s0 = cand[len(cand) // 2]
            sl = slice(s0, s0 + L)
            gvs, gws = d.gv.values[sl], d.gw.values[sl]
            gx, gy, _ = dead_reckon(gvs, gws)
            v_dv = reconstruct_velocity(d.dv_pred.values[sl], K, gvs[0], 'stride')
            bx, by, _ = dead_reckon(d.base_v.values[sl], d.base_yaw.values[sl])
            dx, dy, _ = dead_reckon(v_dv, d.yaw_pred_dv.values[sl])
            fig, ax = plt.subplots(1, 3, figsize=(17, 5))
            ax[0].plot(gx, gy, lw=2, label='ground truth')
            ax[0].plot(bx, by, '--', lw=1.8, label='baseline (absolute v)')
            ax[0].plot(dx, dy, '-.', lw=1.8, label='delta-v (anchored)')
            ax[0].scatter([0], [0], c='k', s=40, zorder=5)
            ax[0].set_aspect('equal'); ax[0].legend(); ax[0].grid(alpha=.3)
            ax[0].set_title(f'{sid} — {T}s outage'); ax[0].set_xlabel('x (m)'); ax[0].set_ylabel('y (m)')
            tt = np.arange(L) * DT
            ax[1].plot(tt, np.hypot(bx - gx, by - gy), '--', label='baseline')
            ax[1].plot(tt, np.hypot(dx - gx, dy - gy), '-.', label='delta-v')
            ax[1].set_xlabel('time into outage (s)'); ax[1].set_ylabel('position error (m)')
            ax[1].legend(); ax[1].grid(alpha=.3); ax[1].set_title('error growth')
            ax[2].plot(tt, gvs, lw=2, label='true v')
            ax[2].plot(tt, d.base_v.values[sl], '--', label='baseline v')
            ax[2].plot(tt, v_dv, '-.', label='delta-v reconstructed v')
            ax[2].set_xlabel('time into outage (s)'); ax[2].set_ylabel('v_forward (m/s)')
            ax[2].legend(); ax[2].grid(alpha=.3); ax[2].set_title('velocity')
            fig.tight_layout()
            fig.savefig(os.path.join(PLOTS, f'trajectory_{sid}_{T}s.png'), dpi=120)
            plt.close(fig)

    fig, ax = plt.subplots(figsize=(7.5, 5))
    for vname in ['A_baseline_raw', 'A2_baseline_anchored', 'B_deltav_anchored']:
        s = piv[vname]
        ax.plot(s.index, s.values, marker='o', label=vname)
    ax.set_xlabel('outage duration (s)'); ax.set_ylabel('median final position error (m)')
    ax.set_xscale('log'); ax.set_yscale('log'); ax.grid(alpha=.3, which='both'); ax.legend()
    ax.set_title('Dead-reckoning drift — test (unseen driver B)')
    fig.tight_layout(); fig.savefig(os.path.join(PLOTS, 'drift_comparison.png'), dpi=120)
    plt.close(fig)

    res['test_used_for_selection'] = False
    json.dump(res, open(os.path.join(HERE, 'metrics.json'), 'w'), indent=2, default=float)
    print('\nwrote metrics.json')


if __name__ == '__main__':
    main()
