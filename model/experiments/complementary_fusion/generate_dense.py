"""Experiment E step 0: dense (stride-1) predictions from the two FROZEN models.

Neither model is retrained or modified. Checkpoints are loaded read-only:
  model/baseline/checkpoints/best_huber.pt                -> [v_absolute, yaw]
  model/experiments/delta_v/checkpoints/best_k5_huber.pt  -> [dv5, yaw]

Writes predictions/dense/<split>/<session>.parquet for train, validation and test.
Test files are written but are not inspected until Phase 5.
"""
import os, sys, json
import numpy as np
import pandas as pd
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
sys.path.insert(0, os.path.join(ROOT, 'baseline'))
sys.path.insert(0, os.path.join(ROOT, 'experiments', 'delta_v'))
from train_baseline import MatrixBaseline, DEVICE            # noqa: E402
from dv_common import session_frame, dense, FMU, FSD, DS     # noqa: E402

K = 5
OUT = os.path.join(HERE, 'predictions', 'dense')


def load(path):
    ck = torch.load(path, map_location=DEVICE, weights_only=False)
    m = MatrixBaseline().to(DEVICE)
    m.load_state_dict(ck['model'])
    m.eval()
    return m, ck


@torch.no_grad()
def pred(model, X, tmu, tsd, bs=2048):
    P = []
    for i in range(0, len(X), bs):
        xb = torch.from_numpy(((X[i:i + bs] - FMU) / FSD).astype(np.float32)).to(DEVICE)
        P.append(model(xb).cpu().numpy())
    return np.concatenate(P) * tsd + tmu


def main():
    sc = json.load(open(os.path.join(DS, 'scaler', 'scaler.json')))
    b_tmu = np.array(sc['target_mean'], np.float32)
    b_tsd = np.array(sc['target_std'], np.float32)
    bmodel, bck = load(os.path.join(ROOT, 'baseline', 'checkpoints', 'best_huber.pt'))
    dmodel, dck = load(os.path.join(ROOT, 'experiments', 'delta_v', 'checkpoints',
                                    f'best_k{K}_huber.pt'))
    print('baseline ck epoch', bck['epoch'], '| delta-v ck epoch', dck['epoch'])

    man = pd.read_csv(os.path.join(DS, 'split_manifest.csv'))
    for split in ['train', 'validation', 'test']:
        d = os.path.join(OUT, split)
        os.makedirs(d, exist_ok=True)
        for _, r in man[man.split == split].iterrows():
            S = session_frame(r.dataset_id, r.session_id)
            X, ends, ok = dense(S)
            Pb = pred(bmodel, X, b_tmu, b_tsd)
            Pd = pred(dmodel, X, dck['target_mean'], dck['target_std'])
            pd.DataFrame({
                'session_id': r.session_id, 'dataset_id': r.dataset_id,
                'driver_id': r.driver, 'split': split,
                'timestamp_s': S.timestamp_s.to_numpy(float)[ends],
                'v_true': S.target_v_forward.to_numpy(float)[ends],
                'yaw_true': S.target_yaw_rate.to_numpy(float)[ends],
                'v_abs_pred': Pb[:, 0], 'yaw_pred_base': Pb[:, 1],
                'dv_pred': Pd[:, 0], 'yaw_pred_dv': Pd[:, 1],
                'ok': ok}).to_parquet(os.path.join(d, f'{r.session_id}.parquet'), index=False)
            print(f'  {split:10s} {r.session_id:16s} {len(ends):7d} rows', flush=True)


if __name__ == '__main__':
    main()
