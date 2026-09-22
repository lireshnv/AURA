"""Facial-geometry extraction via MediaPipe Face Mesh, organized by face region.

This module produces *evidence* for the fusion engine - it never decides an
emotion by itself, and it never replaces DeepFace.

Two rules govern everything here:

1. No raw pixel values. Every measurement is normalized by inter-ocular
   distance (or is already a dimensionless ratio), so it means the same thing
   whether the user is close to or far from the camera.

2. No absolute thresholds on those measurements. They are only ever compared
   against the *same user's* neutral baseline (see smoothing.baseline_or_collect),
   because resting mouth shape, eye openness and brow height vary enormously
   between people. A naturally downturned mouth must not read as sadness.

Landmark indices below are for the canonical MediaPipe Face Mesh 468-point
topology. They were verified empirically against real faces rather than taken
on faith - notably, the face-oval points (234/454) turned out to be unusable
for head-pose estimation (on a real turned face, point 454 landed *inside* the
outer eye corner), which is why yaw is derived from a symmetric nose-to-eye
distance ratio instead. See head_pose().
"""
import math
from dataclasses import dataclass, asdict
from typing import Dict, List, Optional, Tuple

import cv2
import mediapipe as mp
import numpy as np

from . import config

_mp_face_mesh = mp.solutions.face_mesh
# static_image_mode=True: each request is an independent frame arriving at a
# shared server-side detector, so MediaPipe must NOT carry tracking state
# between calls - that would leak one session's geometry into another's.
_face_mesh = _mp_face_mesh.FaceMesh(
    static_image_mode=True,
    max_num_faces=1,
    refine_landmarks=True,
    min_detection_confidence=0.5,
)

# --- Landmark indices (canonical 468-point Face Mesh topology) --------------

# Mouth. 61/291 are the outer corners. 13/14 are the INNER lip edges, which
# coincide exactly when the lips are closed - that is correct behaviour and is
# what makes mouth_open_ratio ~0 for a closed mouth. 0/17 are the outer upper
# and lower lip midpoints, used for lip thickness/tension.
_MOUTH_LEFT_CORNER = 61
_MOUTH_RIGHT_CORNER = 291
_MOUTH_INNER_TOP = 13
_MOUTH_INNER_BOTTOM = 14
_MOUTH_OUTER_TOP = 0
_MOUTH_OUTER_BOTTOM = 17

# Eyes: (outer corner, inner corner, upper lid, lower lid)
_LEFT_EYE = (33, 133, 159, 145)
_RIGHT_EYE = (362, 263, 386, 374)

# Eyebrows: (inner, middle, outer) per brow.
_LEFT_BROW = (107, 105, 46)
_RIGHT_BROW = (336, 334, 276)

# Midface / vertical reference points.
_NOSE_TIP = 1
_NOSE_BRIDGE = 168
_CHIN = 152

# Iris landmarks exist only when refine_landmarks=True (indices 468-477).
# Guarded at use, because a mesh without refinement simply won't have them and
# gaze must then be reported as unavailable rather than defaulted to centre.
_LEFT_IRIS_CENTER = 468
_RIGHT_IRIS_CENTER = 473
_IRIS_MIN_LANDMARKS = 478


@dataclass
class FaceGeometry:
    """Normalized facial geometry. All fields are scale-invariant."""

    # Mouth / lips
    mouth_width: float
    mouth_height: float
    mouth_open_ratio: float
    corner_lift: float
    corner_asymmetry: float
    upper_lip_thickness: float
    lower_lip_thickness: float

    # Eyes
    left_eye_openness: float
    right_eye_openness: float
    eye_openness: float
    eye_asymmetry: float

    # Eyebrows
    left_brow_eye_dist: float
    right_brow_eye_dist: float
    brow_eye_dist: float
    inner_brow_height: float

    # Midface
    nose_mouth_dist: float

    # Head pose (not baseline-compared; used for trust weighting)
    yaw_ratio: float
    pitch_ratio: float
    roll_degrees: float

    # --- Iris / gaze. Defaulted, so they must stay last in the dataclass. ---
    # Horizontal offset of each iris within its own eye opening, as a signed
    # fraction (negative = toward the outer corner). Present only with refined
    # landmarks; when absent, iris_available is False and the value is NOT
    # silently treated as a centred gaze.
    left_gaze_offset: float = 0.0
    right_gaze_offset: float = 0.0
    gaze_offset: float = 0.0
    iris_available: bool = False

    def baseline_fields(self) -> Dict[str, float]:
        """The subset compared against the personal neutral baseline.

        Head pose is deliberately excluded - it describes where the head is
        pointing, not what the face is expressing, and folding it into a
        baseline would let a user who calibrated while slightly turned have
        that turn read as an expression later.
        """
        d = asdict(self)
        for pose_field in ("yaw_ratio", "pitch_ratio", "roll_degrees"):
            d.pop(pose_field, None)
        return d


BASELINE_FIELDS: Tuple[str, ...] = (
    "mouth_width",
    "mouth_height",
    "mouth_open_ratio",
    "corner_lift",
    "corner_asymmetry",
    "upper_lip_thickness",
    "lower_lip_thickness",
    "left_eye_openness",
    "right_eye_openness",
    "eye_openness",
    "eye_asymmetry",
    "left_brow_eye_dist",
    "right_brow_eye_dist",
    "brow_eye_dist",
    "inner_brow_height",
    "nose_mouth_dist",
)


def _dist(a, b) -> float:
    return float(math.hypot(a[0] - b[0], a[1] - b[1]))


def _midpoint(a, b):
    return ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)


def _landmark_points(image_bgr: np.ndarray) -> Optional[List[Tuple[float, float]]]:
    rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    result = _face_mesh.process(rgb)
    if not result.multi_face_landmarks:
        return None
    h, w = image_bgr.shape[:2]
    return [(p.x * w, p.y * h) for p in result.multi_face_landmarks[0].landmark]


def _eye_centers(pts) -> Tuple[Tuple[float, float], Tuple[float, float]]:
    left = _midpoint(pts[_LEFT_EYE[0]], pts[_LEFT_EYE[1]])
    right = _midpoint(pts[_RIGHT_EYE[0]], pts[_RIGHT_EYE[1]])
    return left, right


def _roll_degrees(pts) -> float:
    """In-plane head tilt from the eye line. This one is exact, not a proxy."""
    left, right = _eye_centers(pts)
    return math.degrees(math.atan2(right[1] - left[1], right[0] - left[0]))


def align_face(image_bgr: np.ndarray) -> Tuple[np.ndarray, float]:
    """Rotates the crop so the eye line is horizontal.

    Consistent orientation makes mouth/eye/brow geometry comparable between
    frames (and gives DeepFace a canonical view). Returns (aligned, roll).
    Skips the rotation entirely for negligible tilt so the common case costs
    nothing, and returns the original if landmarks can't be found.
    """
    pts = _landmark_points(image_bgr)
    if pts is None:
        return image_bgr, 0.0

    roll = _roll_degrees(pts)
    if abs(roll) < config.ALIGN_MIN_ROLL_DEGREES:
        return image_bgr, roll

    h, w = image_bgr.shape[:2]
    left, right = _eye_centers(pts)
    center = _midpoint(left, right)
    matrix = cv2.getRotationMatrix2D(center, roll, 1.0)
    aligned = cv2.warpAffine(
        image_bgr, matrix, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE
    )
    return aligned, roll


def head_pose(pts, interocular: float) -> Tuple[float, float, float]:
    """Approximate (yaw_ratio, pitch_ratio, roll_degrees) from 2D landmarks.

    yaw uses the *difference of distances* from the nose tip to each outer eye
    corner, normalized by their sum. This is symmetric by construction: it is
    0.0 for a perfectly frontal face and grows toward +/-1 as the head turns,
    with no dependence on face-oval landmarks (which measured unreliably) and
    no dependence on absolute scale.

    pitch uses where the nose tip sits vertically between the eye line and the
    chin. It is a rough proxy, so it is only ever used relative to the user's
    own baseline.
    """
    left_eye_outer = pts[_LEFT_EYE[0]]
    right_eye_outer = pts[_RIGHT_EYE[1]]
    nose = pts[_NOSE_TIP]

    d_left = _dist(nose, left_eye_outer)
    d_right = _dist(nose, right_eye_outer)
    total = d_left + d_right
    yaw_ratio = (d_left - d_right) / total if total > 1e-6 else 0.0

    left_center, right_center = _eye_centers(pts)
    eye_line_y = (left_center[1] + right_center[1]) / 2
    chin_y = pts[_CHIN][1]
    span = chin_y - eye_line_y
    pitch_ratio = (nose[1] - eye_line_y) / span if abs(span) > 1e-6 else 0.0

    return yaw_ratio, pitch_ratio, _roll_degrees(pts)


def extract_geometry(face_crop_bgr: np.ndarray) -> Optional[FaceGeometry]:
    """Full per-region geometry for one already-cropped face.

    Returns None when Face Mesh finds no landmarks; the caller then simply has
    no landmark evidence for that frame and DeepFace's own read stands alone,
    rather than a default being invented.
    """
    pts = _landmark_points(face_crop_bgr)
    if pts is None:
        return None

    left_center, right_center = _eye_centers(pts)
    interocular = _dist(left_center, right_center)
    if interocular < 1e-3:
        return None

    # --- Mouth / lips ------------------------------------------------------
    mouth_l = pts[_MOUTH_LEFT_CORNER]
    mouth_r = pts[_MOUTH_RIGHT_CORNER]
    inner_top = pts[_MOUTH_INNER_TOP]
    inner_bottom = pts[_MOUTH_INNER_BOTTOM]
    outer_top = pts[_MOUTH_OUTER_TOP]
    outer_bottom = pts[_MOUTH_OUTER_BOTTOM]

    mouth_width_px = _dist(mouth_l, mouth_r)
    mouth_width = mouth_width_px / interocular
    mouth_height_px = _dist(inner_top, inner_bottom)
    mouth_height = mouth_height_px / interocular
    mouth_open_ratio = mouth_height_px / mouth_width_px if mouth_width_px > 1e-6 else 0.0

    # Corner lift: how high the corners sit relative to the mouth's own
    # vertical midline. Positive => corners drawn upward (smile); negative =>
    # corners drooping below the mouth centre (frown).
    mouth_center_y = (inner_top[1] + inner_bottom[1]) / 2
    corner_avg_y = (mouth_l[1] + mouth_r[1]) / 2
    corner_lift = (mouth_center_y - corner_avg_y) / interocular
    corner_asymmetry = abs(mouth_l[1] - mouth_r[1]) / interocular

    upper_lip_thickness = _dist(outer_top, inner_top) / interocular
    lower_lip_thickness = _dist(outer_bottom, inner_bottom) / interocular

    # --- Eyes: eye-aspect-ratio per side ----------------------------------
    def _eye_aspect(idx: Tuple[int, int, int, int]) -> float:
        outer, inner, upper, lower = idx
        horiz = _dist(pts[outer], pts[inner])
        vert = _dist(pts[upper], pts[lower])
        return vert / horiz if horiz > 1e-6 else 0.0

    left_eye_openness = _eye_aspect(_LEFT_EYE)
    right_eye_openness = _eye_aspect(_RIGHT_EYE)
    eye_openness = (left_eye_openness + right_eye_openness) / 2
    eye_asymmetry = abs(left_eye_openness - right_eye_openness)

    # --- Iris / gaze (refined landmarks only) -----------------------------
    left_gaze = right_gaze = 0.0
    iris_available = False
    if len(pts) >= _IRIS_MIN_LANDMARKS:
        # Measured in a consistent IMAGE-horizontal frame for both eyes, not
        # per-eye "toward the inner corner". When someone looks sideways both
        # irises move the same spatial direction - which is toward-inner for
        # one eye and toward-outer for the other - so a per-eye convention
        # makes the two values cancel and the average becomes meaningless.
        # The crop is eye-line aligned, so image x is effectively the head's
        # horizontal axis. Positive = gaze toward increasing image x.
        def _gaze(iris_idx: int, corner_a: int, corner_b: int) -> float:
            a, b = pts[corner_a], pts[corner_b]
            width = _dist(a, b)
            if width < 1e-6:
                return 0.0
            centre = _midpoint(a, b)
            return (pts[iris_idx][0] - centre[0]) / width * 2.0

        left_gaze = _gaze(_LEFT_IRIS_CENTER, _LEFT_EYE[0], _LEFT_EYE[1])
        right_gaze = _gaze(_RIGHT_IRIS_CENTER, _RIGHT_EYE[0], _RIGHT_EYE[1])
        iris_available = True

    # --- Eyebrows ---------------------------------------------------------
    left_brow_eye_dist = _dist(pts[_LEFT_BROW[1]], pts[_LEFT_EYE[2]]) / interocular
    right_brow_eye_dist = _dist(pts[_RIGHT_BROW[1]], pts[_RIGHT_EYE[2]]) / interocular
    brow_eye_dist = (left_brow_eye_dist + right_brow_eye_dist) / 2

    # Inner-brow height specifically: the inner corners rising is a distinct
    # signal (associated with sadness) from the whole brow rising (surprise).
    inner_brow_mid = _midpoint(pts[_LEFT_BROW[0]], pts[_RIGHT_BROW[0]])
    eye_line_y = (left_center[1] + right_center[1]) / 2
    inner_brow_height = (eye_line_y - inner_brow_mid[1]) / interocular

    # --- Midface ----------------------------------------------------------
    nose_mouth_dist = _dist(pts[_NOSE_TIP], _midpoint(mouth_l, mouth_r)) / interocular

    yaw_ratio, pitch_ratio, roll_deg = head_pose(pts, interocular)

    return FaceGeometry(
        mouth_width=mouth_width,
        mouth_height=mouth_height,
        mouth_open_ratio=mouth_open_ratio,
        corner_lift=corner_lift,
        corner_asymmetry=corner_asymmetry,
        upper_lip_thickness=upper_lip_thickness,
        lower_lip_thickness=lower_lip_thickness,
        left_eye_openness=left_eye_openness,
        right_eye_openness=right_eye_openness,
        eye_openness=eye_openness,
        eye_asymmetry=eye_asymmetry,
        left_brow_eye_dist=left_brow_eye_dist,
        right_brow_eye_dist=right_brow_eye_dist,
        brow_eye_dist=brow_eye_dist,
        inner_brow_height=inner_brow_height,
        nose_mouth_dist=nose_mouth_dist,
        yaw_ratio=yaw_ratio,
        pitch_ratio=pitch_ratio,
        roll_degrees=roll_deg,
        left_gaze_offset=round(left_gaze, 4),
        right_gaze_offset=round(right_gaze, 4),
        gaze_offset=round((left_gaze + right_gaze) / 2, 4),
        iris_available=iris_available,
    )
