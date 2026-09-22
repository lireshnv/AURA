import os
import sys
import random
from fastapi.testclient import TestClient

sys.path.append(os.path.abspath('.'))

from api.main import app
from api.fusion import fuse_scores

def run_demo():
    clips = {
        "Low Distress": "tests/sample_clips/sample_low.wav",
        "Moderate Distress": "tests/sample_clips/sample_moderate.wav",
        "High Distress": "tests/sample_clips/sample_high.wav"
    }

    print("\n" + "="*70)
    print("AURA VOICE/SPEECH DISTRESS DETECTION - LIVE INFERENCE DEMO")
    print("="*70)

    with TestClient(app) as client:
        for label, clip_path in clips.items():
            print(f"\nPROCESSING CLIP: {os.path.basename(clip_path)}")
            print(f"Expected Profile: {label}")
            print("-" * 50)
            
            # 1. Simulate API call
            with open(clip_path, "rb") as f:
                response = client.post(
                    "/v1/voice/analyse/upload",
                    data={"session_id": "demo-session-001"},
                    files={"file": (os.path.basename(clip_path), f, "audio/wav")}
                )
            
            if response.status_code != 200:
                print(f"Error: {response.text}")
                continue
                
            data = response.json()
            
            # 2. Print Voice Distress Sub-Score Block
            score = data['voice_distress_subscore']
            score_str = f"{score}/100" if score is not None else "N/A"
            
            tier_a = "Green"
            if score is not None:
                if score >= 66: tier_a = "Red"
                elif score >= 33: tier_a = "Amber"
                
            conf = data['confidence']
            agr = data['tier_ab_agreement']
            
            print(f"Voice Distress Sub-Score: {score_str} (Tier: {tier_a})")
            print(f"Confidence Cross-Check: {conf.upper()} (Tier A/B Agreement: {agr:.2f})")
            
            if data['top_factors']:
                print("Explainability Factors (SHAP):")
                for f in data['top_factors']:
                    sign = "+" if f['contribution'] > 0 else "-"
                    print(f"  {sign} {f['human_label']} ({f['contribution']:+.1f})")
                    
            if data['flags']:
                print(f"Flags: {', '.join(data['flags'])}")
                
            # 3. Phase 4 Fusion (Dynamic Distress Score)
            print("\n--- PHASE 4: DYNAMIC DISTRESS SCORE FUSION ---")
            
            # Make up plausible text and engagement scores
            if label == "Low Distress":
                text_score = random.uniform(10, 30)
                eng_score = random.uniform(10, 30)
            elif label == "Moderate Distress":
                text_score = random.uniform(40, 60)
                eng_score = random.uniform(40, 60)
            else:
                text_score = random.uniform(70, 90)
                eng_score = random.uniform(70, 90)
                
            print(f"Input Streams:")
            print(f" - NLP Text Score: {text_score:.1f}")
            print(f" - Engagement Score: {eng_score:.1f}")
            print(f" - Voice Score: {score if score is not None else 'N/A'}")
            
            fusion_res = fuse_scores(text_score, score, eng_score)
            
            print(f"\n=> FINAL DYNAMIC DISTRESS SCORE: {fusion_res['dynamic_distress_score']}/100")
            print(f"=> OVERALL TRIAGE TIER: {fusion_res['tier'].upper()}")
            print("=" * 70)
        
if __name__ == "__main__":
    run_demo()
