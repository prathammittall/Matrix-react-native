"""Pass 4 (Task 4): verify which S/V dataset pairs are ACTUALLY time-synchronised.

Method: the S datasets carry an absolute wall-clock 'DATE' column; the V datasets
carry 'Time Since Start of Day (seconds)'. Converting the S wall clock to seconds
since local midnight makes the two directly comparable, so pairing can be tested
against real timestamps instead of being assumed from matching filenames.
"""
import os, re, json
import numpy as np
import pandas as pd
from common import ROOT, OUT, SY, UN, load_raw, map_cols, parse_s_date

inv = pd.read_csv(os.path.join(OUT, 'raw_inventory.csv'))


def base(i):
    return re.sub(r'^[sv]-', '', str(i).lower())


S = inv[inv.kind == 'S'].set_index(inv[inv.kind == 'S'].dataset_id.map(base))
Vs = inv[inv.variant == 'V_sync'].set_index(inv[inv.variant == 'V_sync'].dataset_id.map(base))
Vf = inv[inv.variant == 'V_full'].set_index(inv[inv.variant == 'V_full'].dataset_id.map(base))

rows = []
for b in sorted(set(S.index) | set(Vf.index)):
    r = {'pair_base': b,
         's_id': S.loc[b, 'dataset_id'] if b in S.index else '',
         'v_id': Vf.loc[b, 'dataset_id'] if b in Vf.index else '',
         'in_sync_folder': b in Vs.index,
         's_exists': b in S.index, 'v_exists': b in Vf.index}
    if not (r['s_exists'] and r['v_exists']):
        r['verdict'] = 'NO_COUNTERPART'
        rows.append(r)
        continue

    # --- S: wall clock -> seconds since local midnight
    sdf = load_raw(S.loc[b, 'canonical_path'])
    sdf = sdf.loc[:, [c for c in sdf.columns if c.strip() != '']]
    sm = map_cols(list(sdf.columns), 'S')
    sdf = sdf.rename(columns={c: v for c, v in sm.items() if v})
    sdf = sdf.loc[:, ~sdf.columns.duplicated(keep='first')]
    ts, ok = parse_s_date(sdf['date_raw'])
    if not ok.any():
        r['verdict'] = 'S_DATE_UNPARSEABLE'
        rows.append(r)
        continue
    d = pd.to_datetime(ts[ok], unit='s')
    s_tod = (d.dt.hour * 3600 + d.dt.minute * 60 + d.dt.second + d.dt.microsecond / 1e6)
    r['s_date'] = str(d.dt.date.iloc[0])
    r['s_tod_start'], r['s_tod_end'] = round(float(s_tod.min()), 2), round(float(s_tod.max()), 2)

    # --- V: time of day directly, for both variants
    for lbl, tab in (('vfull', Vf), ('vsync', Vs)):
        if b not in tab.index:
            continue
        vdf = load_raw(tab.loc[b, 'canonical_path'])
        vdf = vdf.loc[:, [c for c in vdf.columns if c.strip() != '']]
        vm = map_cols(list(vdf.columns), 'V')
        vdf = vdf.rename(columns={c: v for c, v in vm.items() if v})
        vt = pd.to_numeric(vdf['v_tod_s'], errors='coerce').dropna()
        r[lbl + '_tod_start'], r[lbl + '_tod_end'] = round(float(vt.min()), 2), round(float(vt.max()), 2)
        # overlap of [s_start,s_end] with [v_start,v_end], and with a +3600s (BST) shift
        for off, tag in ((0, ''), (3600, '_bst')):
            lo = max(r['s_tod_start'] - off, vt.min())
            hi = min(r['s_tod_end'] - off, vt.max())
            ov = max(0.0, hi - lo)
            r[f'{lbl}_overlap{tag}_s'] = round(ov, 2)
            r[f'{lbl}_overlap{tag}_frac'] = round(ov / max(1e-9, r['s_tod_end'] - r['s_tod_start']), 4)
    rows.append(r)
    print('.', end='', flush=True)

df = pd.DataFrame(rows)


def verdict(r):
    if r.get('verdict') == 'NO_COUNTERPART':
        return 'NO_COUNTERPART'
    a = r.get('vsync_overlap_frac', 0) or 0
    b_ = r.get('vsync_overlap_bst_frac', 0) or 0
    c = r.get('vfull_overlap_frac', 0) or 0
    d_ = r.get('vfull_overlap_bst_frac', 0) or 0
    best = max(a, b_, c, d_)
    if best >= 0.80:
        return 'SYNC_CONFIRMED'
    if best >= 0.20:
        return 'SYNC_PARTIAL'
    return 'SYNC_NOT_CONFIRMED'


df['verdict'] = df.apply(verdict, axis=1)
df['best_offset'] = df.apply(
    lambda r: 'BST(+3600s)' if max(r.get('vsync_overlap_bst_frac', 0) or 0,
                                  r.get('vfull_overlap_bst_frac', 0) or 0)
    > max(r.get('vsync_overlap_frac', 0) or 0, r.get('vfull_overlap_frac', 0) or 0)
    else 'none(UTC/GMT)', axis=1)
df.to_csv(os.path.join(OUT, 'sv_synchronisation.csv'), index=False)
print("\n", df.verdict.value_counts().to_dict())
print(df.groupby(['in_sync_folder', 'verdict']).size())
