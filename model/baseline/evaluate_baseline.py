"""MATRIX Phase 1 evaluation: test metrics, regime breakdowns, and 2-D dead reckoning.

The test split is touched here for the FIRST time. Model selection happened entirely on
validation (see loss_comparison.json).

Dead reckoning needs a prediction at every 10 Hz step, so dense stride-1 windows are built
over the same two test sessions. This adds no new sessions and no leakage - it is the same
held-out data evaluated more finely than the stride-50 metric set.
"""
import os, json
import numpy as np
import pandas as pd
import torch
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from train_baseline import MatrixBaseline, set_seed, SEED, DEVICE

HERE = os.path.dirname(os.path.abspath(__file__))
PRE = os.path.join(HERE, '..', 'preprocessing')
DS = os.path.join(PRE, 'training_dataset', 'core')
CORE = os.path.join(PRE, 'smartphone_core')
TGT = os.path.join(PRE, 'targets')
OUTP = os.path.join(HERE, 'predictions'); os.makedirs(OUTP, exist_ok=True)
PLOTS = os.path.join(HERE, 'plots'); os.makedirs(PLOTS, exist_ok=True)
W, DT = 50, 0.1
FEATS = ['acc_x', 'acc_y', 'acc_z', 'gyro_x', 'gyro_y', 'gyro_z']
G = 9.80665

sc = json.load(open(os.path.join(DS, 'scaler', 'scaler.json')))
FMU = np.array(sc['feature_mean'][:6], np.float32); FSD = np.array(sc['feature_std'][:6], np.float32)
TMU = np.array(sc['target_mean'], np.float32); TSD = np.array(sc['target_std'], np.float32)
cal = pd.read_csv(os.path.join(PRE, 'outputs', 'calibration_bias.csv')).set_index('dataset_id')


def load_model():
    comp = json.load(open(os.path.join(HERE, 'loss_comparison.json')))
    best = comp['selected']
    ck = torch.load(os.path.join(HERE, 'checkpoints', f'best_{best}.pt'),
                    map_location=DEVICE, weights_only=False)
    m = MatrixBaseline().to(DEVICE); m.load_state_dict(ck['model']); m.eval()
    return m, best, ck, comp


@torch.no_grad()
def predict(model, X):
    P = []
    for i in range(0, len(X), 1024):
        xb = torch.from_numpy(((X[i:i + 1024] - FMU) / FSD).astype(np.float32)).to(DEVICE)
        P.append(model(xb).cpu().numpy())
    return np.concatenate(P) * TSD + TMU


def metrics(y, p, label):
    e = p - y
    out = {}
    for i, n in enumerate(['v_forward', 'yaw_rate']):
        ss = np.sum((y[:, i] - y[:, i].mean()) ** 2)
        out[n] = dict(
            MAE=float(np.mean(np.abs(e[:, i]))),
            RMSE=float(np.sqrt(np.mean(e[:, i] ** 2))),
            R2=float(1 - np.sum(e[:, i] ** 2) / ss) if ss > 0 else float('nan'),
            mean_error=float(e[:, i].mean()), std_error=float(e[:, i].std()),
            n=int(len(y)))
    out['_label'] = label
    return out


def session_frame(ds, sess):
    S = pd.read_parquet(os.path.join(CORE, f'{ds}.parquet'))
    S = S[S.session_id == sess].sort_values(['timestamp_s', 'row_index_original'])
    T = pd.read_parquet(os.path.join(TGT, f'{sess}.parquet'))
    S = S.merge(T[['row_index_original', 'target_v_forward', 'target_yaw_rate',
                   'target_valid', 'target_source', 'target_confidence']],
                on='row_index_original', how='left')
    if ds in cal.index and pd.notna(cal.loc[ds].get('gyro_bias_x', np.nan)):
        r = cal.loc[ds]
        gb = np.nan_to_num(np.array([float(r[f'gyro_bias_{a}']) for a in 'xyz']))
        ab = np.nan_to_num(np.array([float(r[f'acc_bias_{a}']) for a in 'xyz']))
    else:
        gb = ab = np.zeros(3)
    for i, a in enumerate('xyz'):
        S[f'acc_{a}'] = S[f'acc_{a}'].to_numpy(float) - ab[i]
        S[f'gyro_{a}'] = S[f'gyro_{a}'].to_numpy(float) - gb[i]
    return S


def dense_windows(S):
    """stride-1 causal windows; returns X, end-index array, validity mask."""
    F = S[FEATS].to_numpy(np.float32)
    n = len(F)
    ends = np.arange(W - 1, n)
    idx = ends[:, None] + np.arange(-W + 1, 1)[None, :]
    X = F[idx]
    tv = S.target_valid.fillna(False).to_numpy(bool)
    conf = S.target_confidence.fillna('none').to_numpy()
    t = S.timestamp_s.to_numpy(float)
    span = t[ends] - t[ends - W + 1]
    finite = np.isfinite(X).reshape(len(X), -1).all(1)
    ok = (tv[ends] & (conf[ends] == 'high') & finite
          & (np.abs(span - (W - 1) * DT) < 0.1 * (W - 1) * DT))
    return X, ends, ok


def dead_reckon(v, yaw, dt=DT, x0=0.0, y0=0.0, h0=0.0):
    """Midpoint integration of forward speed + yaw rate into a 2-D track."""
    h = h0 + np.cumsum(yaw * dt)
    hm = np.concatenate([[h0], h[:-1]]) + yaw * dt / 2.0     # midpoint heading
    x = x0 + np.cumsum(v * np.cos(hm) * dt)
    y = y0 + np.cumsum(v * np.sin(hm) * dt)
    return x, y, h


def main():
    set_seed(SEED)
    model, best_loss, ck, comp = load_model()
    print('selected loss:', best_loss, '| best epoch', ck['epoch'], '| params', ck['n_params'])
    res = {'selected_loss': best_loss, 'best_epoch': int(ck['epoch']),
           'best_val_loss': float(ck['val_loss']), 'n_params': int(ck['n_params']),
           'loss_comparison': comp}

    # ---------------- windowed test metrics ----------------
    for tag, sub in [('val', 'validation'), ('test', 'test')]:
        X = np.load(os.path.join(DS, sub, f'X_{tag}.npy'))
        y = np.load(os.path.join(DS, sub, f'y_{tag}.npy'))
        p = predict(model, X)
        res[f'{tag}_metrics'] = metrics(y, p, tag)
        md = pd.read_parquet(os.path.join(DS, 'metadata', f'metadata_{tag}.parquet'))
        pd.DataFrame({'session_id': md.session_id, 'end_timestamp': md.end_timestamp,
                      'y_v_forward': y[:, 0], 'y_yaw_rate': y[:, 1],
                      'p_v_forward': p[:, 0], 'p_yaw_rate': p[:, 1]}).to_csv(
            os.path.join(OUTP, f'predictions_{tag}.csv'), index=False)
        if tag == 'test':
            yt, pt = y, p

    # ---------------- regime breakdowns (test) ----------------
    v, yaw = yt[:, 0], np.abs(yt[:, 1])
    regimes = {
        'speed_low_0_5ms': v < 5, 'speed_med_5_15ms': (v >= 5) & (v < 15),
        'speed_high_ge15ms': v >= 15,
        'yaw_low_lt0p05': yaw < 0.05, 'yaw_high_ge0p05': yaw >= 0.05}
    res['test_regimes'] = {k: metrics(yt[m], pt[m], k) for k, m in regimes.items()
                           if m.sum() > 10}

    # ---------------- dense predictions + dead reckoning ----------------
    man = pd.read_csv(os.path.join(DS, 'split_manifest.csv'))
    test_sess = man[man.split == 'test'][['session_id', 'dataset_id']].values.tolist()
    dr_rows, traj_store = [], {}
    for sess, ds in test_sess:
        S = session_frame(ds, sess)
        X, ends, ok = dense_windows(S)
        P = predict(model, X)
        yv = S.target_v_forward.to_numpy(float)[ends]
        yw = S.target_yaw_rate.to_numpy(float)[ends]
        df = pd.DataFrame({'session_id': sess, 'end_row': ends,
                           'timestamp_s': S.timestamp_s.to_numpy(float)[ends],
                           'y_v': yv, 'y_yaw': yw, 'p_v': P[:, 0], 'p_yaw': P[:, 1],
                           'valid': ok})
        df.to_parquet(os.path.join(OUTP, f'dense_{sess}.parquet'), index=False)
        traj_store[sess] = df
        # longest fully-valid run
        g = (~df.valid).cumsum()
        run = df[df.valid].groupby(g).size()
        print(f'  {sess}: dense {len(df)} valid {int(ok.sum())} longest run {int(run.max())}')

        for T in [10, 30, 60, 120, 300]:
            L = int(T / DT)
            starts = np.arange(0, len(df) - L, int(30 / DT))   # a new outage every 30 s
            for s0 in starts:
                sl = slice(s0, s0 + L)
                if not df.valid.values[sl].all():
                    continue
                pv, pw = df.p_v.values[sl], df.p_yaw.values[sl]
                gv, gw = df.y_v.values[sl], df.y_yaw.values[sl]
                px, py, ph = dead_reckon(pv, pw)
                gx, gy, gh = dead_reckon(gv, gw)
                err = np.hypot(px - gx, py - gy)
                dist = float(np.sum(gv * DT))
                dr_rows.append(dict(
                    session_id=sess, outage_s=T, start_index=int(s0),
                    distance_travelled_m=round(dist, 2),
                    final_position_error_m=round(float(err[-1]), 3),
                    mean_position_error_m=round(float(err.mean()), 3),
                    max_position_error_m=round(float(err.max()), 3),
                    trajectory_rmse_m=round(float(np.sqrt(np.mean(err ** 2))), 3),
                    heading_error_deg=round(float(np.degrees(
                        np.arctan2(np.sin(ph[-1] - gh[-1]), np.cos(ph[-1] - gh[-1])))), 3),
                    drift_per_minute_m=round(float(err[-1] / (T / 60.0)), 3),
                    final_error_pct_distance=round(100 * float(err[-1]) / dist, 3)
                    if dist > 1 else np.nan))
    DR = pd.DataFrame(dr_rows)
    DR.to_csv(os.path.join(OUTP, 'dead_reckoning_outages.csv'), index=False)

    agg = DR.groupby('outage_s').agg(
        n_segments=('final_position_error_m', 'size'),
        median_final_err_m=('final_position_error_m', 'median'),
        mean_final_err_m=('final_position_error_m', 'mean'),
        p90_final_err_m=('final_position_error_m', lambda s: s.quantile(0.9)),
        max_final_err_m=('final_position_error_m', 'max'),
        median_traj_rmse_m=('trajectory_rmse_m', 'median'),
        median_mean_err_m=('mean_position_error_m', 'median'),
        median_max_err_m=('max_position_error_m', 'median'),
        median_abs_heading_err_deg=('heading_error_deg', lambda s: s.abs().median()),
        median_drift_per_min_m=('drift_per_minute_m', 'median'),
        median_dist_m=('distance_travelled_m', 'median'),
        median_err_pct_dist=('final_error_pct_distance', 'median')).round(3).reset_index()
    agg.to_csv(os.path.join(OUTP, 'dead_reckoning_summary.csv'), index=False)
    res['dead_reckoning'] = agg.to_dict('records')
    print('\n', agg.to_string(index=False))

    # ---------------- plots ----------------
    for sess, df in traj_store.items():
        for T in [60, 300]:
            L = int(T / DT)
            cand = [s for s in range(0, len(df) - L, int(30 / DT))
                    if df.valid.values[s:s + L].all()]
            if not cand:
                continue
            s0 = cand[len(cand) // 2]
            sl = slice(s0, s0 + L)
            px, py, _ = dead_reckon(df.p_v.values[sl], df.p_yaw.values[sl])
            gx, gy, _ = dead_reckon(df.y_v.values[sl], df.y_yaw.values[sl])
            fig, ax = plt.subplots(1, 2, figsize=(12, 5))
            ax[0].plot(gx, gy, label='ground truth (VBOX)', lw=2)
            ax[0].plot(px, py, '--', label='dead reckoning (predicted)', lw=2)
            ax[0].scatter([0], [0], c='k', s=40, zorder=5, label='start')
            ax[0].set_aspect('equal'); ax[0].legend(); ax[0].grid(alpha=.3)
            ax[0].set_title(f'{sess} — {T}s GNSS outage'); ax[0].set_xlabel('x (m)'); ax[0].set_ylabel('y (m)')
            ax[1].plot(np.arange(L) * DT, np.hypot(px - gx, py - gy))
            ax[1].set_xlabel('time into outage (s)'); ax[1].set_ylabel('position error (m)')
            ax[1].grid(alpha=.3); ax[1].set_title('error growth')
            fig.tight_layout()
            fig.savefig(os.path.join(PLOTS, f'trajectory_{sess}_{T}s.png'), dpi=120)
            plt.close(fig)

    # prediction scatter / timeseries
    fig, ax = plt.subplots(1, 2, figsize=(12, 5))
    ax[0].scatter(yt[:, 0], pt[:, 0], s=4, alpha=.3)
    lim = [0, max(yt[:, 0].max(), pt[:, 0].max())]
    ax[0].plot(lim, lim, 'k--'); ax[0].set_xlabel('true v_forward (m/s)')
    ax[0].set_ylabel('predicted'); ax[0].set_title('v_forward (test)'); ax[0].grid(alpha=.3)
    ax[1].scatter(yt[:, 1], pt[:, 1], s=4, alpha=.3)
    lim = [yt[:, 1].min(), yt[:, 1].max()]
    ax[1].plot(lim, lim, 'k--'); ax[1].set_xlabel('true yaw_rate (rad/s)')
    ax[1].set_ylabel('predicted'); ax[1].set_title('yaw_rate (test)'); ax[1].grid(alpha=.3)
    fig.tight_layout(); fig.savefig(os.path.join(PLOTS, 'predictions_test.png'), dpi=120)
    plt.close(fig)

    h = pd.read_csv(os.path.join(HERE, 'training_history.csv'))
    fig, ax = plt.subplots(figsize=(7, 4.5))
    for ln, g in h.groupby('loss_fn'):
        ax.plot(g.epoch, g.val_nrmse, label=f'{ln} (val nRMSE)')
    ax.set_xlabel('epoch'); ax.set_ylabel('validation nRMSE'); ax.legend(); ax.grid(alpha=.3)
    ax.set_title('loss comparison — selection on validation only')
    fig.tight_layout(); fig.savefig(os.path.join(PLOTS, 'training_curves.png'), dpi=120)
    plt.close(fig)

    res['test_used_for_selection'] = False
    json.dump(res, open(os.path.join(HERE, 'metrics.json'), 'w'), indent=2, default=float)
    print('\nwrote metrics.json')


if __name__ == '__main__':
    main()
