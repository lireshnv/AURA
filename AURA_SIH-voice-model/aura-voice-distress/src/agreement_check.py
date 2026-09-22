"""
AURA Voice Distress Detection — Phase 2, Step 5
Two-Tier Agreement Check

Compares Tier A and Tier B distress scores and flags low-confidence
predictions when they diverge beyond a configurable threshold.

Usage:
    python src/agreement_check.py          # runs analysis on test set
"""

import os
import json
import numpy as np
import pandas as pd

MODELS_DIR = "models"


def check_agreement(
    tier_a_score: float,
    tier_b_probs: np.ndarray,
    threshold: float = 0.25,
    label_classes: list = None,
) -> dict:
    """
    Compare Tier A and Tier B distress scores and determine agreement.

    Parameters
    ----------
    tier_a_score : float
        Tier A Voice Distress Sub-Score (0-100), computed as
        P(Moderate)*50 + P(High)*100.
    tier_b_probs : np.ndarray
        Tier B softmax probabilities, shape (n_classes,), ordered by
        the LabelEncoder classes (alphabetical: High, Low, Moderate).
    threshold : float
        Maximum normalized absolute difference before flagging
        low_confidence. Default 0.25 (i.e. 25% of the 0-100 scale).
    label_classes : list, optional
        Class names from LabelEncoder (e.g. ['High', 'Low', 'Moderate']).
        If None, assumes alphabetical order.

    Returns
    -------
    dict with keys:
        - agreement_score: float in [0, 1] — 1 = perfect agreement
        - low_confidence: bool — True if divergence > threshold
        - tier_a_score: float
        - tier_b_score: float
        - normalized_diff: float — |A - B| / 100
    """
    if label_classes is None:
        label_classes = ["High", "Low", "Moderate"]

    idx_mod = label_classes.index("Moderate")
    idx_high = label_classes.index("High")

    # Convert Tier B probs to the same 0-100 severity index
    tier_b_score = float(tier_b_probs[idx_mod] * 50 + tier_b_probs[idx_high] * 100)

    # Normalized absolute difference (0-1 scale)
    norm_diff = abs(tier_a_score - tier_b_score) / 100.0

    return {
        "agreement_score": round(1.0 - norm_diff, 4),
        "low_confidence": bool(norm_diff > threshold),
        "tier_a_score": round(tier_a_score, 2),
        "tier_b_score": round(tier_b_score, 2),
        "normalized_diff": round(norm_diff, 4),
    }


def run_test_set_analysis():
    """
    Run agreement check across the full test set and report statistics.
    Also sweep thresholds to produce a coverage table.
    """
    # Load Tier A metrics
    with open(os.path.join(MODELS_DIR, "tier_a_metrics.json")) as f:
        tier_a_metrics = json.load(f)

    # Load Tier B metrics
    with open(os.path.join(MODELS_DIR, "tier_b_metrics.json")) as f:
        tier_b_metrics = json.load(f)

    tier_a_scores = tier_a_metrics["test_scores"]
    tier_b_probas = np.array(tier_b_metrics["test_proba"])
    class_names = tier_a_metrics["class_names"]
    clip_ids = tier_a_metrics["test_clip_ids"]
    true_labels = tier_a_metrics["test_labels"]

    print("=" * 65)
    print("AGREEMENT CHECK — TEST SET ANALYSIS")
    print("=" * 65)

    # ── Per-clip agreement ─────────────────────────────────────────────
    print(f"\n{'Clip':<35} {'TrueLabel':<10} {'TierA':>6} {'TierB':>6} {'Agree':>6} {'LowConf'}")
    print("-" * 85)

    results = []
    for i, (cid, ta_score) in enumerate(zip(clip_ids, tier_a_scores)):
        tb_probs = tier_b_probas[i]
        result = check_agreement(ta_score, tb_probs, threshold=0.25, label_classes=class_names)
        result["clip_id"] = cid
        result["true_label"] = true_labels[i] if i < len(true_labels) else "?"
        results.append(result)

        flag = "[LOW CONF]" if result["low_confidence"] else "[OK]"
        print(f"  {cid:<33} {result['true_label']:<10} {result['tier_a_score']:>6.1f} "
              f"{result['tier_b_score']:>6.1f} {result['agreement_score']:>6.2f} {flag}")

    # ── Threshold Sweep ────────────────────────────────────────────────
    print("\n" + "=" * 65)
    print("THRESHOLD SWEEP")
    print("=" * 65)
    print(f"\n{'Threshold':>10} │ {'AgreementRate':>14} │ {'Coverage':>10} │ {'FlaggedLowConf':>15}")
    print("─" * 60)

    sweep_results = []
    for threshold in [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40]:
        n_agree = 0
        for i, ta_score in enumerate(tier_a_scores):
            tb_probs = tier_b_probas[i]
            r = check_agreement(ta_score, tb_probs, threshold=threshold, label_classes=class_names)
            if not r["low_confidence"]:
                n_agree += 1

        agree_rate = n_agree / len(tier_a_scores) if tier_a_scores else 0
        coverage = agree_rate  # coverage = % of clips that get a confident score
        flagged = 1.0 - agree_rate

        sweep_results.append({
            "threshold": threshold,
            "agreement_rate": round(agree_rate, 4),
            "coverage": round(coverage, 4),
            "flagged_pct": round(flagged, 4),
        })
        print(f"  {threshold:>8.2f} │ {agree_rate:>13.1%} │ {coverage:>9.1%} │ {flagged:>14.1%}")

    # Save results
    analysis = {
        "per_clip_results": results,
        "threshold_sweep": sweep_results,
        "default_threshold": 0.25,
        "n_test_clips": len(tier_a_scores),
    }
    with open(os.path.join(MODELS_DIR, "agreement_analysis.json"), "w") as f:
        json.dump(analysis, f, indent=2)
    print(f"\nFull analysis saved to models/agreement_analysis.json")


if __name__ == "__main__":
    run_test_set_analysis()
