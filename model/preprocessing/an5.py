import pandas as pd, numpy as np, json, os, warnings
warnings.filterwarnings('ignore')
ROOT=r"D:\Projects\Dead Reaconking system\Pre ppt round prototype\model\dataset"
fp=json.load(open('outputs/pass2_fp.json',encoding='utf-8'))
def load(p):
    df=pd.read_csv(os.path.join(ROOT,p),encoding='latin-1',low_memory=False)
    df.columns=[c.strip() for c in df.columns]
    return df.loc[:,[c for c in df.columns if c!='']]
ids=['s-vta4','s-s1','s-vw16a','s-vta1b','s-vtb5']
for tid in ids:
    c=[r for r in fp if r['id'].lower()==tid and r['tree'].startswith('Sync')]
    a=load([x for x in c if 'Uncat' not in x['view']][0]['rel_path'])
    b=load([x for x in c if 'Uncat' in x['view']][0]['rel_path'])
    na=a.apply(pd.to_numeric,errors='coerce').to_numpy(float)
    nb=b.apply(pd.to_numeric,errors='coerce').to_numpy(float)
    mask_diff=(np.isnan(na)!=np.isnan(nb))
    print(f"{tid}: nan-mask mismatches={mask_diff.sum()}  allclose(nan_eq)={np.allclose(na,nb,equal_nan=True,atol=1e-9)}")
    if mask_diff.sum():
        r,cc=np.where(mask_diff)
        for k in range(min(3,len(r))):
            print(f"    row{r[k]} col{cc[k]} '{a.columns[cc[k]]}' A={a.iloc[r[k],cc[k]]!r} B={b.iloc[r[k],cc[k]]!r}")
