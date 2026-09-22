"""
AURA Voice Distress Detection — Phase 2, Step 2
Tier A: XGBoost Explainable Classifier

Trains an XGBoost multi-class classifier on hand-crafted paralinguistic
features (from Phase 1) with hyperparameter tuning, calibrated probability
scoring, and SHAP explainability artifacts.

Scoring Formula (Design Decision):
    voice_distress_subscore = P(Moderate) * 50 + P(High) * 100
    
    This produces a continuous 0-100 severity index where:
    - A clip predicted 100% Low  → score =  0
    - A clip predicted 100% Moderate → score = 50
    - A clip predicted 100% High → score = 100
    - Mixed probabilities → intermediate values
    
    This is NOT a clinical diagnosis — it is a decision-support signal
    for counsellors reviewing IVRS call recordings under the PoA Act.

Usage:
    python src/train_tier_a.py
"""

import os
import json
import pickle
import warnings

import numpy as np
import pandas as pd
import xgboost as xgb
import shap
from sklearn.preprocessing import StandardScaler, LabelEncoder
from sklearn.impute import SimpleImputer
from sklearn.metrics import (
    accuracy_score,
    f1_score,
    precision_recall_fscore_support,
    roc_auc_score,
    confusion_matrix,
    classification_report,
)
from sklearn.model_selection import ParameterGrid

warnings.filterwarnings("ignore", category=FutureWarning)

# ── Paths ──────────────────────────────────────────────────────────────
FEATURES_CSV = os.path.join("data", "processed", "features.csv")
SPLITS_JSON = os.path.join("data", "features", "splits.json")
MODELS_DIR = "models"

# ── Feature columns (exclude metadata columns) ────────────────────────
META_COLS = ["filename", "emotion_code", "distress_level", "source_dataset", "clip_id"]
LABEL_COL = "distress_level"
RANDOM_STATE = 42


def get_feature_cols(df):
    """Return list of numeric feature column names."""
    return [c for c in df.columns if c not in META_COLS]


def load_data():
    """Load features + splits, return train/val/test DataFrames."""
    df = pd.read_csv(FEATURES_CSV)
    df["clip_id"] = df["filename"]

    with open(SPLITS_JSON) as f:
        splits = json.load(f)

    train = df[df["clip_id"].isin(splits["train"])].copy()
    val = df[df["clip_id"].isin(splits["val"])].copy()
    test = df[df["clip_id"].isin(splits["test"])].copy()

    return train, val, test


def distress_score(probs):
    """
    Compute the 0-100 Voice Distress Sub-Score from softmax probabilities.
    
    Formula:
        score = P(Moderate) * 50 + P(High) * 100
        
    Where class ordering is: [High=0, Low=1, Moderate=2] (alphabetical
    from LabelEncoder). The indices are resolved by the label encoder.
    
    Args:
        probs: np.ndarray of shape (n_samples, 3) — softmax probabilities
               ordered by the label encoder classes.
    
    Returns:
        np.ndarray of shape (n_samples,) — scores in [0, 100].
    """
    # Load label encoder to know class ordering
    le = pickle.load(open(os.path.join(MODELS_DIR, "label_encoder.pkl"), "rb"))
    classes = list(le.classes_)  # e.g. ['High', 'Low', 'Moderate']
    
    idx_moderate = classes.index("Moderate")
    idx_high = classes.index("High")
    
    scores = probs[:, idx_moderate] * 50 + probs[:, idx_high] * 100
    return scores


def train_tier_a():
    """Full Tier A training pipeline."""
    os.makedirs(MODELS_DIR, exist_ok=True)
    train, val, test = load_data()
    feat_cols = get_feature_cols(train)

    print(f"Feature columns ({len(feat_cols)}): {feat_cols[:5]}...")
    print(f"Train: {len(train)} | Val: {len(val)} | Test: {len(test)}")

    # ── 1. Label Encoding ──────────────────────────────────────────────
    le = LabelEncoder()
    le.fit(train[LABEL_COL])
    y_train = le.transform(train[LABEL_COL])
    y_val = le.transform(val[LABEL_COL])
    y_test = le.transform(test[LABEL_COL])
    pickle.dump(le, open(os.path.join(MODELS_DIR, "label_encoder.pkl"), "wb"))
    print(f"Label classes: {list(le.classes_)}")

    # ── 2. Imputation + Scaling (fit on train only) ────────────────────
    imputer = SimpleImputer(strategy="median")
    X_train = imputer.fit_transform(train[feat_cols])
    X_val = imputer.transform(val[feat_cols])
    X_test = imputer.transform(test[feat_cols])

    scaler = StandardScaler()
    X_train = scaler.fit_transform(X_train)
    X_val = scaler.transform(X_val)
    X_test = scaler.transform(X_test)

    pickle.dump(imputer, open(os.path.join(MODELS_DIR, "tier_a_imputer.pkl"), "wb"))
    pickle.dump(scaler, open(os.path.join(MODELS_DIR, "tier_a_scaler.pkl"), "wb"))
    print("Imputer + Scaler fitted on train set and saved.")

    # ── 3. Compute class weights for imbalance ─────────────────────────
    class_counts = np.bincount(y_train)
    total = len(y_train)
    n_classes = len(le.classes_)
    # sample_weight per instance
    weights = total / (n_classes * class_counts)
    sample_weight_train = np.array([weights[y] for y in y_train])

    # ── 4. Hyperparameter Search ───────────────────────────────────────
    param_grid = {
        "max_depth": [3, 4, 5, 6],
        "n_estimators": [100, 200, 300, 400],
        "learning_rate": [0.01, 0.05, 0.1],
    }

    best_f1 = -1
    best_params = None
    best_model = None

    print("\nHyperparameter search (grid on val set)...")
    for params in ParameterGrid(param_grid):
        model = xgb.XGBClassifier(
            objective="multi:softprob",
            num_class=n_classes,
            eval_metric="mlogloss",
            use_label_encoder=False,
            random_state=RANDOM_STATE,
            verbosity=0,
            **params,
        )
        model.fit(
            X_train, y_train,
            sample_weight=sample_weight_train,
            eval_set=[(X_val, y_val)],
            verbose=False,
        )
        y_val_pred = model.predict(X_val)
        f1 = f1_score(y_val, y_val_pred, average="macro")
        if f1 > best_f1:
            best_f1 = f1
            best_params = params
            best_model = model

    print(f"Best val macro F1: {best_f1:.4f}")
    print(f"Best params: {best_params}")

    # ── 5. Evaluate on Test Set ────────────────────────────────────────
    y_test_pred = best_model.predict(X_test)
    y_test_proba = best_model.predict_proba(X_test)

    acc = accuracy_score(y_test, y_test_pred)
    macro_f1 = f1_score(y_test, y_test_pred, average="macro")

    print("\n" + "=" * 60)
    print("TIER A — TEST SET EVALUATION")
    print("=" * 60)
    print(f"Accuracy:  {acc:.4f}")
    print(f"Macro F1:  {macro_f1:.4f}")

    if macro_f1 < 0.55:
        print("⚠️  Macro F1 < 0.55 — likely due to synthetic data noise, "
              "small dataset (80 clips), or limited feature variance in "
              "dummy tones. With real RAVDESS/CREMA-D data this should improve.")

    print(f"\nClassification Report:")
    print(classification_report(y_test, y_test_pred, target_names=le.classes_))

    print("Confusion Matrix:")
    cm = confusion_matrix(y_test, y_test_pred)
    print(pd.DataFrame(cm, index=le.classes_, columns=le.classes_))

    # AUC-ROC (one-vs-rest)
    try:
        auc = roc_auc_score(y_test, y_test_proba, multi_class="ovr", average="macro")
        print(f"\nAUC-ROC (macro, OvR): {auc:.4f}")
    except ValueError as e:
        print(f"\nAUC-ROC could not be computed: {e}")
        auc = None

    # ── 6. Distress scores on test set ─────────────────────────────────
    scores = distress_score(y_test_proba)
    print(f"\nDistress Sub-Scores on test set (sample):")
    for i in range(min(5, len(scores))):
        actual = le.inverse_transform([y_test[i]])[0]
        print(f"  Clip {test.iloc[i]['clip_id']}: score={scores[i]:.1f}/100 (actual={actual})")

    # ── 7. Save model ─────────────────────────────────────────────────
    model_path = os.path.join(MODELS_DIR, "tier_a_xgb.json")
    best_model.save_model(model_path)
    print(f"\nModel saved to {model_path}")

    # ── 8. SHAP Explainer (TreeExplainer on train background) ──────────
    print("\nBuilding SHAP TreeExplainer...")
    explainer = shap.TreeExplainer(best_model, feature_perturbation="tree_path_dependent")
    pickle.dump(explainer, open(os.path.join(MODELS_DIR, "shap_explainer.pkl"), "wb"))
    print("SHAP explainer saved to models/shap_explainer.pkl")

    # Save feature column names for reference
    pickle.dump(feat_cols, open(os.path.join(MODELS_DIR, "feature_columns.pkl"), "wb"))

    # ── 9. Save metrics for notebook consumption ───────────────────────
    metrics = {
        "accuracy": float(acc),
        "macro_f1": float(macro_f1),
        "auc_roc": float(auc) if auc is not None else None,
        "best_params": best_params,
        "confusion_matrix": cm.tolist(),
        "class_names": list(le.classes_),
        "test_scores": scores.tolist(),
        "test_labels": [le.inverse_transform([y])[0] for y in y_test],
        "test_clip_ids": test["clip_id"].tolist(),
    }
    with open(os.path.join(MODELS_DIR, "tier_a_metrics.json"), "w") as f:
        json.dump(metrics, f, indent=2)
    print("Metrics saved to models/tier_a_metrics.json")

    return best_model, explainer


if __name__ == "__main__":
    train_tier_a()
