"""Three-class sentiment inference and proposal aggregation."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from statistics import mean
from typing import Iterable


class SentimentLabel(StrEnum):
    POSITIVE = "POSITIVE"
    NEUTRAL = "NEUTRAL"
    NEGATIVE = "NEGATIVE"


@dataclass(frozen=True)
class SentimentPrediction:
    label: SentimentLabel
    score: float
    positive_probability: float
    neutral_probability: float
    negative_probability: float
    model_name: str
    model_version: str


@dataclass(frozen=True)
class CommentSentiment:
    proposal_id: str
    comment_id: str
    created_at: datetime
    prediction: SentimentPrediction


@dataclass(frozen=True)
class SentimentAggregate:
    label: SentimentLabel
    positive_ratio: float
    neutral_ratio: float
    negative_ratio: float
    analyzed_comments: int


class SentimentAnalyzer:
    """Adapter boundary for a real NLP model.

    Replace `predict` with a Transformers pipeline or an internal inference service.
    Keep the adapter interface stable so the aggregation layer remains model-agnostic.
    """

    def __init__(
        self,
        model_name: str = "UNCONFIGURED",
        model_version: str = "UNCONFIGURED",
    ) -> None:
        self.model_name = model_name
        self.model_version = model_version

    def predict(self, text: str) -> SentimentPrediction:
        raise NotImplementedError(
            "Connect a validated three-class NLP model before production use"
        )


def aggregate_sentiment(
    comments: Iterable[CommentSentiment],
) -> SentimentAggregate:
    items = list(comments)
    if not items:
        return SentimentAggregate(
            label=SentimentLabel.NEUTRAL,
            positive_ratio=0.0,
            neutral_ratio=0.0,
            negative_ratio=0.0,
            analyzed_comments=0,
        )

    counts = {
        SentimentLabel.POSITIVE: 0,
        SentimentLabel.NEUTRAL: 0,
        SentimentLabel.NEGATIVE: 0,
    }
    for item in items:
        counts[item.prediction.label] += 1

    total = len(items)
    ratios = {label: count / total for label, count in counts.items()}
    label = max(
        counts,
        key=lambda candidate: (
            counts[candidate],
            ratios[candidate],
            candidate == SentimentLabel.NEUTRAL,
        ),
    )
    return SentimentAggregate(
        label=label,
        positive_ratio=ratios[SentimentLabel.POSITIVE],
        neutral_ratio=ratios[SentimentLabel.NEUTRAL],
        negative_ratio=ratios[SentimentLabel.NEGATIVE],
        analyzed_comments=total,
    )
