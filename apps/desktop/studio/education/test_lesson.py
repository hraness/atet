"""Pure contract regressions; no Manim import or native render is required."""

from copy import deepcopy
import json
from pathlib import Path
import unittest

from lesson import (LessonError, caption_at, cue_at, mouth_at, parse_lesson,
                    rhubarb_mouth_cues, tile_layout, triangle_facts)


EXAMPLE = Path(__file__).resolve().parents[4]/"examples/studio/education/lesson.json"


class LessonTests(unittest.TestCase):
    def setUp(self):
        self.lesson = json.loads(EXAMPLE.read_text())

    def test_example_has_correct_perpendicular_triangle_and_area_preserving_tiles(self):
        self.assertEqual(parse_lesson(self.lesson), self.lesson)
        for legs in ([3, 4], [4, 3], [5, 12], [6, 8], [9, 12]):
            with self.subTest(legs=legs):
                facts = triangle_facts(legs)
                origin, across, up = facts["vertices"]
                self.assertEqual(sum((across[i]-origin[i])*(up[i]-origin[i]) for i in range(2)), 0)
                self.assertEqual(sum((across[i]-up[i])**2 for i in range(2)), facts["c"]**2)
                tiles = tile_layout(legs)
                self.assertEqual(len(tiles), facts["areaA"]+facts["areaB"])
                self.assertEqual(len({tile["id"] for tile in tiles}), facts["areaC"])
                self.assertEqual({tile["target"] for tile in tiles}, {(x, y) for x in range(facts["c"]) for y in range(facts["c"])})
                for group, side in (("a", facts["a"]), ("b", facts["b"])):
                    self.assertEqual({tile["source"] for tile in tiles if tile["group"] == group}, {(x, y) for x in range(side) for y in range(side)})

    def test_noninteger_or_non_pythagorean_topics_fail_without_guessing_length(self):
        for legs in ([1, 1], [3, 5], [True, 4], [3.0, 4], [13, 12], [3], "3,4"):
            with self.subTest(legs=legs), self.assertRaises(LessonError):
                triangle_facts(legs)

    def test_exact_half_open_caption_and_mouth_boundaries_and_gaps(self):
        self.assertEqual(caption_at(self.lesson, 149999), (None, None))
        self.assertEqual(caption_at(self.lesson, 150000), (0, 0))
        self.assertEqual(caption_at(self.lesson, 290000), (0, 1))
        self.assertEqual(caption_at(self.lesson, 1150000), (None, None))
        self.assertEqual(caption_at(self.lesson, 2000000), (1, None))
        self.assertEqual(mouth_at(self.lesson, 149999), "X")
        self.assertEqual(mouth_at(self.lesson, 150000), "C")
        self.assertEqual(mouth_at(self.lesson, 290000), "E")
        self.assertEqual(mouth_at(self.lesson, 1150000), "X")
        self.assertIsNone(cue_at(self.lesson["gestures"], 9740000))

    def test_validation_captures_data_without_retaining_caller_mutability(self):
        captured = parse_lesson(self.lesson)
        self.lesson["topic"]["legs"][0] = 1
        self.lesson["captions"][0]["words"][0]["text"] = "Changed"
        self.assertEqual(captured["topic"]["legs"], [3, 4])
        self.assertEqual(captured["captions"][0]["words"][0]["text"], "A")

    def test_timing_provenance_and_foreign_schema_are_not_silently_repaired(self):
        mutations = (
            lambda data: data.update(schemaVersion=True),
            lambda data: data.update(mouthTiming="none"),
            lambda data: data.update(captionTiming="guessed"),
            lambda data: data.update(extra="ignored"),
            lambda data: data.update(showCaptions=1),
            lambda data: data["captions"][0]["words"][1].update(startUs=200000),
            lambda data: data["mouthCues"][0].update(value="Z"),
            lambda data: data["mouthCues"][0].update(endUs=150000),
            lambda data: data["mouthCues"][-1].update(endUs=10000001),
            lambda data: data["gestures"][0].update(startUs=True),
            lambda data: data["beats"].update(resultUs=9900000),
            lambda data: data["captions"].append(deepcopy(data["captions"][0])),
        )
        for index, mutation in enumerate(mutations):
            with self.subTest(index=index), self.assertRaises(LessonError):
                data = deepcopy(self.lesson)
                mutation(data)
                parse_lesson(data)

    def test_existing_audio_references_are_inert_portable_data(self):
        self.lesson["narration"] = {"assetId": "voice_luma", "transcript": "A right triangle."}
        self.lesson["sfx"] = [{"assetId": "tile_click", "atUs": 7600000, "gainDb": -18}]
        retained = parse_lesson(self.lesson)
        self.assertEqual(retained["narration"]["assetId"], "voice_luma")
        self.assertEqual(retained["sfx"][0]["gainDb"], -18)

    def test_rhubarb_import_has_explicit_offset_rounding_and_no_absolute_metadata(self):
        raw = {"metadata": {"soundFile": "/private/voice.wav", "duration": 1},
               "mouthCues": [{"start": 0, "end": .1234565, "value": "A"}, {"start": .2, "end": .4, "value": "X"}]}
        self.assertEqual(rhubarb_mouth_cues(raw, 1000000, 100000), [
            {"startUs": 100000, "endUs": 223457, "value": "A"},
            {"startUs": 300000, "endUs": 500000, "value": "X"}])
        self.assertNotIn("private", json.dumps(rhubarb_mouth_cues(raw, 1000000)))

    def test_rhubarb_rejects_nonfinite_boolean_overlapping_and_out_of_range_cues(self):
        for start, end in ((float("nan"), .2), (0, float("inf")), (False, .2), (-.1, .2), (.2, .1), (0, 2)):
            with self.subTest(start=start, end=end), self.assertRaises(LessonError):
                rhubarb_mouth_cues({"metadata": {}, "mouthCues": [{"start": start, "end": end, "value": "A"}]}, 1000000)
        with self.assertRaises(LessonError):
            rhubarb_mouth_cues({"metadata": {}, "mouthCues": [{"start": 0, "end": .4, "value": "A"}, {"start": .3, "end": .5, "value": "B"}]}, 1000000)


if __name__ == "__main__":
    unittest.main()
