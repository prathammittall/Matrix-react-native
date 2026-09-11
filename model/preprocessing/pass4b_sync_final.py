"""Pass 4b (Task 4): final S/V synchronisation verdict from three independent lines
of evidence -- row alignment, wall-clock overlap, and spatial track agreement.

The authors' "manual synchronisation" turns out to be ROW-INDEX alignment (V_sync is
trimmed to the same row count as S at 10 Hz), so row alignment is the primary test.
"""
import os, re
import numpy as np
import pandas as pd
from common import ROOT, OUT, load_raw, map_cols, parse_s_date

inv = pd.read_csv(os.path.join(OUT, 'raw_inventory.csv'))
tsy = pd.read_csv(os.path.join(OUT, 'sv_synchronisation.csv')).set_index('pair_base')


def base(i):
    return re.sub(r'^[sv]-', '', str(i).lower())


def prep(r):
    d = load_raw(r.canonical_path)
    d = d.loc[:, [c for c in d.columns if c.strip() != '']]
    m = map_cols(list(d.columns), r.kind)
    d = d.rename(columns={c: v for c, v in m.items() if v})
    return d.loc[:, ~d.columns.duplicated(keep='first')]


S = inv[inv.kind == 'S'].copy(); S['b'] = S.dataset_id.map(base)
Vs = inv[inv.variant == 'V_sync'].copy(); Vs['b'] = Vs.dataset_id.map(base)
Vf = inv[inv.variant == 'V_full'].copy(); Vf['b'] = Vf.dataset_id.map(base)
Si, Vsi, Vfi = S.set_index('b'), Vs.set_index('b'), Vf.set_index('b')

rows = []
for b in sorted(set(Si.index) | set(Vfi.index)):
    r = {'pair_base': b,
         's_id': Si.loc[b, 'dataset_id'] if b in Si.index else '',
         'v_id': Vfi.loc[b, 'dataset_id'] if b in Vfi.index else '',
         'has_S': b in Si.index, 'has_V': b in Vfi.index,
         'in_sync_folder': b in Vsi.index}
    if not (r['has_S'] and r['has_V']):
        r['verdict'] = 'NO_COUNTERPART'
        r['reason'] = 'only one of S/V exists for this ID'
        rows.append(r); continue

    sd = prep(Si.loc[b]); r['s_rows'] = len(sd)
    slat = pd.to_numeric(sd['gps_latitude'], errors='coerce')
    slon = pd.to_numeric(sd['gps_longitude'], errors='coerce')

    if b in Vsi.index:
        vd = prep(Vsi.loc[b]); r['v_sync_rows'] = len(vd)
        r['v_full_rows'] = int(Vfi.loc[b, 'n_rows'])
        r['v_sync_trimmed'] = r['v_sync_rows'] != r['v_full_rows']
        r['row_delta'] = r['v_sync_rows'] - r['s_rows']
        r['row_aligned'] = abs(r['row_delta']) <= 2
    else:
        vd = prep(Vfi.loc[b]); r['v_full_rows'] = len(vd)
        r['v_sync_rows'] = np.nan; r['v_sync_trimmed'] = False
        r['row_delta'] = np.nan; r['row_aligned'] = False

    vlat = pd.to_numeric(vd['v_latitude'], errors='coerce')
    vlon = pd.to_numeric(vd['v_longitude'], errors='coerce')

    # --- spatial agreement: IoU of lat/lon bounding boxes
    def iou(a1, a2, b1, b2, c1, c2, d1, d2):
        ix = max(0.0, min(a2, b2) - max(a1, b1))
        iy = max(0.0, min(c2, d2) - max(c1, d1))
        inter = ix * iy
        ua = (a2 - a1) * (c2 - c1) + (b2 - b1) * (d2 - d1) - inter
        return inter / ua if ua > 0 else 0.0

    if slat.notna().any() and vlat.notna().any():
        r['bbox_iou'] = round(iou(slat.min(), slat.max(), vlat.min(), vlat.max(),
                                  slon.min(), slon.max(), vlon.min(), vlon.max()), 4)
        # median nearest-neighbour distance between the two GPS tracks (m)
        su = np.unique(np.c_[slat.dropna(), slon.dropna()], axis=0)
        vu = np.unique(np.c_[vlat.dropna(), vlon.dropna()], axis=0)
        if len(su) and len(vu):
            k = max(1, len(vu) // 400)
            vs = vu[::k][:400]
            la = np.radians(su[:, 0]); lo = np.radians(su[:, 1])
            d = []
            for y, x in vs:
                dy = (np.radians(y) - la) * 6371000
                dx = (np.radians(x) - lo) * 6371000 * np.cos(la)
                d.append(np.min(np.hypot(dx, dy)))
            r['track_med_dist_m'] = round(float(np.median(d)), 2)
            r['track_p90_dist_m'] = round(float(np.percentile(d, 90)), 2)

    t = tsy.loc[b] if b in tsy.index else {}
    r['time_overlap_frac'] = max(t.get('vsync_overlap_frac', 0) or 0,
                                 t.get('vsync_overlap_bst_frac', 0) or 0,
                                 t.get('vfull_overlap_frac', 0) or 0,
                                 t.get('vfull_overlap_bst_frac', 0) or 0) if len(t) else 0
    r['needs_bst_shift'] = bool(len(t) and max(t.get('vsync_overlap_bst_frac', 0) or 0,
                                               t.get('vfull_overlap_bst_frac', 0) or 0)
                                > max(t.get('vsync_overlap_frac', 0) or 0,
                                      t.get('vfull_overlap_frac', 0) or 0))
    r['s_date'] = t.get('s_date', '') if len(t) else ''
    r['clock_offset_s'] = round(float(t.get('vsync_tod_start', np.nan) - t.get('s_tod_start', np.nan)), 1) \
        if len(t) and pd.notna(t.get('vsync_tod_start', np.nan)) else np.nan

    # --- verdict
    spatial_ok = (r.get('track_med_dist_m', 9e9) < 25) or (r.get('bbox_iou', 0) > 0.5)
    if r['row_aligned'] and spatial_ok:
        r['verdict'] = 'SYNC_ROW_ALIGNED'
        r['reason'] = 'V trimmed to same row count as S and GPS tracks coincide'
    elif r['row_aligned']:
        r['verdict'] = 'SYNC_ROW_ALIGNED_SPATIAL_UNVERIFIED'
        r['reason'] = 'row counts match but GPS tracks do not coincide'
    elif r['in_sync_folder'] and not r['v_sync_trimmed']:
        r['verdict'] = 'SYNC_CLAIMED_NOT_TRIMMED'
        r['reason'] = 'in Synchronised folder but V identical to untrimmed V_full'
    elif r['in_sync_folder']:
        r['verdict'] = 'SYNC_ROW_MISMATCH'
        r['reason'] = f"in Synchronised folder but row delta {r['row_delta']}"
    else:
        r['verdict'] = 'NOT_SYNCHRONISED'
        r['reason'] = 'S and V both exist but pair not provided as synchronised'
    rows.append(r)
    print('.', end='', flush=True)

df = pd.DataFrame(rows)
df.to_csv(os.path.join(OUT, 'sv_synchronisation_final.csv'), index=False)
print()
print(df.verdict.value_counts().to_string())
print("\nBST shift needed:", int(df.needs_bst_shift.sum()))
print(df[df.verdict.str.startswith('SYNC_') & (df.verdict != 'SYNC_ROW_ALIGNED')]
      [['pair_base', 's_rows', 'v_sync_rows', 'v_full_rows', 'row_delta', 'bbox_iou',
        'track_med_dist_m', 'time_overlap_frac', 'verdict']].to_string(index=False))
