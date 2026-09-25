from datetime import datetime, timezone

from app.analytics.sentiment import CommentSentiment, SentimentLabel, SentimentPrediction
from app.analytics.sentiment_trends import daily_trends


def make_comment(day: int, label: SentimentLabel, index: int) -> CommentSentiment:
    return CommentSentiment(
        proposal_id="p1",
        comment_id=str(index),
        created_at=datetime(2026, 9, day, 10, tzinfo=timezone.utc),
        prediction=SentimentPrediction(
            label=label,
            score=0.8,
            positive_probability=0.8 if label == SentimentLabel.POSITIVE else 0.1,
            neutral_probability=0.8 if label == SentimentLabel.NEUTRAL else 0.1,
            negative_probability=0.8 if label == SentimentLabel.NEGATIVE else 0.1,
            model_name="test",
            model_version="1",
        ),
    )


def test_daily_trends_groups_comments_by_utc_day():
    points = daily_trends(
        [
            make_comment(25, SentimentLabel.POSITIVE, 1),
            make_comment(25, SentimentLabel.NEGATIVE, 2),
            make_comment(26, SentimentLabel.NEUTRAL, 3),
        ]
    )
    assert len(points) == 2
    assert points[0].analyzed_comments == 2
    assert points[1].neutral_ratio == 1.0
