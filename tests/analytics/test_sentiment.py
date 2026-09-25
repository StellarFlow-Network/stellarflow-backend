from datetime import datetime, timezone

from app.analytics.sentiment import (
    CommentSentiment,
    SentimentAggregate,
    SentimentLabel,
    SentimentPrediction,
    aggregate_sentiment,
)


def prediction(label: SentimentLabel) -> SentimentPrediction:
    return SentimentPrediction(
        label=label,
        score=0.9,
        positive_probability=1.0 if label == SentimentLabel.POSITIVE else 0.0,
        neutral_probability=1.0 if label == SentimentLabel.NEUTRAL else 0.0,
        negative_probability=1.0 if label == SentimentLabel.NEGATIVE else 0.0,
        model_name="test-model",
        model_version="test-version",
    )


def comment(label: SentimentLabel, index: int) -> CommentSentiment:
    return CommentSentiment(
        proposal_id="proposal-1",
        comment_id=f"comment-{index}",
        created_at=datetime(2026, 9, 25, tzinfo=timezone.utc),
        prediction=prediction(label),
    )


def test_aggregate_returns_positive_majority():
    result = aggregate_sentiment(
        [
            comment(SentimentLabel.POSITIVE, 1),
            comment(SentimentLabel.POSITIVE, 2),
            comment(SentimentLabel.NEGATIVE, 3),
        ]
    )
    assert result.label == SentimentLabel.POSITIVE
    assert result.positive_ratio == 2 / 3
    assert result.analyzed_comments == 3


def test_empty_aggregate_is_neutral():
    result = aggregate_sentiment([])
    assert result == SentimentAggregate(
        label=SentimentLabel.NEUTRAL,
        positive_ratio=0.0,
        neutral_ratio=0.0,
        negative_ratio=0.0,
        analyzed_comments=0,
    )
