import pytest
from fastapi.testclient import TestClient
import time
import os

import sys
sys.path.append(os.path.abspath('.'))

from api.main import app

def test_health_check():
    with TestClient(app) as client:
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"
        assert response.json()["models_loaded"] is True

def test_inference_endpoints():
    clips_dir = "tests/sample_clips"
    clip_files = [f for f in os.listdir(clips_dir) if f.endswith(".wav")]
    
    assert len(clip_files) > 0, "No sample clips found for testing"
    
    print("\n" + "="*50)
    print("API INFERENCE LATENCY & RESULTS TEST")
    print("="*50)
    
    latencies = []
    
    with TestClient(app) as client:
        for clip in clip_files:
            clip_path = os.path.join(clips_dir, clip)
            
            start_time = time.time()
            
            with open(clip_path, "rb") as f:
                response = client.post(
                    "/v1/voice/analyse/upload",
                    data={"session_id": f"test-session-{clip}"},
                    files={"file": (clip, f, "audio/wav")}
                )
            
        latency = time.time() - start_time
        latencies.append(latency)
        
        assert response.status_code == 200, f"Request failed with {response.status_code}: {response.text}"
        data = response.json()
        
        # Schema assertions
        assert "session_id" in data
        assert "voice_distress_subscore" in data
        assert "confidence" in data
        assert "tier_ab_agreement" in data
        assert "top_factors" in data
        assert "flags" in data
        
        if latency > 3.0:
            print(f"⚠️ WARNING: Latency for {clip} exceeded 3.0 seconds ({latency:.2f}s)")
            
        # Format the block as requested
        score = data['voice_distress_subscore']
        score_str = f"{score}/100" if score is not None else "None"
        
        tier = "Green"
        if score is not None:
            if score >= 66: tier = "Red"
            elif score >= 33: tier = "Amber"
            
        conf = data['confidence']
        agr = data['tier_ab_agreement']
        factors = ", ".join([f"{f['human_label']} ({'+' if f['contribution'] > 0 else ''}{int(f['contribution'])})" for f in data['top_factors']])
        
        print(f"\nClip: {clip}")
        print(f"-> Score: {score_str} | Tier: {tier} | Confidence: {conf} (agreement {agr:.2f})")
        print(f"-> Latency: {latency:.2f}s")
        if factors:
            print(f"-> Top factors: {factors}")
        if data['flags']:
            print(f"-> Flags: {data['flags']}")
            
    avg_latency = sum(latencies)/len(latencies)
    print("\n" + "-"*50)
    print(f"Average latency: {avg_latency:.2f}s")
    print("-" * 50)
    
if __name__ == "__main__":
    # If run directly as a script
    test_health_check()
    test_inference_endpoints()
