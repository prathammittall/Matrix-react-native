import json, os
from collections import defaultdict, Counter
rows=json.load(open('outputs/pass1_files.json',encoding='utf-8'))
SY='Synchronised V abd S datasets'; UN='Unsynchronised V and S Dataset'
def fam(r):
    n=r['n_cols']; up=[c.upper() for c in r['cols']]
    if 'NO OF GPS SATELLITES AVAILABLE' in up: return 'V'
    if any('MAGNETIC FIELD X' in c for c in up): return 'S_FULL'
    return 'S_REDUCED'
for r in rows: r['fam']=fam(r); r['id']=os.path.splitext(r['filename'])[0]
print("files per (tree,fam):")
for k,v in sorted(Counter((r['tree'][:4],r['fam']) for r in rows).items()): print("  ",k,v)
# duplication within a tree: same id+tree -> how many copies, same content?
byidtree=defaultdict(list)
for r in rows: byidtree[(r['id'].lower(),r['tree'])].append(r)
diff_within=[(k,{x['sha256'][:8] for x in v}) for k,v in byidtree.items() if len({x['sha256'] for x in v})>1]
print("\nid+tree groups:",len(byidtree)," with >1 distinct content within same tree:",len(diff_within))
for k,v in diff_within[:10]: print("   ",k,v)
# cross-tree comparison
byid=defaultdict(dict)
for r in rows: byid[r['id'].lower()][r['tree']]=r
both=[i for i,d in byid.items() if len(d)==2]
same=[i for i in both if byid[i][SY]['sha256']==byid[i][UN]['sha256']]
print(f"\nids total={len(byid)} in both trees={len(both)} identical content={len(same)} differing={len(both)-len(same)}")
print("only in SYNC:",sorted(i for i,d in byid.items() if set(d)=={SY}))
print("only in UNSYNC:",sorted(i for i,d in byid.items() if set(d)=={UN}))
print("\nS_REDUCED files:",sorted({r['id'] for r in rows if r['fam']=='S_REDUCED'}))
print("\nall S ids:",sorted({r['id'] for r in rows if r['fam'].startswith('S')}))
print("\nall V ids:",sorted({r['id'] for r in rows if r['fam']=='V'}))
