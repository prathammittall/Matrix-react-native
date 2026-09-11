import json
from collections import defaultdict
fp=json.load(open('outputs/pass2_fp.json',encoding='utf-8'))
SY='Synchronised V abd S datasets'; UN='Unsynchronised V and S Dataset'
byid=defaultdict(list)
for r in fp: byid[r['id'].lower()].append(r)
# are ALL S ids identical across trees?
sdiff=[i for i,v in byid.items() if i.startswith('s-') and {x['tree'] for x in v}=={SY,UN}
       and not ({x['fp'] for x in v if x['tree']==SY} & {x['fp'] for x in v if x['tree']==UN})]
print("S ids differing across trees:",sdiff)
# within-tree differing groups
print("\nwithin-tree value-differing groups:")
for i,v in sorted(byid.items()):
    for t in (SY,UN):
        c=[x for x in v if x['tree']==t]
        if len(c)>1 and len({x['fp'] for x in c})>1:
            print(f"  {i:12s} {t[:4]}")
            for x in c: print(f"      rows={x['n_rows']:8d} cols={x['n_cols']:3d} fp={x['fp'][:8]} {x['view'][:34]:36s}")
