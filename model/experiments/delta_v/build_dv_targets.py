"""Build delta-v targets aligned to the EXISTING baseline windows.

The split, the windows and the 50x6 inputs are untouched: only y changes. For each
candidate horizon k the target at window end t is

    dv_k[t] = v[t] - v[t-k]

with validity requiring BOTH endpoints to be high-confidence VBOX targets, the k-step span
to be contiguous in time, and the implied acceleration to be physically possible.

The physical bound is needed because the VBOX GPS velocity occasionally drops to 0 for a
single sample and recovers (11 events in 313,585 steps); those glitches would otherwise
become +-26 m/s targets. Bound = 15 m/s^2 (1.53 g): p99.9 of the observed distribution is
7.9 m/s^2 and a road car cannot exceed ~1.2 g, so this keeps every genuine hard brake.
"""
import os, json
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
PRE = os.path.join(HERE, '..', '..', 'preprocessing')
DS = os.path.join(PRE, 'training_dataset', 'core')
TGT = os.path.join(PRE, 'targets')
OUT = os.path.join(HERE, 'targets')
os.makedirs(OUT, exist_ok=True)

KS = [1, 5, 10]
DT = 0.1
MAX_ACC = 15.0          # m/s^2, see module docstring


def dv_series(sess, k):
    """Per-row dv_k plus validity mask, indexed by row_index_original."""
    T = pd.read_parquet(os.path.join(TGT, f'{sess}.parquet')) \
        .sort_values('row_index_original').reset_index(drop=True)
    v = T.target_v_forward.to_numpy(float)
    t = T.timestamp_s.to_numpy(float)
    ok = (T.target_valid.fillna(False)
          & (T.target_source == 'vbox')
          & (T.target_confidence == 'high')).to_numpy()
    n = len(v)
    dv = np.full(n, np.nan)
    dv[k:] = v[k:] - v[:-k]
    m = np.zeros(n, bool)
    m[k:] = ok[k:] & ok[:-k]
    span = np.full(n, np.nan)
    span[k:] = t[k:] - t[:-k]
    m &= np.abs(span - k * DT) < 0.02                      # contiguous in time
    with np.errstate(invalid='ignore'):
        m &= np.abs(dv) / (k * DT) <= MAX_ACC              # physically possible
    return pd.DataFrame({'row_index_original': T.row_index_original.to_numpy(),
                         f'dv{k}': dv, f'dv{k}_valid': m})


def main():
    man = pd.read_csv(os.path.join(DS, 'split_manifest.csv'))
    summary = []
    for tag, sub, split in [('train', 'train', 'train'),
                            ('val', 'validation', 'validation'),
                            ('test', 'test', 'test')]:
        md = pd.read_parquet(os.path.join(DS, 'metadata', f'metadata_{tag}.parquet'))
        md['_i'] = np.arange(len(md))
        y_abs = np.load(os.path.join(DS, sub, f'y_{tag}.npy'))
        out = md[['_i', 'session_id', 'end_row_original']].copy()
        for k in KS:
            cols = []
            for sess, g in out.groupby('session_id'):
                s = dv_series(sess, k)
                cols.append(g.merge(s, left_on='end_row_original',
                                    right_on='row_index_original', how='left'))
            j = pd.concat(cols).sort_values('_i')
            out[f'dv{k}'] = j[f'dv{k}'].to_numpy()
            out[f'dv{k}_valid'] = j[f'dv{k}_valid'].fillna(False).to_numpy()
        out['yaw_rate'] = y_abs[:, 1]
        out['v_abs'] = y_abs[:, 0]
        out.to_parquet(os.path.join(OUT, f'dv_targets_{tag}.parquet'), index=False)
        row = dict(split=split, n_windows=len(out))
        for k in KS:
            vmask = out[f'dv{k}_valid'].to_numpy()
            d = out[f'dv{k}'].to_numpy()[vmask]
            row[f'k{k}_valid'] = int(vmask.sum())
            row[f'k{k}_dropped'] = int((~vmask).sum())
            row[f'k{k}_std'] = round(float(d.std()), 5)
            row[f'k{k}_p99'] = round(float(np.percentile(np.abs(d), 99)), 4)
            row[f'k{k}_max'] = round(float(np.abs(d).max()), 4)
        summary.append(row)
    S = pd.DataFrame(summary)
    S.to_csv(os.path.join(HERE, 'dv_target_summary.csv'), index=False)
    print(S.to_string(index=False))
    json.dump({'horizons': KS, 'dt': DT, 'max_acceleration_ms2': MAX_ACC,
               'rationale': 'VBOX GPS velocity dropouts create impossible dv; p99.9 of '
                            'observed |acc| is 7.9 m/s^2 and a road car cannot exceed ~1.2 g'},
              open(os.path.join(HERE, 'dv_target_config.json'), 'w'), indent=2)


if __name__ == '__main__':
    main()
