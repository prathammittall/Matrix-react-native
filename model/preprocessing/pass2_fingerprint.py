"""Pass 2: numeric fingerprint of every CSV so copies of the same dataset ID can be
compared by VALUE rather than by byte hash (float repr + header naming differ)."""
import json, os, hashlib, numpy as np, pandas as pd, warnings
warnings.filterwarnings('ignore')
ROOT=r"D:\Projects\Dead Reaconking system\Pre ppt round prototype\model\dataset"
rows=json.load(open('outputs/pass1_files.json',encoding='utf-8'))
out=[]
for i,r in enumerate(rows):
    p=os.path.join(ROOT,r['rel_path'])
    try:
        df=pd.read_csv(p,encoding='latin-1',low_memory=False)
        df.columns=[c.strip() for c in df.columns]
        df=df.loc[:,[c for c in df.columns if c!='']]
        num=df.apply(pd.to_numeric,errors='coerce')
        num=num.dropna(axis=1,how='all')
        arr=np.round(num.to_numpy(dtype='float64'),5)
        fp=hashlib.sha256(np.nan_to_num(arr,nan=-9e9).tobytes()).hexdigest()
        out.append(dict(rel_path=r['rel_path'],id=os.path.splitext(r['filename'])[0],
            tree=r['tree'],view=r['view'],n_rows=len(df),n_cols=df.shape[1],
            num_cols=num.shape[1],fp=fp,
            first_ts=str(df.iloc[0,8]) if df.shape[1]>8 else '',
            ok=True,err=''))
    except Exception as e:
        out.append(dict(rel_path=r['rel_path'],id=os.path.splitext(r['filename'])[0],
            tree=r['tree'],view=r['view'],n_rows=-1,n_cols=-1,num_cols=-1,fp='',
            first_ts='',ok=False,err=str(e)[:200]))
    if i%100==0: print('...',i,flush=True)
json.dump(out,open('outputs/pass2_fp.json','w',encoding='utf-8'),indent=1)
print('done',len(out),'failed:',sum(1 for r in out if not r['ok']))
