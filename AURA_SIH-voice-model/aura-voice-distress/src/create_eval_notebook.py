import nbformat as nbf
import os

nb = nbf.v4.new_notebook()

# 1. Imports & Setup
imports = """
import os
import json
import pickle
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns
import shap
import xgboost as xgb
from IPython.display import display, Markdown

# Change to project root
import sys
sys.path.append(os.path.abspath('..'))
from src.explain import explain_prediction, format_explanation
from src.agreement_check import check_agreement

MODELS_DIR = "../models"
DATA_DIR = "../data"

# Load metrics
with open(f"{MODELS_DIR}/tier_a_metrics.json") as f:
    tier_a = json.load(f)
with open(f"{MODELS_DIR}/tier_b_metrics.json") as f:
    tier_b = json.load(f)
with open(f"{MODELS_DIR}/agreement_analysis.json") as f:
    agreement = json.load(f)
    
class_names = tier_a['class_names']
"""
nb.cells.append(nbf.v4.new_code_cell(imports))

# 2. Confusion Matrices
cms = """
fig, axes = plt.subplots(1, 2, figsize=(14, 5))

sns.heatmap(tier_a['confusion_matrix'], annot=True, fmt='d', cmap='Blues', 
            xticklabels=class_names, yticklabels=class_names, ax=axes[0])
axes[0].set_title(f"Tier A (XGBoost) Confusion Matrix\\nMacro F1: {tier_a['macro_f1']:.3f}")
axes[0].set_xlabel('Predicted')
axes[0].set_ylabel('True')

sns.heatmap(tier_b['confusion_matrix'], annot=True, fmt='d', cmap='Oranges', 
            xticklabels=class_names, yticklabels=class_names, ax=axes[1])
axes[1].set_title(f"Tier B ({tier_b['chosen_model']}) Confusion Matrix\\nMacro F1: {tier_b['macro_f1']:.3f}")
axes[1].set_xlabel('Predicted')
axes[1].set_ylabel('True')

plt.tight_layout()
plt.show()
"""
nb.cells.append(nbf.v4.new_markdown_cell("## 1. Confusion Matrices & Performance Comparison"))
nb.cells.append(nbf.v4.new_code_cell(cms))

# 3. Macro F1 Bar Chart
f1_bar = """
plt.figure(figsize=(8, 5))
models = ['Tier A (XGBoost)', f"Tier B ({tier_b['chosen_model']})"]
f1_scores = [tier_a['macro_f1'], tier_b['macro_f1']]

bars = plt.bar(models, f1_scores, color=['#2c3e50', '#e67e22'])
plt.ylim(0, 1.0)
plt.title('Macro F1 Score Comparison (Test Set)')
plt.ylabel('Macro F1 Score')

for bar in bars:
    yval = bar.get_height()
    plt.text(bar.get_x() + bar.get_width()/2, yval + 0.02, f'{yval:.3f}', ha='center', va='bottom', fontweight='bold')

plt.tight_layout()
plt.show()
"""
nb.cells.append(nbf.v4.new_code_cell(f1_bar))

# 4. SHAP Summary (Beeswarm) Plot
shap_plot = """
print("Generating SHAP Summary Plot (Beeswarm) on Test Set...")

# Load artifacts
explainer = pickle.load(open(f"{MODELS_DIR}/shap_explainer.pkl", "rb"))
scaler = pickle.load(open(f"{MODELS_DIR}/tier_a_scaler.pkl", "rb"))
imputer = pickle.load(open(f"{MODELS_DIR}/tier_a_imputer.pkl", "rb"))
feat_cols = pickle.load(open(f"{MODELS_DIR}/feature_columns.pkl", "rb"))
le = pickle.load(open(f"{MODELS_DIR}/label_encoder.pkl", "rb"))

# Load test data
df = pd.read_csv(f"{DATA_DIR}/processed/features.csv")
test_clips = tier_a["test_clip_ids"]
test_df = df[df["filename"].isin(test_clips)].copy()

X_test_raw = test_df[feat_cols].values
X_test = scaler.transform(imputer.transform(X_test_raw))

# Calculate SHAP values
shap_values = explainer.shap_values(X_test)

idx_high = list(le.classes_).index("High")

# shap_values can be a list (one array per class) or a 3D array
if isinstance(shap_values, list):
    sv = shap_values[idx_high]
else:
    sv = shap_values[:, :, idx_high]

# Plot using 'High' distress class SHAP values
shap.summary_plot(sv, X_test, feature_names=feat_cols, show=False)
plt.title(f"SHAP Summary (Beeswarm) - Class: High")
plt.tight_layout()
plt.show()
"""
nb.cells.append(nbf.v4.new_markdown_cell("## 2. Global Feature Importance (SHAP Beeswarm)"))
nb.cells.append(nbf.v4.new_code_cell(shap_plot))

# 5. Agreement Histogram
agree_hist = """
agree_scores = [r["agreement_score"] for r in agreement["per_clip_results"]]
plt.figure(figsize=(8, 5))
plt.hist(agree_scores, bins=20, color='purple', alpha=0.7)
plt.axvline(x=1.0 - agreement["default_threshold"], color='red', linestyle='--', label=f'Threshold ({1.0 - agreement["default_threshold"]})')
plt.title('Distribution of Agreement Scores on Test Set')
plt.xlabel('Agreement Score (1 = Perfect Agreement)')
plt.ylabel('Count')
plt.legend()
plt.show()
"""
nb.cells.append(nbf.v4.new_markdown_cell("## 3. Tier A / Tier B Agreement Scores"))
nb.cells.append(nbf.v4.new_code_cell(agree_hist))

# 6. Worked Examples
examples = """
# Find one example per class
classes = ['Low', 'Moderate', 'High']
example_cids = {}

for cid, true_label in zip(tier_a["test_clip_ids"], tier_a["test_labels"]):
    if true_label in classes and true_label not in example_cids:
        example_cids[true_label] = cid
    if len(example_cids) == 3:
        break

for cls, cid in example_cids.items():
    display(Markdown(f"### Example: True Class = {cls}"))
    
    # 1. Get raw features
    row = df[df["filename"] == cid].iloc[0]
    fv = {c: float(row[c]) for c in feat_cols}
    
    # 2. Get Tier A explanation
    result_a = explain_prediction(fv, top_k=4)
    
    # 3. Get Tier B score
    idx = tier_a["test_clip_ids"].index(cid)
    tb_probs = np.array(tier_b["test_proba"][idx])
    idx_mod = list(le.classes_).index("Moderate")
    idx_high = list(le.classes_).index("High")
    score_b = tb_probs[idx_mod]*50 + tb_probs[idx_high]*100
    
    # 4. Check agreement
    agr = check_agreement(result_a["distress_score"], tb_probs, threshold=agreement["default_threshold"], label_classes=list(le.classes_))
    conf_str = "Low (Divergence exceeds threshold)" if agr["low_confidence"] else "High"
    
    # 5. Format output
    score_a = result_a["distress_score"]
    tier_name = "Green" if score_a < 33 else "Amber" if score_a < 66 else "Red"
    
    out = f"**Voice Distress Sub-Score:** {score_a:.0f}/100 (Tier: {tier_name})\\n"
    for f in result_a["top_factors"]:
        sign = "+" if f["contribution"] > 0 else "-"
        out += f"{sign} {f['human_label']} ({f['contribution']:+.1f})\\n"
    
    out += f"**Confidence:** {conf_str} (Tier A / Tier B agreement: {agr['agreement_score']:.2f})"
    
    display(Markdown("```text\\n" + out + "\\n```"))
"""
nb.cells.append(nbf.v4.new_markdown_cell("## 4. Worked Examples"))
nb.cells.append(nbf.v4.new_code_cell(examples))

# Write to file
os.makedirs("../notebooks", exist_ok=True)
with open("../notebooks/02_model_evaluation.ipynb", "w") as f:
    nbf.write(nb, f)
print("Notebook created at notebooks/02_model_evaluation.ipynb")
