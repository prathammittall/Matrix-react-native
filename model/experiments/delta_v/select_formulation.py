"""Select the dv horizon using VALIDATION only.

Selection is not made on raw loss. It is made on the downstream quantity that matters:
how well an anchored velocity reconstruction plus predicted yaw reproduces the trajectory
over a simulated GNSS outage, measured on the validation sessions.
"""
import os, json
import numpy as np
import pandas as pd
from dv_common import (DS, session_frame, dense, predict, load_ckpt,
                       reconstruct_velocity, dead_reckon, DT)

HERE = os.path.dirname(os.path.abspath(__file__))
KS = [1, 5, 10]
OUTAGES = [10, 30, 60, 120, 300]   # longest validation session is 2462 s
STEP_S = 30


def main():
    man = pd.read_csv(os.path.join(DS, 'split_manifest.csv'))
    sess = man[man.split == 'validation'][['session_id', 'dataset_id']].values.tolist()
    tgt_tr = pd.read_parquet(os.path.join(HERE, 'targets', 'dv_targets_train.parquet'))

    rows = []
    for k in KS:
        model, ck = load_ckpt(os.path.join(HERE, 'checkpoints', f'best_k{k}_huber.pt'))
        tmu, tsd = ck['target_mean'], ck['target_std']
        # clip bounds taken from the TRAIN distribution only
        d_tr = tgt_tr[f'dv{k}'].to_numpy(float)[tgt_tr[f'dv{k}_valid'].to_numpy(bool)]
        clip = (float(np.percentile(d_tr, 0.1)), float(np.percentile(d_tr, 99.9)))
        for sid, ds in sess:
            S = session_frame(ds, sid)
            X, ends, ok = dense(S)
            P = predict(model, X, tmu, tsd)
            gv = S.target_v_forward.to_numpy(float)[ends]
            gw = S.target_yaw_rate.to_numpy(float)[ends]
            for T in OUTAGES:
                L = int(T / DT)
                for s0 in range(0, len(P) - L, int(STEP_S / DT)):
                    sl = slice(s0, s0 + L)
                    if not ok[sl].all():
                        continue
                    v0 = gv[s0]
                    gx, gy, _ = dead_reckon(gv[sl], gw[sl])
                    for meth in ['accel', 'stride']:
                        for cl, cname in [(None, 'raw'), (clip, 'clipped')]:
                            v = reconstruct_velocity(P[sl, 0], k, v0, meth, cl)
                            x, y, _ = dead_reckon(v, P[sl, 1])
                            e = np.hypot(x - gx, y - gy)
                            rows.append(dict(k=k, session=sid, outage_s=T, method=meth,
                                             clip=cname,
                                             vel_rmse=float(np.sqrt(np.mean((v - gv[sl]) ** 2))),
                                             vel_final_err=float(v[-1] - gv[sl][-1]),
                                             final_err=float(e[-1]),
                                             traj_rmse=float(np.sqrt(np.mean(e ** 2)))))
        print(f'  k={k} done', flush=True)

    R = pd.DataFrame(rows)
    R.to_csv(os.path.join(HERE, 'formulation_validation_dr.csv'), index=False)
    pd.set_option('display.width', 250)
    piv = R.groupby(['k', 'method', 'clip', 'outage_s']).agg(
        n=('final_err', 'size'),
        median_final_err=('final_err', 'median'),
        median_traj_rmse=('traj_rmse', 'median'),
        median_vel_rmse=('vel_rmse', 'median')).round(2).reset_index()
    print('\n=== VALIDATION anchored dead reckoning by formulation ===')
    print(piv.to_string(index=False))

    sub = R[(R.method == 'accel') & (R.clip == 'raw')]
    best = sub.groupby('k')['final_err'].median().sort_values()
    print('\nmedian final error across all validation outages (accel/raw):')
    print(best.round(2).to_string())
    json.dump({'validation_median_final_err_by_k': {int(k): float(v) for k, v in best.items()}},
              open(os.path.join(HERE, 'formulation_selection.json'), 'w'), indent=2)


if __name__ == '__main__':
    main()
