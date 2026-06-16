import unittest

from app.semantic_tags import template_scores_for, top_semantic_tags


class SemanticTagsTest(unittest.TestCase):
    def test_top_semantic_tags_returns_ranked_clip_tags(self) -> None:
        tags = top_semantic_tags({
            "architecture": 0.42,
            "food": 0.04,
            "people": 0.18,
            "water": 0.02,
        }, limit=3)

        self.assertEqual([tag["label"] for tag in tags], ["architecture", "people", "food"])
        self.assertEqual(tags[0]["source"], "clip_zero_shot")

    def test_template_scores_group_scene_roles(self) -> None:
        scores = template_scores_for({
            "architecture": 0.55,
            "detail": 0.33,
            "food": 0.07,
            "people": 0.12,
            "sunset": 0.41,
        })

        self.assertGreater(scores["place"], 0.5)
        self.assertGreater(scores["detail"], 0.3)
        self.assertGreater(scores["atmosphere"], 0.4)
        self.assertGreater(scores["hero"], scores["people"])


if __name__ == "__main__":
    unittest.main()
