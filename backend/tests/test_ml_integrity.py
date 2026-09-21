"""The frozen-tree integrity check.

This tool is the project's central guarantee: `model/` is frozen, and this is
what proves it. Two regressions made it useless on a fresh clone, and both are
pinned here, because a check that cries wolf is a check that gets ignored — and
then it cannot warn about the one change that matters.

    python -m pytest backend/tests/test_ml_integrity.py -q
"""
import importlib.util
import os
import sys

import pytest

TOOL = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools", "verify_ml_integrity.py"
)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _load():
    spec = importlib.util.spec_from_file_location("verify_ml_integrity", TOOL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


verify = _load()

LF = bytes([10])
CRLF = bytes([13, 10])


def test_text_file_hashes_the_same_under_every_line_ending(tmp_path):
    """The reason every config.yaml read as MODIFIED on a Windows clone."""
    body = "a: 1|b: 2|c: 3|"
    lf = tmp_path / "lf.yaml"
    crlf = tmp_path / "crlf.yaml"
    lf.write_bytes(body.replace("|", "\n").encode())
    crlf.write_bytes(body.replace("|", "\r\n").encode())

    assert verify.canonical(str(lf)) == verify.canonical(str(crlf))
    # and each accepts the other's recorded hash
    assert verify.canonical(str(crlf)) in verify.hashes(str(lf))
    assert verify.canonical(str(lf)) in verify.hashes(str(crlf))


def test_a_real_edit_is_still_detected(tmp_path):
    """Normalisation must not be a way to smuggle a change past the check."""
    original = tmp_path / "a.yaml"
    edited = tmp_path / "b.yaml"
    original.write_bytes(b"tau: 20\n")
    edited.write_bytes(b"tau: 25\n")

    assert verify.canonical(str(original)) not in verify.hashes(str(edited))
    # not even a one-character change to a value
    subtle = tmp_path / "c.yaml"
    subtle.write_bytes(b"tau: 20 \n")
    assert verify.canonical(str(original)) not in verify.hashes(str(subtle))


def test_binary_artifacts_are_compared_byte_for_byte(tmp_path):
    """Weights must never be line-ending normalised: CR and LF are just data."""
    a = tmp_path / "w.pt"
    b = tmp_path / "x.pt"
    # bytes that WOULD collapse if this file were treated as text
    a.write_bytes(bytes([13, 10, 1, 2, 3]))
    b.write_bytes(bytes([10, 1, 2, 3]))

    assert not verify.is_text(str(a))
    assert len(verify.hashes(str(a))) == 1
    assert verify.canonical(str(a)) != verify.canonical(str(b))


def test_gitignored_recognises_derived_data():
    """The 487 absent parquet/npy files are not deletions."""
    ignored = verify.gitignored(["preprocessing/smartphone_core/S-A1.parquet"])
    assert ignored == {"preprocessing/smartphone_core/S-A1.parquet"}


def test_gitignored_does_not_claim_tracked_files():
    """A genuinely deleted frozen artifact must still be reported."""
    tracked = "baseline/config.yaml"
    assert tracked not in verify.gitignored([tracked])


def test_gitignored_handles_a_large_batch_without_corrupting_paths():
    """Text-mode newline translation used to append a CR to every path, so git
    answered with quoted names that matched nothing and 486 of 487 derived
    files were reported as deletions."""
    paths = ["preprocessing/smartphone_core/S-A%d.parquet" % i for i in range(1, 14)]
    ignored = verify.gitignored(paths)
    assert ignored == set(paths)
    for p in ignored:
        assert not p.startswith('"')
        assert "\r" not in p


def test_gitignored_is_empty_for_no_input():
    assert verify.gitignored([]) == set()


@pytest.mark.parametrize(
    "name,expected",
    [
        ("config.yaml", True),
        ("scaler.json", True),
        ("split_manifest.csv", True),
        ("RUN.md", True),
        ("best_huber.pt", False),
        ("X_train.npy", False),
        ("session.parquet", False),
        ("training_curves.png", False),
    ],
)
def test_text_classification(name, expected):
    assert verify.is_text(name) is expected


def test_the_frozen_tree_is_actually_unchanged():
    """The guarantee itself, run against this checkout."""
    assert verify.main([]) == 0
