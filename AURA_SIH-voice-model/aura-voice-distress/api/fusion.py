def fuse_scores(text_score: float, voice_score: float | None, engagement_score: float, 
                weights: dict = {"text": 0.40, "voice": 0.35, "engagement": 0.25}) -> dict:
    """
    Combines independent sub-scores into a Dynamic Distress Score.
    If voice_score is missing (None), its weight is distributed proportionally 
    to text and engagement.
    """
    w_text = weights["text"]
    w_voice = weights["voice"]
    w_eng = weights["engagement"]
    
    if voice_score is None:
        total_remaining = w_text + w_eng
        w_text = w_text / total_remaining
        w_eng = w_eng / total_remaining
        final_score = (text_score * w_text) + (engagement_score * w_eng)
    else:
        final_score = (text_score * w_text) + (voice_score * w_voice) + (engagement_score * w_eng)
        
    final_score = int(round(final_score))
    
    if final_score < 40:
        tier = "Green"
    elif final_score < 70:
        tier = "Amber"
    else:
        tier = "Red"
        
    return {
        "dynamic_distress_score": final_score,
        "tier": tier
    }

if __name__ == "__main__":
    print("--- FUSION EXAMPLES ---")
    
    # 1. All signals present, moderate distress
    res = fuse_scores(text_score=45.0, voice_score=60.0, engagement_score=30.0)
    print(f"1. All signals present (Text=45, Voice=60, Eng=30) -> {res}")
    
    # 2. Voice missing, but text and engagement are high
    res2 = fuse_scores(text_score=85.0, voice_score=None, engagement_score=75.0)
    print(f"2. Voice missing (Text=85, Voice=None, Eng=75) -> {res2}")
    
    # 3. Near a tier boundary (Red threshold is 70)
    res3 = fuse_scores(text_score=72.0, voice_score=68.0, engagement_score=65.0)
    print(f"3. Near Red boundary (Text=72, Voice=68, Eng=65) -> {res3}")
    
    # 4. Low distress overall
    res4 = fuse_scores(text_score=10.0, voice_score=20.0, engagement_score=15.0)
    print(f"4. Low distress (Text=10, Voice=20, Eng=15) -> {res4}")
