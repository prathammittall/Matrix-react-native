"""Verify that nothing under `model/` has changed.

The frontend and the inference service must never alter the frozen ML pipeline.
This script proves it, by hashing every file under `model/` and comparing
against a manifest.

    python backend/tools/verify_ml_integrity.py --write    # record the baseline
    python backend/tools/verify_ml_integrity.py            # check against it

Exit code 0 means every frozen artifact present in this checkout matches the
baseline. Exit code 1 lists what changed. The raw dataset under `model/dataset/`
is excluded by default (2.1 GB, gitignored, and hashed separately by the command
in RUN.md section 3); pass `--include-dataset` to cover it too.

The manifest lives in `backend/`, never inside `model/`.

## Two things this deliberately does NOT treat as a modification

**Line endings.** Git rewrites LF to CRLF in the working copy on Windows
(`core.autocrlf`), and the manifest was recorded on a machine with a mixture of
both. A straight byte comparison therefore reported most of the tree as modified
on a fresh clone -- including the three `config.yaml` files flagged as
accuracy-critical, with an instruction to restore them from git that could not
possibly help, because git considered them clean. A text file is now accepted if
it matches the recorded hash in ANY line-ending form. A real edit changes all of
them, so nothing is weakened.

**Absent derived data.** The manifest covers 638 files; .gitignore deliberately
excludes 487 of them -- parquet and npy outputs of `pass1..pass12`, large and
reproducible. A clone does not have them, and reporting each as a deletion
turned a correct checkout into a red alarm. Git is asked which paths are
ignored, so whatever .gitignore says today is what this honours.

A check that fires on a correct clone is a check nobody reads, and then it
cannot warn about the one change that matters. The weights themselves are
binary and are still compared byte for byte.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from matrix_service import config                                        # noqa: E402

MANIFEST = os.path.join(config.BACKEND_ROOT, "ml_integrity_manifest.json")
SKIP_DIRS = {"__pycache__", ".ipynb_checkpoints"}

# Written without escape sequences so this file cannot itself be broken by any
# line-ending rewriting on its way into a working copy.
LF = bytes([10])
CR = bytes([13])
CRLF = CR + LF

# Hashed as text, with line endings normalised. Everything else -- .pt, .npz,
# .parquet, .png -- is hashed byte for byte.
TEXT_SUFFIXES = {
    ".py", ".yaml", ".yml", ".json", ".csv", ".md", ".txt", ".cfg", ".ini", ".toml",
}

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


def is_text(path):
    return os.path.splitext(path)[1].lower() in TEXT_SUFFIXES


def _digest(data):
    return hashlib.sha256(data).hexdigest()


def _to_lf(data):
    return data.replace(CRLF, LF).replace(CR, LF)


def hashes(path):
    """Every hash an UNMODIFIED copy of this file could legitimately have.

    For a binary file that is one value: the bytes on disk. For a text file it
    is up to three -- the bytes on disk, the same content with LF endings, and
    the same content with CRLF endings -- because line endings are the only
    thing that legitimately differs between two checkouts of an unchanged tree.
    """
    if not is_text(path):
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for block in iter(lambda: fh.read(1 << 20), b""):
                h.update(block)
        return (h.hexdigest(),)

    with open(path, "rb") as fh:
        raw = fh.read()
    lf = _to_lf(raw)
    crlf = lf.replace(LF, CRLF)
    out = []
    for candidate in (raw, lf, crlf):
        digest = _digest(candidate)
        if digest not in out:
            out.append(digest)
    return tuple(out)


def canonical(path):
    """The hash to RECORD for a file: LF-normalised when text, raw when not."""
    if not is_text(path):
        return hashes(path)[0]
    with open(path, "rb") as fh:
        return _digest(_to_lf(fh.read()))


def gitignored(paths):
    """Which of `paths` git considers ignored -- i.e. regenerable derived data.

    Asking git is exact and duplicates no rules. If git is unavailable the paths
    are treated as real deletions, which is the safe direction to be wrong in.

    NUL-separated and in BINARY mode, both deliberately. Python's text mode
    translates newlines on Windows, so every path reached git with a trailing
    CR, git took the CR to be part of the filename, and the answer came back as
    a set of quoted paths ending in a literal backslash-r that matched nothing.
    `-z` also removes git's own quoting of unusual filenames.
    """
    if not paths:
        return set()
    nul = bytes([0])
    try:
        proc = subprocess.run(
            ["git", "check-ignore", "--stdin", "-z"],
            cwd=config.MODEL_ROOT,
            input=nul.join(p.encode("utf-8") for p in paths),
            capture_output=True,
            check=False,
        )
    except (OSError, ValueError):
        return set()
    # 0 = some paths ignored, 1 = none ignored, anything else = git could not
    # answer (not a repository, no git on PATH), so claim nothing.
    if proc.returncode not in (0, 1):
        return set()
    return {
        chunk.decode("utf-8", "replace").replace(os.sep, "/")
        for chunk in proc.stdout.split(nul)
        if chunk
    }


def scan(include_dataset, record=False):
    out = {}
    for dirpath, dirnames, filenames in os.walk(config.MODEL_ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS
                       and (include_dataset or d != "dataset")]
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, config.MODEL_ROOT).replace(os.sep, "/")
            out[rel] = canonical(full) if record else hashes(full)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="record the current state as the baseline")
    ap.add_argument("--include-dataset", action="store_true",
                    help="also hash the 2.1 GB raw dataset (slow)")
    # explicit argv so a test can invoke the real check without pytest's own
    # command line being parsed as ours
    args = ap.parse_args(argv)

    current = scan(args.include_dataset, record=args.write)

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

    changed = sorted(k for k in current
                     if k in baseline and baseline[k] not in current[k])
    missing = sorted(set(baseline) - set(current))
    added = sorted(set(current) - set(baseline))

    # A file the manifest knows about but this checkout lacks is only a deletion
    # if git tracks it. Derived data is meant to be absent.
    absent_derived = gitignored(missing)
    deleted = [p for p in missing if p not in absent_derived]

    critical_hits = [p for p in changed + deleted if p in CRITICAL]

    print("checked %d files under model/ (dataset %s)"
          % (len(current), "included" if args.include_dataset else "excluded"))
    if absent_derived:
        print("%d derived file(s) absent and gitignored - regenerable by "
              "pass1..pass12, see RUN.md section 16" % len(absent_derived))

    if not changed and not deleted:
        print("UNCHANGED - every frozen artifact present here matches the baseline.")
        if added:
            print()
            print("%d new file(s) appeared (not a modification of a frozen artifact):"
                  % len(added))
            for p in added[:20]:
                print("  + %s" % p)
        return 0

    print()
    print("MODIFIED - the frozen ML tree is not as recorded.")
    if critical_hits:
        print()
        print("!! ACCURACY-CRITICAL ARTIFACTS AFFECTED:")
        for p in critical_hits:
            print("   *** %s" % p)
        print("   Restore these from git immediately: git checkout -- model/")
    for p in changed:
        print("  M %s" % p)
    for p in deleted:
        print("  D %s" % p)
    for p in added:
        print("  + %s" % p)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
