import pandas as pd, numpy as np, json, os, warnings
warnings.filterwarnings('ignore')
ROOT=r"D:\Projects\Dead Reaconking system\Pre ppt round prototype\model\dataset"
fp=json.load(open('outputs/pass2_fp.json',encoding='utf-8'))
def load(p):
    df=pd.read_csv(os.path.join(ROOT,p),encoding='latin-1',low_memory=False)
    df.columns=[c.strip() for c in df.columns]
    return df.loc[:,[c for c in df.columns if c!='']]
for tid in ['s-vta4','s-s1','s-vw16a']:
    c=[r for r in fp if r['id'].lower()==tid and r['tree'].startswith('Sync')]
    a=load([x for x in c if 'Uncat' not in x['view']][0]['rel_path'])
    b=load([x for x in c if 'Uncat' in x['view']][0]['rel_path'])
    print(f"\n===== {tid}  shapes {a.shape} {b.shape}")
    na=a.apply(pd.to_numeric,errors='coerce'); nb=b.apply(pd.to_numeric,errors='coerce')
    na.columns=range(na.shape[1]); nb.columns=range(nb.shape[1])
    d=(na-nb).abs()
    for i in range(na.shape[1]):
        m=d[i].max()
        if pd.notna(m) and m>1e-9:
            print(f"   col{i:2d} '{a.columns[i][:34]}' maxdiff={m:.6g} ndiff={(d[i]>1e-9).sum()}")
    # non numeric cols
    for i,cn in enumerate(a.columns):
        if na[i].isna().all():
            neq=(a[cn].astype(str)!=b[b.columns[i]].astype(str)).sum()
            print(f"   col{i:2d} '{cn[:34]}' TEXT ndiff={neq}")
