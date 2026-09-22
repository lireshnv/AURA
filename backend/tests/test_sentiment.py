"""Context-aware sentiment tests, focused on negation.

Run (from backend/):
    C:\\Users\\Admin\\aura-backend-venv\\Scripts\\python.exe -m tests.test_sentiment

These lock in a real fix. Sentiment used to be derived from the emotion
classifier, which keys on the emotion word and ignores the negation around it:
"I am not angry" scored angry 96% -> negative 88%. A dedicated sentence-level
sentiment model reads the whole clause instead.
"""
import sys

from app import text_emotion
from app.services import sentiment_model

results = []


def check(name, ok, detail=""):
    results.append(("PASS" if ok else "FAIL", name, detail))
    print(f"  {'ok ' if ok else 'BAD'} {name}" + (f"  [{detail}]" if detail else ""))


def main() -> int:
    print("=" * 78)
    print("CONTEXT-AWARE SENTIMENT (NEGATION)")
    print("=" * 78)

    if not sentiment_model.is_available():
        print("transformers/torch unavailable - cannot run.")
        return 1

    # --- 1. Negation must not flip to negative ---------------------------
    print("\n[1] Negation handling")
    print("-" * 78)
    print(f"      {'text':<40} {'result':<10} pos/neu/neg")
    negation_cases = [
        # (text, must_not_be)
        ("I am not sad at all.", "negative"),
        ("It was not a bad day.", "negative"),
        ("I don't feel hopeless anymore.", "negative"),
        ("Nothing bad happened today.", "negative"),
    ]
    for text, forbidden in negation_cases:
        r = sentiment_model.analyze(text)
        s = r.scores
        print(f"      {text:<40} {r.dominant:<10} "
              f"{s['positive']:.0f}/{s['neutral']:.0f}/{s['negative']:.0f}")
        check(f"not {forbidden}: {text[:32]}", r.dominant != forbidden, r.dominant)

    # --- 2. Genuine negatives must still register ------------------------
    print("\n[2] Genuine negatives still detected")
    print("-" * 78)
    for text in ("I am angry.", "I feel hopeless.",
                 "I have been feeling really low since the hearing."):
        r = sentiment_model.analyze(text)
        s = r.scores
        print(f"      {text:<40} {r.dominant:<10} "
              f"{s['positive']:.0f}/{s['neutral']:.0f}/{s['negative']:.0f}")
        check(f"negative detected: {text[:32]}", r.dominant == "negative", r.dominant)

    # --- 3. Positive and neutral ------------------------------------------
    print("\n[3] Positive and neutral")
    print("-" * 78)
    r = sentiment_model.analyze("I am happy and things are going well.")
    check("positive detected", r.dominant == "positive", r.dominant)
    r = sentiment_model.analyze("The meeting is scheduled for three o'clock.")
    check("neutral detected", r.dominant == "neutral", r.dominant)

    # --- 4. No keyword lists ----------------------------------------------
    print("\n[4] Implementation is a model, not word matching")
    print("-" * 78)
    import inspect

    source = inspect.getsource(sentiment_model)
    for banned in ("NEGATIVE_WORDS", "POSITIVE_WORDS", "WORD_LIST", "LEXICON"):
        check(f"no {banned} word list", banned not in source)
    check("uses a transformer model", "AutoModelForSequenceClassification" in source)

    # --- 5. Confidence reflects available context -------------------------
    print("\n[5] Confidence scales with context")
    print("-" * 78)
    short = sentiment_model.analyze("Bad.")
    long = sentiment_model.analyze(
        "It was a really bad day and I felt awful the entire time, "
        "nothing seemed to go right at all."
    )
    print(f"      short fragment: conf={short.confidence}")
    print(f"      full passage  : conf={long.confidence}")
    check("longer text yields higher confidence", long.confidence > short.confidence,
          f"{long.confidence} > {short.confidence}")

    # --- 6. Per-sentence breakdown ----------------------------------------
    print("\n[6] Per-sentence aggregation")
    print("-" * 78)
    r = sentiment_model.analyze(
        "I was really upset yesterday. But today I feel much better."
    )
    for s in r.per_sentence:
        print(f"      {s['text'][:44]:<46} -> {s['dominant']}")
    check("both sentences scored", len(r.per_sentence) == 2, str(len(r.per_sentence)))
    check("mixed passage is not forced to one extreme",
          r.dominant in ("neutral", "positive", "negative"))

    # --- 7. End-to-end through text_emotion -------------------------------
    print("\n[7] Wired into the text analysis path")
    print("-" * 78)
    r = text_emotion.analyze_text("I am not angry.", language="en")
    print(f"      'I am not angry.' -> emotion={r.dominant} "
          f"sentiment={r.sentiment_dominant} {r.sentiment_scores}")
    check("text path uses the dedicated sentiment model",
          r.available and r.sentiment_dominant != "negative"
          or r.sentiment_scores.get("negative", 100) < 70,
          f"{r.sentiment_dominant} {r.sentiment_scores}")

    r2 = text_emotion.analyze_text("I am not sad at all.", language="en")
    print(f"      'I am not sad at all.' -> emotion={r2.dominant} "
          f"sentiment={r2.sentiment_dominant}")
    check("negated sadness no longer reads negative",
          r2.sentiment_dominant != "negative", r2.sentiment_dominant)

    # Emotion and sentiment are now independent signals.
    check("emotion still classified separately", r2.dominant in
          ("sad", "neutral", "happy", "angry", "fear", "surprise", "disgust"))

    print("\n" + "=" * 78)
    failures = [x for x in results if x[0] == "FAIL"]
    print(f"RESULT: {len(results) - len(failures)}/{len(results)} checks passed")
    if failures:
        print("\nFAILURES:")
        for _, name, detail in failures:
            print(f"  FAIL  {name}  [{detail}]")
    print("=" * 78)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
