"""Deep copy of Firestore document trees (fields + subcollections, same document ids)."""

from __future__ import annotations

from collections import Counter

from google.cloud.firestore import DocumentReference


def deep_copy_document_tree(
    src: DocumentReference,
    dst: DocumentReference,
    *,
    write: bool,
    ctr: Counter,
    depth: int,
    max_depth: int,
) -> None:
    """Copy ``src`` subtree to ``dst`` (merge not used; overwrites ``dst`` fields when ``write``).

    When ``write`` is False, only increments ``ctr[\"documents\"]`` (for dry-run sizing).
    """
    if depth > max_depth:
        raise RuntimeError(f"Subtree too deep (>{max_depth}) at path {src.path}")

    ctr["documents"] += 1
    snap = src.get()

    if write:
        data = snap.to_dict()
        if isinstance(data, dict):
            dst.set(data)
        else:
            dst.set({})

    for coll_ref in src.collections():
        for child_snap in coll_ref.stream():
            deep_copy_document_tree(
                child_snap.reference,
                dst.collection(coll_ref.id).document(child_snap.id),
                write=write,
                ctr=ctr,
                depth=depth + 1,
                max_depth=max_depth,
            )


def count_document_subtree(doc_ref: DocumentReference, *, depth: int, max_depth: int) -> int:
    """Return 1 + all nested documents under ``doc_ref`` (subcollections, recursive)."""
    if depth > max_depth:
        raise RuntimeError(f"Subtree too deep (>{max_depth}) at path {doc_ref.path}")
    total = 1
    for coll_ref in doc_ref.collections():
        for snap in coll_ref.stream():
            total += count_document_subtree(
                snap.reference, depth=depth + 1, max_depth=max_depth
            )
    return total
