"""IO-VNBD pass 1: enumerate every CSV, hash for dedup, extract raw header.
Read-only with respect to the raw dataset."""
import os, hashlib, json, csv, re, sys

ROOT = r"D:\Projects\Dead Reaconking system\Pre ppt round prototype\model\dataset"
OUT  = r"D:\Projects\Dead Reaconking system\Pre ppt round prototype\model\preprocessing\outputs"

def sha(path, buf=1 << 20):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(buf), b''):
            h.update(b)
    return h.hexdigest()

rows = []
for dirpath, _, files in os.walk(ROOT):
    for fn in files:
        if not fn.lower().endswith('.csv'):
            continue
        p = os.path.join(dirpath, fn)
        rel = os.path.relpath(p, ROOT)
        parts = rel.split(os.sep)
        tree = parts[0]
        view = parts[1] if len(parts) > 1 else ''
        # raw header line, bytes -> latin-1 to survive mojibake
        with open(p, 'rb') as f:
            hdr = f.readline().decode('latin-1').rstrip('\r\n')
        cols = [c.strip() for c in hdr.split(',')]
        # count lines cheaply
        n = 0
        with open(p, 'rb') as f:
            for _ in f:
                n += 1
        rows.append(dict(
            rel_path=rel, filename=fn, tree=tree, view=view,
            folder=os.path.dirname(rel), size_bytes=os.path.getsize(p),
            sha256=sha(p), n_lines=n, n_data_rows=max(0, n - 1),
            n_cols=len(cols), header_raw=hdr, cols=cols))

with open(os.path.join(OUT, 'pass1_files.json'), 'w', encoding='utf-8') as f:
    json.dump(rows, f, indent=1)

print("total csv files:", len(rows))
print("unique by sha256:", len({r['sha256'] for r in rows}))
print("unique by filename(lower):", len({r['filename'].lower() for r in rows}))

# schema families = tuple of normalised column names
from collections import Counter, defaultdict
fam = defaultdict(list)
for r in rows:
    key = tuple(c.upper() for c in r['cols'])
    fam[key].append(r['rel_path'])
print("\ndistinct raw header signatures:", len(fam))
for i, (k, v) in enumerate(sorted(fam.items(), key=lambda x: -len(x[1]))):
    print(f"\n--- family {i}  ncols={len(k)}  nfiles={len(v)}")
    print("   example:", v[0])
    print("   cols:", list(k))
