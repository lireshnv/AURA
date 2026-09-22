from pydantic import BaseModel
from typing import Literal, Optional, List

class AnalyseRequest(BaseModel):
    session_id: str
    audio_url: Optional[str] = None
    language: str = "en-IN"

class TopFactor(BaseModel):
    feature: str
    human_label: str
    contribution: float
    direction: Literal["increases_distress", "decreases_distress"]

class AnalyseResponse(BaseModel):
    session_id: str
    voice_distress_subscore: Optional[int] = None
    confidence: Literal["high", "low"]
    tier_ab_agreement: float
    top_factors: List[TopFactor]
    flags: List[str]
    model_version: str
    message: Optional[str] = None
