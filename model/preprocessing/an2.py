import json
from collections import defaultdict
fp=json.load(open('outputs/pass2_fp.json',encoding='utf-8'))
SY='Synchronised V abd S datasets'; UN='Unsynchronised V and S Dataset'
byid=defaultdict(list)
for r in fp: byid[r['id'].lower()].append(r)
print("unique ids:",len(byid))
within_same=within_diff=0
for i,v in byid.items():
    for t in (SY,UN):
        c=[x for x in v if x['tree']==t]
        if len(c)>1:
            if len({x['fp'] for x in c})==1: within_same+=1
            else: within_diff+=1
print(f"within-tree duplicate groups: identical-by-value={within_same} differing={within_diff}")
both=[i for i,v in byid.items() if {x['tree'] for x in v}=={SY,UN}]
same=diff=0; difflist=[]
for i in both:
    s={x['fp'] for x in byid[i] if x['tree']==SY}; u={x['fp'] for x in byid[i] if x['tree']==UN}
    if s&u: same+=1
    else:
        diff+=1
        sr=max(x['n_rows'] for x in byid[i] if x['tree']==SY)
        ur=max(x['n_rows'] for x in byid[i] if x['tree']==UN)
        difflist.append((i,sr,ur))
print(f"\nids in both trees={len(both)} value-identical={same} value-different={diff}")
print("\nvalue-different (id, sync_rows, unsync_rows):")
for i,s,u in sorted(difflist)[:60]: print(f"   {i:12s} sync={s:8d} unsync={u:8d} delta={u-s:+d}")
