"""
AURA Voice Distress Detection — Smoke Test
Loads all saved models from disk and runs one end-to-end prediction
with no training code. If this passes, your artifacts are portable.

Usage:
    python src/smoke_test_models.py
"""

import os
import json
import pickle
import numpy as np
import pandas as pd
import xgboost as xgb

MODELS_DIR = "models"
FEATURES_CSV = os.path.join("data", "processed", "features.csv")


def smoke_test():
    print("=" * 60)
    print("SMOKE TEST — Loading all saved artifacts")
    print("=" * 60)

    # 1. Load Tier A model
    print("\n1. Loading Tier A XGBoost model...")
    model_a = xgb.XGBClassifier()
    model_a.load_model(os.path.join(MODELS_DIR, "tier_a_xgb.json"))
    print("   [OK] tier_a_xgb.json loaded")

    # 2. Load preprocessing artifacts
    print("2. Loading preprocessing artifacts...")
    scaler = pickle.load(open(os.path.join(MODELS_DIR, "tier_a_scaler.pkl"), "rb"))
    imputer = pickle.load(open(os.path.join(MODELS_DIR, "tier_a_imputer.pkl"), "rb"))
    le = pickle.load(open(os.path.join(MODELS_DIR, "label_encoder.pkl"), "rb"))
    feat_cols = pickle.load(open(os.path.join(MODELS_DIR, "feature_columns.pkl"), "rb"))
    print(f"   [OK] scaler, imputer, label_encoder, feature_columns loaded")
    print(f"   Classes: {list(le.classes_)}")

    # 3. Load SHAP explainer
    print("3. Loading SHAP explainer...")
    explainer = pickle.load(open(os.path.join(MODELS_DIR, "shap_explainer.pkl"), "rb"))
    print("   [OK] shap_explainer.pkl loaded")

    # 4. Load Tier B model
    print("4. Loading Tier B head...")
    tier_b = pickle.load(open(os.path.join(MODELS_DIR, "tier_b_head.pkl"), "rb"))
    scaler_b = pickle.load(open(os.path.join(MODELS_DIR, "tier_b_scaler.pkl"), "rb"))
    print(f"   [OK] tier_b_head.pkl loaded ({type(tier_b).__name__})")

    # 5. Run a prediction on a sample clip
    print("\n5. Running end-to-end prediction on a sample clip...")
    df = pd.read_csv(FEATURES_CSV)
    sample = df.iloc[0]
    clip_id = sample["filename"]
    true_label = sample["distress_level"]

    # Tier A prediction
    raw = np.array([[sample[c] for c in feat_cols]])
    X_a = imputer.transform(raw)
    X_a = scaler.transform(X_a)

    proba_a = model_a.predict_proba(X_a)[0]
    pred_a = le.inverse_transform([np.argmax(proba_a)])[0]

    classes = list(le.classes_)
    idx_mod = classes.index("Moderate")
    idx_high = classes.index("High")
    score_a = proba_a[idx_mod] * 50 + proba_a[idx_high] * 100

    # SHAP explanation
    shap_vals = explainer.shap_values(X_a)
    if isinstance(shap_vals, list):
        sv = shap_vals[idx_high][0]
    else:
        sv = shap_vals[0, :, idx_high]
    top_idx = np.argsort(np.abs(sv))[::-1][:3]
    top_features = [(feat_cols[i], float(sv[i])) for i in top_idx]

    # Tier B prediction (using cached embeddings if available)
    embed_file = os.path.join("data", "features", "embeddings.npy")
    embed_index_file = os.path.join("data", "features", "embedding_clip_ids.json")

    if os.path.exists(embed_file) and os.path.exists(embed_index_file):
        embeddings = np.load(embed_file)
        with open(embed_index_file) as f:
            embed_cids = json.load(f)
        if clip_id in embed_cids:
            idx = embed_cids.index(clip_id)
            X_b = scaler_b.transform(embeddings[idx:idx + 1])
            proba_b = tier_b.predict_proba(X_b)[0]
            score_b = proba_b[idx_mod] * 50 + proba_b[idx_high] * 100
        else:
            score_b = None
            proba_b = None
    else:
        score_b = None
        proba_b = None

    # Agreement check
    from src.agreement_check import check_agreement
    if proba_b is not None:
        agreement = check_agreement(score_a, proba_b, threshold=0.25, label_classes=classes)
    else:
        agreement = {"agreement_score": "N/A (no embeddings)", "low_confidence": "N/A"}

    # Print results
    print(f"\n   Clip: {clip_id}")
    print(f"   True label: {true_label}")
    print(f"   Tier A prediction: {pred_a} (score: {score_a:.1f}/100)")
    print(f"   Tier A probs: {dict(zip(classes, [f'{p:.3f}' for p in proba_a]))}")
    if score_b is not None:
        print(f"   Tier B score: {score_b:.1f}/100")
    print(f"   Agreement: {agreement}")
    print(f"   Top SHAP features:")
    for feat, val in top_features:
        sign = "+" if val > 0 else "-"
        print(f"     {sign} {feat}: {val:+.3f}")

    print("\n" + "=" * 60)
    print("✓ SMOKE TEST PASSED — All artifacts loaded and functional".encode('cp1252', errors='replace').decode('cp1252'))
    print("=" * 60)


if __name__ == "__main__":
    smoke_test()
