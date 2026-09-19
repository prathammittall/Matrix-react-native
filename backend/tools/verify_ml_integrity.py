"""Verify that nothing under `model/` has changed.

The frontend and the inference service must never alter the frozen ML pipeline.
This script proves it, by hashing every file under `model/` and comparing
against a manifest.

    python backend/tools/verify_ml_integrity.py --write    # record the baseline
    python backend/tools/verify_ml_integrity.py            # check against it

Exit code 0 means every checkpoint, config, scaler, script, split manifest and
derived artifact is byte-identical to the baseline. Exit code 1 lists what
changed. The raw dataset under `model/dataset/` is excluded by default (2.1 GB,
gitignored, and hashed separately by the command in RUN.md section 3); pass
`--include-dataset` to cover it too.

The manifest lives in `backend/`, never inside `model/`.
"""
import argparse
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from matrix_service import config                                        # noqa: E402

MANIFEST = os.path.join(config.BACKEND_ROOT, "ml_integrity_manifest.json")
SKIP_DIRS = {"__pycache__", ".ipynb_checkpoints"}

# The artifacts whose change would directly alter accuracy. Reported separately
# so a diff in, say, a plot PNG is not confused with a diff in the weights.
CRITICAL = (
    "baseline/checkpoints/best_huber.pt",
    "experiments/delta_v/checkpoints/best_k5_huber.pt",
    "experiments/complementary_fusion/frozen_fusion_config.json",
    "preprocessing/training_dataset/core/scaler/scaler.json",
    "preprocessing/training_dataset/core/scaler/scaler.npz",
    "preprocessing/outputs/feature_schema.json",
    "preprocessing/training_dataset/core/split_manifest.csv",
    "experiments/delta_v/dv_target_config.json",
    "baseline/config.yaml",
    "experiments/delta_v/config.yaml",
    "experiments/complementary_fusion/config.yaml",
)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def scan(include_dataset):
    out = {}
    for dirpath, dirnames, filenames in os.walk(config.MODEL_ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS
                       and (include_dataset or d != "dataset")]
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, config.MODEL_ROOT).replace(os.sep, "/")
            out[rel] = sha256(full)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="record the current state as the baseline")
    ap.add_argument("--include-dataset", action="store_true",
                    help="also hash the 2.1 GB raw dataset (slow)")
    args = ap.parse_args()

    current = scan(args.include_dataset)

    if args.write:
        with open(MANIFEST, "w", encoding="utf-8") as fh:
            json.dump({"root": "model/", "include_dataset": args.include_dataset,
                       "files": current}, fh, indent=1, sort_keys=True)
        print("recorded %d files -> %s" % (len(current), MANIFEST))
        return 0

    if not os.path.exists(MANIFEST):
        raise SystemExit("No manifest at %s. Create one with --write first." % MANIFEST)

    with open(MANIFEST, encoding="utf-8") as fh:
        baseline = json.load(fh)["files"]

    changed = sorted(k for k in current if k in baseline and current[k] != baseline[k])
    removed = sorted(set(baseline) - set(current))
    added = sorted(set(current) - set(baseline))

    critical_hits = [p for p in changed + removed if p in CRITICAL]

    print("checked %d files under model/ (dataset %s)"
          % (len(current), "included" if args.include_dataset else "excluded"))

    if not changed and not removed:
        print("UNCHANGED - every frozen artifact is byte-identical to the baseline.")
        if added:
            print("\n%d new file(s) appeared (not a modification of a frozen artifact):" % len(added))
            for p in added[:20]:
                print("  + %s" % p)
        return 0

    print("\nMODIFIED - the frozen ML tree is not as recorded.")
    if critical_hits:
        print("\n!! ACCURACY-CRITICAL ARTIFACTS AFFECTED:")
        for p in critical_hits:
            print("   *** %s" % p)
        print("   Restore these from git immediately: git checkout -- model/")
    for p in changed:
        print("  M %s" % p)
    for p in removed:
        print("  D %s" % p)
    for p in added:
        print("  + %s" % p)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
