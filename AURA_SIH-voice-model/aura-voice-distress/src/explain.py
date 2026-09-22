"""
AURA Voice Distress Detection — Phase 2, Step 3
Explainability Module

Provides human-readable explanations of Tier A predictions using SHAP
values. Designed for counsellor-facing output under the PoA Act aftercare
system.

Worked Example
--------------
>>> from src.explain import explain_prediction
>>> features = {
...     "pitch_mean": 280.5, "pitch_std": 5.2, "pitch_range": 12.0,
...     "jitter": 0.032, "shimmer": 0.14, "hnr": 8.5,
...     "speech_rate": 1.8, "pause_ratio": 0.45, "mean_pause_length": 1.2,
...     "spectral_centroid_mean": 3200, "spectral_rolloff_mean": 6500,
...     "zcr_mean": 0.08,
...     "mfcc_1_mean": -85, "mfcc_1_std": 15, "mfcc_2_mean": 10, ...
... }
>>> result = explain_prediction(features, top_k=4)
>>> result
{
    "distress_score": 71.3,
    "predicted_class": "High",
    "top_factors": [
        {"feature": "pitch_std", "human_label": "Flattened pitch variance",
         "contribution": 18.2, "direction": "increases_distress"},
        {"feature": "pause_ratio", "human_label": "Elevated pause ratio",
         "contribution": 14.1, "direction": "increases_distress"},
        {"feature": "speech_rate", "human_label": "Reduced speech rate",
         "contribution": 9.3, "direction": "increases_distress"},
        {"feature": "hnr", "human_label": "Voice quality (HNR)",
         "contribution": -4.0, "direction": "decreases_distress"},
    ]
}
"""

import os
import pickle
import numpy as np
import pandas as pd
import xgboost as xgb

MODELS_DIR = "models"

# ── Human-readable feature labels ──────────────────────────────────────
# These are shown to counsellors — phrased to be clear, factual, and
# non-alarming. They describe the acoustic observation, not a diagnosis.
FEATURE_HUMAN_LABELS = {
    "pitch_mean":              "Average voice pitch",
    "pitch_std":               "Pitch variability (monotone vs. expressive)",
    "pitch_range":             "Pitch range (highest to lowest)",
    "jitter":                  "Voice micro-tremor (jitter)",
    "shimmer":                 "Voice amplitude instability (shimmer)",
    "hnr":                     "Voice quality (harmonic-to-noise ratio)",
    "speech_rate":             "Speaking pace (syllables per second)",
    "pause_ratio":             "Proportion of silent pauses in speech",
    "mean_pause_length":       "Average pause duration between phrases",
    "spectral_centroid_mean":  "Voice brightness (spectral centroid)",
    "spectral_rolloff_mean":   "High-frequency voice energy",
    "zcr_mean":                "Voice noisiness (zero-crossing rate)",
    "mfcc_1_mean":             "Overall speech energy profile",
    "mfcc_1_std":              "Variability in speech energy",
    "mfcc_2_mean":             "Vocal tract shape (formant 1)",
    "mfcc_2_std":              "Variability in vocal tract shape",
    "mfcc_3_mean":             "Vocal resonance pattern",
    "mfcc_3_std":              "Variability in vocal resonance",
    "mfcc_4_mean":             "Speech articulation pattern",
    "mfcc_4_std":              "Variability in articulation",
    "mfcc_5_mean":             "Fine speech texture (MFCC-5)",
    "mfcc_5_std":              "Variability in speech texture",
    "mfcc_6_mean":             "Vocal quality detail (MFCC-6)",
    "mfcc_6_std":              "Variability in vocal quality",
    "mfcc_7_mean":             "Speech spectral detail (MFCC-7)",
    "mfcc_7_std":              "Variability in spectral detail",
    "mfcc_8_mean":             "Speech harmonic structure (MFCC-8)",
    "mfcc_8_std":              "Variability in harmonic structure",
    "mfcc_9_mean":             "Speech formant detail (MFCC-9)",
    "mfcc_9_std":              "Variability in formant detail",
    "mfcc_10_mean":            "High-order speech texture (MFCC-10)",
    "mfcc_10_std":             "Variability (MFCC-10)",
    "mfcc_11_mean":            "Fine spectral detail (MFCC-11)",
    "mfcc_11_std":             "Variability (MFCC-11)",
    "mfcc_12_mean":            "Fine spectral detail (MFCC-12)",
    "mfcc_12_std":             "Variability (MFCC-12)",
    "mfcc_13_mean":            "Fine spectral detail (MFCC-13)",
    "mfcc_13_std":             "Variability (MFCC-13)",
}


def _load_artifacts():
    """Load all saved model artifacts needed for explanation."""
    model = xgb.XGBClassifier()
    model.load_model(os.path.join(MODELS_DIR, "tier_a_xgb.json"))

    explainer = pickle.load(open(os.path.join(MODELS_DIR, "shap_explainer.pkl"), "rb"))
    scaler = pickle.load(open(os.path.join(MODELS_DIR, "tier_a_scaler.pkl"), "rb"))
    imputer = pickle.load(open(os.path.join(MODELS_DIR, "tier_a_imputer.pkl"), "rb"))
    le = pickle.load(open(os.path.join(MODELS_DIR, "label_encoder.pkl"), "rb"))
    feat_cols = pickle.load(open(os.path.join(MODELS_DIR, "feature_columns.pkl"), "rb"))

    return model, explainer, scaler, imputer, le, feat_cols


def explain_prediction(feature_vector: dict, top_k: int = 4) -> dict:
    """
    Generate an explainable distress score from a single feature vector.

    Parameters
    ----------
    feature_vector : dict
        Raw feature values keyed by column name (e.g. {"pitch_mean": 250.3, ...}).
        Must contain all feature columns used during training.
    top_k : int
        Number of top contributing features to return (default 4).

    Returns
    -------
    dict with keys:
        - distress_score (float): 0-100 severity index
        - predicted_class (str): "Low" / "Moderate" / "High"
        - probabilities (dict): per-class probabilities
        - top_factors (list[dict]): top_k features by |SHAP contribution|
    """
    model, explainer, scaler, imputer, le, feat_cols = _load_artifacts()

    # Build feature array in correct column order
    raw = np.array([[feature_vector.get(c, np.nan) for c in feat_cols]])
    X = imputer.transform(raw)
    X = scaler.transform(X)

    # Predict
    proba = model.predict_proba(X)[0]
    pred_idx = int(np.argmax(proba))
    pred_class = le.inverse_transform([pred_idx])[0]

    classes = list(le.classes_)
    idx_mod = classes.index("Moderate")
    idx_high = classes.index("High")
    score = float(proba[idx_mod] * 50 + proba[idx_high] * 100)

    # SHAP values — pick the SHAP values for the predicted class
    shap_values = explainer.shap_values(X)

    # shap_values can be a list (one array per class) or a 3D array
    if isinstance(shap_values, list):
        # Use the SHAP values for the "High" class as the distress direction
        sv = shap_values[idx_high][0]
    else:
        sv = shap_values[0, :, idx_high]

    # Rank features by |SHAP value|
    abs_sv = np.abs(sv)
    top_indices = np.argsort(abs_sv)[::-1][:top_k]

    top_factors = []
    for idx in top_indices:
        feat_name = feat_cols[idx]
        shap_val = float(sv[idx])
        human_label = FEATURE_HUMAN_LABELS.get(feat_name, feat_name)
        direction = "increases_distress" if shap_val > 0 else "decreases_distress"
        top_factors.append({
            "feature": feat_name,
            "human_label": human_label,
            "contribution": round(shap_val, 2),
            "direction": direction,
        })

    return {
        "distress_score": round(score, 1),
        "predicted_class": pred_class,
        "probabilities": {c: round(float(proba[i]), 4) for i, c in enumerate(classes)},
        "top_factors": top_factors,
    }


def format_explanation(result: dict) -> str:
    """
    Format an explanation result into a counsellor-facing text block.

    Example output:
        Voice Distress Sub-Score: 71/100 (Tier: Amber)
         + Flattened pitch variance (+18.2)
         + Elevated pause ratio (+14.1)
         + Reduced speech rate (+9.3)
         - Stable voice quality (HNR) (-4.0)
    """
    score = result["distress_score"]
    if score < 33:
        tier = "Green"
    elif score < 66:
        tier = "Amber"
    else:
        tier = "Red"

    lines = [f"Voice Distress Sub-Score: {score:.0f}/100 (Tier: {tier})"]
    for f in result["top_factors"]:
        sign = "+" if f["contribution"] > 0 else "-"
        lines.append(f"  {sign} {f['human_label']} ({f['contribution']:+.1f})")

    return "\n".join(lines)


if __name__ == "__main__":
    # Quick demo: explain the first test clip
    import json

    with open(os.path.join(MODELS_DIR, "tier_a_metrics.json")) as f:
        metrics = json.load(f)

    df = pd.read_csv(os.path.join("data", "processed", "features.csv"))
    test_clip = metrics["test_clip_ids"][0]
    row = df[df["filename"] == test_clip].iloc[0]

    feat_cols = pickle.load(open(os.path.join(MODELS_DIR, "feature_columns.pkl"), "rb"))
    fv = {c: float(row[c]) for c in feat_cols}

    result = explain_prediction(fv, top_k=4)
    print(format_explanation(result))
    print(f"\nFull result: {json.dumps(result, indent=2)}")
