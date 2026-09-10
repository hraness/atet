"""Pure retained lesson data and timing. Importing this module renders nothing."""

from copy import deepcopy
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from math import isqrt


class LessonError(ValueError):
    pass


def _object(value, required, optional=()):
    if type(value) is not dict or not set(required) <= value.keys() or value.keys() - set(required) - set(optional):
        raise LessonError("Lesson object has missing or unsupported fields.")
    return value


def _integer(value, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise LessonError("Lesson timing or count is outside its integer bound.")
    return value


def _text(value, maximum=80):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or any(ord(c) < 32 for c in value):
        raise LessonError("Lesson text must be bounded, nonempty and contain no control characters.")
    return value


def _array(value, maximum):
    if type(value) is not list or len(value) > maximum:
        raise LessonError("Lesson cue list exceeds its bound.")
    return value


def _interval(value, duration):
    start = _integer(value["startUs"], 0, duration - 1)
    end = _integer(value["endUs"], 1, duration)
    if start >= end:
        raise LessonError("Cue intervals must have positive duration.")
    return start, end


def _ordered(cues, duration, fields):
    previous = 0
    for cue in cues:
        _object(cue, ("startUs", "endUs", *fields))
        start, previous_end = _interval(cue, duration)
        if start < previous:
            raise LessonError("Cue intervals must be ordered and nonoverlapping.")
        previous = previous_end


def triangle_facts(legs):
    if type(legs) is not list or len(legs) != 2:
        raise LessonError("Pythagorean tiles require two integer legs.")
    a, b = (_integer(side, 1, 12) for side in legs)
    squared = a * a + b * b
    c = isqrt(squared)
    if c * c != squared or c > 15:
        raise LessonError("This tile template requires an integer hypotenuse no larger than fifteen.")
    return {"a": a, "b": b, "c": c, "areaA": a * a, "areaB": b * b,
            "areaC": squared, "vertices": ((0, 0), (b, 0), (0, a))}


def parse_lesson(value):
    """Validate authored JSON. No formulas, paths, providers or source are evaluated."""
    value = _object(value, ("kind", "schemaVersion", "title", "subtitle", "durationUs", "topic",
                            "beats", "presenter", "captions", "captionTiming", "mouthCues", "mouthTiming", "gestures"),
                    ("narration", "sfx", "showCaptions"))
    if value["kind"] != "slopcamera.education-lesson" or type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1:
        raise LessonError("Unsupported educational lesson version.")
    _text(value["title"], 48)
    _text(value["subtitle"], 72)
    duration = _integer(value["durationUs"], 1_000_000, 60_000_000)
    topic = _object(value["topic"], ("kind", "legs"))
    if topic["kind"] != "pythagorean-tiles":
        raise LessonError("Unsupported lesson template; use trusted Python for other explanations.")
    triangle_facts(topic["legs"])
    beats = _object(value["beats"], ("squaresUs", "rearrangeUs", "resultUs"))
    times = [_integer(beats[key], 1, duration - 1) for key in ("squaresUs", "rearrangeUs", "resultUs")]
    if not 500_000 <= times[0] < times[1] < times[2] <= duration - 500_000:
        raise LessonError("Lesson beats must increase with room for the opening and result.")
    presenter = _object(value["presenter"], ("name",))
    _text(presenter["name"], 16)
    if value["captionTiming"] not in ("authored", "aligned") or value["mouthTiming"] not in ("authored", "rhubarb", "none"):
        raise LessonError("Timing provenance must be explicit.")
    if "showCaptions" in value and type(value["showCaptions"]) is not bool:
        raise LessonError("showCaptions must be boolean.")
    previous = 0
    for caption in _array(value["captions"], 80):
        _object(caption, ("words",))
        words = _array(caption["words"], 12)
        if not words or sum(len(_text(word.get("text"), 32)) + 1 for word in words if type(word) is dict) > 96:
            raise LessonError("Caption phrases must have one to twelve short words.")
        _ordered(words, duration, ("text",))
        for word in words:
            _text(word["text"], 32)
        if words[0]["startUs"] < previous:
            raise LessonError("Caption phrases must be ordered and nonoverlapping.")
        previous = words[-1]["endUs"]
    mouths = _array(value["mouthCues"], 2400)
    _ordered(mouths, duration, ("value",))
    for cue in mouths:
        if cue["value"] not in tuple("ABCDEFGHX"):
            raise LessonError("Mouth cues must use Rhubarb A–H or X shapes.")
    if value["mouthTiming"] == "none" and mouths:
        raise LessonError("A resting mouth cannot contain hidden timing cues.")
    gestures = _array(value["gestures"], 160)
    _ordered(gestures, duration, ("kind",))
    if any(cue["kind"] not in ("point", "open", "nod", "rest") for cue in gestures):
        raise LessonError("Unsupported presenter gesture.")
    if "narration" in value:
        narration = _object(value["narration"], ("assetId", "transcript"))
        _text(narration["assetId"], 64)
        _text(narration["transcript"], 4000)
    for sound in _array(value.get("sfx", []), 80):
        _object(sound, ("assetId", "atUs", "gainDb"))
        _text(sound["assetId"], 64)
        _integer(sound["atUs"], 0, duration - 1)
        _integer(sound["gainDb"], -60, 0)
    return deepcopy(value)


def cue_at(cues, time_us):
    """Half-open intervals make boundaries independent of sample order."""
    return next((cue for cue in cues if cue["startUs"] <= time_us < cue["endUs"]), None)


def caption_at(lesson, time_us):
    for index, caption in enumerate(lesson["captions"]):
        words = caption["words"]
        if words[0]["startUs"] <= time_us < words[-1]["endUs"]:
            active = next((i for i, word in enumerate(words) if word["startUs"] <= time_us < word["endUs"]), None)
            return index, active
    return None, None


def mouth_at(lesson, time_us):
    cue = cue_at(lesson["mouthCues"], time_us)
    return "X" if cue is None else cue["value"]


def rhubarb_mouth_cues(value, duration_us, offset_us=0):
    """Import measured mouth timing; absolute metadata paths are never retained."""
    _integer(duration_us, 1, 60_000_000)
    _integer(offset_us, 0, duration_us - 1)
    _object(value, ("metadata", "mouthCues"))
    cues = []
    for raw in _array(value["mouthCues"], 2400):
        _object(raw, ("start", "end", "value"))
        converted = {"value": raw["value"]}
        for source, target in (("start", "startUs"), ("end", "endUs")):
            if type(raw[source]) not in (int, float):
                raise LessonError("Rhubarb timestamps must be finite numbers.")
            try:
                number = Decimal(str(raw[source]))
                if not number.is_finite():
                    raise LessonError("Rhubarb timestamps must be finite numbers.")
                converted[target] = offset_us + int((number * 1_000_000).to_integral_value(rounding=ROUND_HALF_UP))
            except InvalidOperation as error:
                raise LessonError("Invalid Rhubarb timestamp.") from error
        cues.append(converted)
    _ordered(cues, duration_us, ("value",))
    if any(cue["value"] not in tuple("ABCDEFGHX") for cue in cues):
        raise LessonError("Unsupported Rhubarb mouth shape.")
    return cues


def tile_layout(legs):
    """Stable tile identity and equal-sized source/target unit cells."""
    facts = triangle_facts(legs)
    cells = []
    for group, side in (("a", facts["a"]), ("b", facts["b"])):
        for row in range(side):
            for column in range(side):
                index = len(cells)
                cells.append({"id": f"{group}_{row}_{column}", "group": group,
                              "source": (column, row), "target": (index % facts["c"], index // facts["c"])})
    return cells
