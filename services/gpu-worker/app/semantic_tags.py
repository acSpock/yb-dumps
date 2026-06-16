from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SemanticPrompt:
    label: str
    prompt: str


SEMANTIC_PROMPTS: tuple[SemanticPrompt, ...] = (
    SemanticPrompt("people", "a travel photo of people"),
    SemanticPrompt("group", "a group photo with friends"),
    SemanticPrompt("selfie", "a close selfie photo"),
    SemanticPrompt("outfit", "a photo showing an outfit"),
    SemanticPrompt("beach", "a beach or coastal travel photo"),
    SemanticPrompt("city", "a city street travel photo"),
    SemanticPrompt("architecture", "a photo of architecture or buildings"),
    SemanticPrompt("landmark", "a photo of a famous landmark"),
    SemanticPrompt("food", "a photo of food"),
    SemanticPrompt("drink", "a photo of drinks"),
    SemanticPrompt("restaurant", "a restaurant or cafe photo"),
    SemanticPrompt("detail", "a close detail photo"),
    SemanticPrompt("texture", "a texture or pattern detail photo"),
    SemanticPrompt("sunset", "a sunset or golden hour photo"),
    SemanticPrompt("night", "a night travel photo"),
    SemanticPrompt("landscape", "a landscape or scenic view photo"),
    SemanticPrompt("transit", "a transit or travel movement photo"),
    SemanticPrompt("hotel", "a hotel or accommodation photo"),
    SemanticPrompt("street", "a street scene photo"),
    SemanticPrompt("water", "a photo with water"),
    SemanticPrompt("interior", "an interior space photo"),
)

PEOPLE_LABELS = {"people", "group", "selfie", "outfit"}
PLACE_LABELS = {
    "architecture",
    "beach",
    "city",
    "hotel",
    "interior",
    "landmark",
    "landscape",
    "street",
    "transit",
    "water",
}
DETAIL_LABELS = {"detail", "drink", "food", "restaurant", "texture"}
FOOD_LABELS = {"drink", "food", "restaurant"}
ATMOSPHERE_LABELS = {"interior", "landscape", "night", "sunset", "texture", "water"}
HERO_LABELS = {"architecture", "beach", "group", "landmark", "landscape", "people", "street", "sunset", "water"}


def clamp(value: float, minimum: float = 0.0, maximum: float = 1.0) -> float:
    return max(minimum, min(maximum, value))


def score_for(label_scores: dict[str, float], labels: set[str]) -> float:
    values = [label_scores.get(label, 0.0) for label in labels]
    return clamp(max(values) if values else 0.0)


def top_semantic_tags(
    label_scores: dict[str, float],
    *,
    limit: int = 6,
    minimum_score: float = 0.015,
) -> list[dict[str, object]]:
    ranked = sorted(label_scores.items(), key=lambda item: item[1], reverse=True)
    return [
        {
            "label": label,
            "score": round(clamp(score), 4),
            "source": "clip_zero_shot",
        }
        for label, score in ranked[:limit]
        if score >= minimum_score
    ]


def template_scores_for(label_scores: dict[str, float]) -> dict[str, float]:
    people = score_for(label_scores, PEOPLE_LABELS)
    place = score_for(label_scores, PLACE_LABELS)
    detail = score_for(label_scores, DETAIL_LABELS)
    food = score_for(label_scores, FOOD_LABELS)
    atmosphere = score_for(label_scores, ATMOSPHERE_LABELS)
    hero = clamp(
        score_for(label_scores, HERO_LABELS) * 0.72 +
        max(place, people, atmosphere) * 0.28
    )

    return {
        "hero": round(hero, 4),
        "people": round(people, 4),
        "place": round(place, 4),
        "detail": round(detail, 4),
        "food": round(food, 4),
        "atmosphere": round(atmosphere, 4),
    }
