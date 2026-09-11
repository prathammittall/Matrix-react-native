"""Phase 1: characterise the velocity errors of the two frozen estimators.

Tests the hypothesis motivating fusion:
  (A) absolute-v error is low-frequency / systematic  -> slow autocorrelation decay,
      power concentrated near DC, error that saturates with outage length
  (B) integrated-dv error is a random walk            -> fast-decaying increment
      autocorrelation, flat (white-ish) increment spectrum, error growing with duration

TRAIN + VALIDATION only. The test files exist on disk but are not opened here.
"""
import os, json
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DENSE = os.path.join(HERE, 'predictions', 'dense')
OUT = os.path.join(HERE, 'validation_results')
os.makedirs(OUT, exist_ok=True)
K, DT = 5, 0.1


def acf(x, nlags):
    x = x - x.mean()
    n = len(x)
    v = np.dot(x, x)
    return np.array([1.0] + [np.dot(x[:-l], x[l:]) / v for l in range(1, nlags + 1)])


def main():
    rows, acf_abs, acf_inc, psd_abs, psd_inc = [], [], [], [], []
    growth = []
    for split in ['train', 'validation']:
        for f in sorted(os.listdir(os.path.join(DENSE, split))):
            d = pd.read_parquet(os.path.join(DENSE, split, f))
            d = d[d.ok].reset_index(drop=True)
            if len(d) < 3000:
                continue
            v_true = d.v_true.to_numpy(float)
            e_abs = d.v_abs_pred.to_numpy(float) - v_true
            # per-step velocity increment implied by the dv model, and its error
            inc_pred = d.dv_pred.to_numpy(float) / K
            inc_true = np.r_[np.nan, np.diff(v_true)]
            e_inc = inc_pred - inc_true
            m = np.isfinite(e_inc)
            rows.append(dict(
                session=d.session_id.iloc[0], split=split, n=len(d),
                abs_mean=float(e_abs.mean()), abs_std=float(e_abs.std()),
                abs_acf_1s=float(acf(e_abs, 10)[10]),
                abs_acf_10s=float(acf(e_abs, 100)[100]) if len(e_abs) > 400 else np.nan,
                inc_mean=float(e_inc[m].mean()), inc_std=float(e_inc[m].std()),
                inc_acf_1step=float(acf(e_inc[m], 1)[1]),
                inc_acf_1s=float(acf(e_inc[m], 10)[10])))
            if len(e_abs) > 6000:
                acf_abs.append(acf(e_abs[:6000], 300))
                acf_inc.append(acf(e_inc[m][:6000], 300))
                for sig, store in [(e_abs[:4096], psd_abs), (e_inc[m][:4096], psd_inc)]:
                    s = sig - sig.mean()
                    P = np.abs(np.fft.rfft(s * np.hanning(len(s)))) ** 2
                    store.append(P / P.sum())
            # error growth vs outage duration, anchored at the segment start
            for T in [10, 30, 60, 120, 300]:
                L = int(T / DT)
                fa, fd = [], []
                for s0 in range(0, len(d) - L, int(30 / DT)):
                    sl = slice(s0, s0 + L)
                    v0 = v_true[s0]
                    va = d.v_abs_pred.to_numpy(float)[sl] - (d.v_abs_pred.to_numpy(float)[s0] - v0)
                    vd = v0 + np.cumsum(inc_pred[sl])
                    fa.append(np.sqrt(np.mean((va - v_true[sl]) ** 2)))
                    fd.append(np.sqrt(np.mean((vd - v_true[sl]) ** 2)))
                if fa:
                    growth.append(dict(session=d.session_id.iloc[0], split=split, outage_s=T,
                                       n=len(fa), abs_vel_rmse=float(np.median(fa)),
                                       dv_vel_rmse=float(np.median(fd))))
    R = pd.DataFrame(rows)
    R.to_csv(os.path.join(OUT, 'phase1_error_stats.csv'), index=False)
    G = pd.DataFrame(growth)
    G.to_csv(os.path.join(OUT, 'phase1_error_growth.csv'), index=False)

    pd.set_option('display.width', 250)
    print('=== per-session velocity error statistics (train+validation) ===')
    print(R[['abs_mean', 'abs_std', 'abs_acf_1s', 'abs_acf_10s',
             'inc_mean', 'inc_std', 'inc_acf_1step', 'inc_acf_1s']].describe()
          .loc[['count', 'mean', '50%', 'std']].round(5).to_string())

    A = np.mean(acf_abs, axis=0)
    I = np.mean(acf_inc, axis=0)
    print(f'\n=== mean autocorrelation (n={len(acf_abs)} long sessions) ===')
    print('  lag(s):      0.0    0.5    1.0    2.0    5.0   10.0   20.0   30.0')
    ix = [0, 5, 10, 20, 50, 100, 200, 300]
    print('  abs err :', '  '.join(f'{A[i]:+.3f}' for i in ix))
    print('  dv incr :', '  '.join(f'{I[i]:+.3f}' for i in ix))
    np.savez(os.path.join(OUT, 'phase1_acf.npz'), acf_abs=A, acf_inc=I)

    PA, PI = np.mean(psd_abs, axis=0), np.mean(psd_inc, axis=0)
    fr = np.fft.rfftfreq(4096, DT)
    def band(P, lo, hi):
        m = (fr >= lo) & (fr < hi)
        return float(P[m].sum())
    print('\n=== normalised power by band (fraction of total) ===')
    print(f"  {'band (Hz)':<14}{'abs err':>10}{'dv incr err':>14}")
    for lo, hi in [(0, 0.05), (0.05, 0.2), (0.2, 1.0), (1.0, 5.0)]:
        print(f'  {lo:.2f}-{hi:<9.2f}{band(PA,lo,hi):>10.3f}{band(PI,lo,hi):>14.3f}')
    np.savez(os.path.join(OUT, 'phase1_psd.npz'), freq=fr, psd_abs=PA, psd_inc=PI)

    print('\n=== median velocity RMSE (m/s) vs outage duration ===')
    g = G.groupby('outage_s')[['abs_vel_rmse', 'dv_vel_rmse']].median().round(3)
    g['ratio_dv_over_abs'] = (g.dv_vel_rmse / g.abs_vel_rmse).round(3)
    print(g.to_string())
    json.dump({'acf_lags_s': [i * DT for i in ix],
               'acf_abs': [float(A[i]) for i in ix],
               'acf_inc': [float(I[i]) for i in ix],
               'vel_rmse_by_outage': g.reset_index().to_dict('records')},
              open(os.path.join(OUT, 'phase1_summary.json'), 'w'), indent=2)


if __name__ == '__main__':
    main()
