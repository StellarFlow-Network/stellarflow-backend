"""Time-bucketed sentiment trend aggregation."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone

from app.analytics.sentiment import CommentSentiment, SentimentLabel


@dataclass(frozen=True)
class SentimentTrendPoint:
    bucket_start: datetime
    positive_ratio: float
    neutral_ratio: float
    negative_ratio: float
    analyzed_comments: int


def daily_trends(
    comments: list[CommentSentiment],
) -> list[SentimentTrendPoint]:
    buckets: dict[datetime, list[CommentSentiment]] = defaultdict(list)
    for comment in comments:
        timestamp = comment.created_at
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=timezone.utc)
        bucket = timestamp.astimezone(timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        buckets[bucket].append(comment)

    points: list[SentimentTrendPoint] = []
    for bucket in sorted(buckets):
        values = buckets[bucket]
        total = len(values)
        counts = {
            label: sum(
                1 for value in values if value.prediction.label == label
            )
            for label in SentimentLabel
        }
        points.append(
            SentimentTrendPoint(
                bucket_start=bucket,
                positive_ratio=counts[SentimentLabel.POSITIVE] / total,
                neutral_ratio=counts[SentimentLabel.NEUTRAL] / total,
                negative_ratio=counts[SentimentLabel.NEGATIVE] / total,
                analyzed_comments=total,
            )
        )
    return points
