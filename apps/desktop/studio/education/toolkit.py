"""Original educational Manim components. Include this file in the source bundle."""

import json
import math
from pathlib import Path

import numpy as np
from manim import (ArcBetweenPoints, Circle, Dot, Ellipse, Line, Polygon,
                   RoundedRectangle, Scene, Text, VGroup, ValueTracker,
                   config, linear)

from lesson import caption_at, cue_at, mouth_at, parse_lesson, tile_layout, triangle_facts


PALETTE = {"background": "#101B2B", "panel": "#18283C", "edge": "#30445C",
           "ink": "#F3F5EC", "muted": "#A5B5C8", "mint": "#A2EDCB",
           "blue": "#80C6FA", "copper": "#F3AF79", "dark": "#152C40"}


def smooth_between(time, start, end):
    value = min(1.0, max(0.0, (time - start) / max(end - start, 1e-9)))
    return value * value * (3 - 2 * value)


def label(text, size=32, color=None):
    return Text(text, font="Sans", font_size=size, color=color or PALETTE["ink"], disable_ligatures=True)


def fit_width(mobject, maximum):
    if mobject.width > maximum:
        mobject.scale(maximum / mobject.width)
    return mobject


def math_label(expression, size=36, color=None, backend="typst"):
    """Typeset trusted author mathematics; missing dependencies fail explicitly."""
    if backend == "typst":
        from manim import MathTypst
        return MathTypst(expression, font_size=size, color=color or PALETTE["ink"])
    if backend == "latex":
        from manim import MathTex
        return MathTex(expression, font_size=size, color=color or PALETTE["ink"])
    raise ValueError("Mathematical typesetting requires the typst or latex backend.")


class Presenter(VGroup):
    """Luma: an original copper lantern robot, with replaceable mouth shapes."""

    def __init__(self, name="Luma", center=(-2.1, -2.7, 0)):
        super().__init__()
        self.origin = np.array(center, dtype=float)
        p = lambda x, y: self.origin + np.array([x, y, 0.0])
        shadow = Ellipse(width=2.0, height=0.22, fill_color="#080F1C", fill_opacity=0.5, stroke_width=0).move_to(p(0, -1.06))
        feet = VGroup(*[RoundedRectangle(width=0.55, height=0.24, corner_radius=0.10, fill_color=PALETTE["muted"], fill_opacity=1, stroke_width=0).move_to(p(x, -0.91)) for x in (-0.37, 0.37)])
        self.body = RoundedRectangle(width=1.16, height=1.55, corner_radius=0.24, fill_color=PALETTE["copper"], fill_opacity=1, stroke_color="#FCD5A5", stroke_width=2).move_to(p(0, -0.02))
        badge = Circle(radius=0.20, fill_color=PALETTE["dark"], fill_opacity=1, stroke_width=0).move_to(p(0, 0.06))
        badge.add(Line(p(-0.09, 0.02), p(0, 0.13), color=PALETTE["mint"], stroke_width=3), Line(p(0, 0.13), p(0.10, -0.01), color=PALETTE["mint"], stroke_width=3))
        shell = RoundedRectangle(width=1.62, height=1.25, corner_radius=0.32, fill_color=PALETTE["copper"], fill_opacity=1, stroke_color="#FCD5A5", stroke_width=2).move_to(p(0, 1.25))
        visor = RoundedRectangle(width=1.31, height=0.76, corner_radius=0.20, fill_color=PALETTE["dark"], fill_opacity=1, stroke_width=0).move_to(p(0, 1.25))
        antenna = VGroup(Line(p(0, 1.86), p(0, 2.06), color=PALETTE["copper"], stroke_width=4), Dot(p(0, 2.13), radius=0.11, color=PALETTE["mint"]))
        self.eyes = VGroup(*[Ellipse(width=0.16, height=0.21, fill_color=PALETTE["ink"], fill_opacity=1, stroke_width=0).move_to(p(x, 1.38)) for x in (-0.30, 0.30)])
        self.mouths = {}
        self.mouths["X"] = ArcBetweenPoints(p(-0.20, 1.03), p(0.20, 1.03), angle=0.45, color=PALETTE["mint"], stroke_width=3)
        self.mouths["A"] = Line(p(-0.20, 1.02), p(0.20, 1.02), color=PALETTE["ink"], stroke_width=3)
        for code, width, height in (("B", .43, .13), ("C", .43, .25), ("D", .36, .42), ("E", .27, .30), ("F", .18, .21), ("G", .41, .15), ("H", .36, .24)):
            shape = Ellipse(width=width, height=height, fill_color="#080D18", fill_opacity=1, stroke_color=PALETTE["ink"], stroke_width=2).move_to(p(0, 1.04))
            if code in ("B", "G"):
                shape.add(Line(p(-width*.32, 1.06), p(width*.32, 1.06), color=PALETTE["ink"], stroke_width=3))
            if code in ("D", "H"):
                shape.add(Ellipse(width=width*.53, height=height*.26, fill_color="#EBA4A7", fill_opacity=1, stroke_width=0).move_to(p(0, 1.04-height*.28)))
            self.mouths[code] = shape
        self.arms = VGroup(*[Line(p(0, 0), p(1, 0), color=PALETTE["copper"], stroke_width=8) for _ in range(4)])
        self.hands = VGroup(*[Circle(radius=.13, fill_color=PALETTE["copper"], fill_opacity=1, stroke_color="#FCD5A5", stroke_width=1.5) for _ in range(2)])
        nameplate = label(name.upper(), 15, PALETTE["muted"]).move_to(p(0, -.51))
        self.add(shadow, feet, self.arms, self.body, badge, nameplate, shell, visor, antenna, self.eyes, *self.mouths.values(), self.hands)
        self._eye_height = self.eyes[0].height
        self.pose(0, "X", "rest", 0)

    def pose(self, time, mouth, gesture, gesture_progress):
        p = lambda x, y: self.origin + np.array([x, y, 0.0])
        emphasis = math.sin(math.pi * min(1, max(0, gesture_progress)))
        right = (1.15, .68 + .50 * emphasis) if gesture == "point" else (1.16, .25 + .20 * emphasis) if gesture == "open" else (.92, -.42)
        left = (-1.18, .25 + .15 * emphasis) if gesture == "open" else (-.86, -.46)
        endpoints = ((p(-.58, .30), p(-.90, -.04)), (p(-.90, -.04), p(*left)),
                     (p(.58, .30), p(.91, .10)), (p(.91, .10), p(*right)))
        for arm, (start, end) in zip(self.arms, endpoints):
            arm.put_start_and_end_on(start, end)
        self.hands[0].move_to(p(*left))
        self.hands[1].move_to(p(*right))
        # Deterministic blinks and cue-driven nods, independent of random state.
        blink = max(0.07, 1-math.sin(math.pi * ((time + .6) % 3.8) / .13)) if ((time + .6) % 3.8) < .13 else 1
        for index, eye in enumerate(self.eyes):
            eye.stretch_to_fit_height(self._eye_height * blink)
            eye.move_to(p((-.30, .30)[index], 1.38 - (.06 * emphasis if gesture == "nod" else 0)))
        for code, shape in self.mouths.items():
            shape.set_opacity(1 if code == mouth else 0)


class CaptionRail(VGroup):
    """Phrase layout is built once; the exact active word changes color."""

    def __init__(self, lesson):
        super().__init__()
        self.lesson = lesson
        self.phrases = []
        background = RoundedRectangle(width=7.1, height=1.60, corner_radius=.24, fill_color="#0A1321", fill_opacity=.92, stroke_color=PALETTE["edge"], stroke_width=1).move_to([0, -5.28, 0])
        self.add(background)
        for caption in lesson["captions"]:
            words = [label(word["text"], 34) for word in caption["words"]]
            lines, current, width = [], [], 0
            for word in words:
                fit_width(word, 6.45)
                if current and width + word.width + .14 > 6.45:
                    lines.append(VGroup(*current).arrange(np.array([1, 0, 0]), buff=.14))
                    current, width = [], 0
                current.append(word)
                width += word.width + .14
            if current:
                lines.append(VGroup(*current).arrange(np.array([1, 0, 0]), buff=.14))
            if len(lines) > 2:
                raise ValueError("Caption phrase requires more than two portrait-safe lines.")
            phrase = VGroup(*lines).arrange(np.array([0, -1, 0]), buff=.15).move_to([0, -5.28, 0])
            self.phrases.append((phrase, words))
            self.add(phrase)
        self.update_time(0)

    def update_time(self, time_us):
        visible, active = caption_at(self.lesson, time_us)
        for index, (phrase, words) in enumerate(self.phrases):
            phrase.set_opacity(1 if index == visible else 0)
            for word_index, word in enumerate(words):
                word.set_color(PALETTE["mint"] if index == visible and word_index == active else PALETTE["ink"])


class PythagoreanPanel(VGroup):
    """A concrete integer-triangle example with one retained identity per tile."""

    def __init__(self, lesson):
        super().__init__()
        self.lesson, self.facts = lesson, triangle_facts(lesson["topic"]["legs"])
        a, b, c = (self.facts[key] for key in ("a", "b", "c"))
        panel = RoundedRectangle(width=7.05, height=6.3, corner_radius=.32, fill_color=PALETTE["panel"], fill_opacity=1, stroke_color=PALETTE["edge"], stroke_width=1.5).move_to([0, 2.04, 0])
        heading = label("THE GEOMETRY", 18, PALETTE["muted"]).move_to([0, 4.69, 0])
        unit = min(3.30 / b, 2.60 / a)
        origin = np.array([-b*unit/2, 1.30, 0.0])
        A, B, C = (origin + np.array([x*unit, y*unit, 0.0]) for x, y in self.facts["vertices"])
        fill = Polygon(A, B, C, fill_color=PALETTE["blue"], fill_opacity=.08, stroke_width=0)
        sides = VGroup(Line(A, C, color=PALETTE["mint"], stroke_width=5), Line(A, B, color=PALETTE["blue"], stroke_width=5), Line(B, C, color=PALETTE["ink"], stroke_width=4))
        corner = VGroup(Line(A+[.22, 0, 0], A+[.22, .22, 0], color=PALETTE["muted"], stroke_width=2), Line(A+[.22, .22, 0], A+[0, .22, 0], color=PALETTE["muted"], stroke_width=2))
        side_labels = VGroup(label(str(a), 34, PALETTE["mint"]).move_to((A+C)/2+[-.40, 0, 0]), label(str(b), 34, PALETTE["blue"]).move_to((A+B)/2+[0, -.39, 0]), label("?", 34).move_to((B+C)/2+[.35, .25, 0]))
        self.triangle = VGroup(fill, sides, corner, side_labels)
        self.triangle_caption = label("A right angle changes everything.", 21, PALETTE["muted"]).move_to([0, .10, 0])
        self.tiles, self.paths = VGroup(), []
        cell = min(.68, 5.8 / (a+b+1), 3.25/c)
        left_edge = -(a+b+1)*cell/2
        for tile in tile_layout([a, b]):
            group_side = a if tile["group"] == "a" else b
            group_x = left_edge if tile["group"] == "a" else left_edge + (a+1)*cell
            column, row = tile["source"]
            start = np.array([group_x+(column+.5)*cell, 2.65+(group_side/2-row-.5)*cell, 0])
            column, row = tile["target"]
            target = np.array([(column+.5-c/2)*cell, 2.65+(c/2-row-.5)*cell, 0])
            color = PALETTE["mint"] if tile["group"] == "a" else PALETTE["blue"]
            square = RoundedRectangle(width=cell*.92, height=cell*.92, corner_radius=cell*.10, fill_color=color, fill_opacity=1, stroke_width=0).move_to(start)
            self.tiles.add(square)
            self.paths.append((start, target))
        self.square_labels = VGroup(label(f"{a}² = {a*a}", 28, PALETTE["mint"]).move_to([left_edge+a*cell/2, .40, 0]), label(f"{b}² = {b*b}", 28, PALETTE["blue"]).move_to([left_edge+(a+1+b/2)*cell, .40, 0]))
        self.sum_label = fit_width(label(f"{a*a} + {b*b} = {c*c}", 38), 6).move_to([0, .42, 0])
        self.result_label = fit_width(math_label(f"{a}^2 + {b}^2 = {c}^2", 37, PALETTE["mint"]), 6).move_to([0, -.40, 0])
        self.add(panel, heading, self.triangle, self.triangle_caption, self.tiles, self.square_labels, self.sum_label, self.result_label)
        self.update_time(0)

    def update_time(self, time):
        squares, rearrange, result = (self.lesson["beats"][key]/1_000_000 for key in ("squaresUs", "rearrangeUs", "resultUs"))
        opening = smooth_between(time, .10, .65)
        triangle_alpha = opening * (1-smooth_between(time, squares-.30, squares+.10))
        self.triangle.set_opacity(triangle_alpha)
        self.triangle[0].set_fill(opacity=.08*triangle_alpha)
        self.triangle_caption.set_opacity(triangle_alpha)
        tile_alpha = smooth_between(time, squares-.05, squares+.40)
        progress = smooth_between(time, rearrange, result)
        for index, (square, (start, target)) in enumerate(zip(self.tiles, self.paths)):
            stagger = index/max(1, len(self.tiles)-1)*.12
            local = smooth_between(progress, stagger, 1)
            position = start*(1-local)+target*local
            position += np.array([0, .20*math.sin(math.pi*local), 0])
            square.move_to(position).set_opacity(tile_alpha)
        self.square_labels.set_opacity(tile_alpha*(1-smooth_between(time, rearrange-.2, rearrange+.3)))
        self.sum_label.set_opacity(smooth_between(time, rearrange+.2, rearrange+.7))
        self.result_label.set_opacity(smooth_between(time, result, result+.5))


class EducationalScene(Scene):
    """Subclass with ``lesson_data`` supplied by an explicit retained entrypoint."""

    lesson_data = None

    def construct(self):
        lesson = parse_lesson(self.lesson_data)
        if not .48 <= config.pixel_width/config.pixel_height <= .75:
            raise ValueError("This educational layout is portrait; use a custom Scene for other aspects.")
        config.background_color = PALETTE["background"]
        self.camera.background_color = PALETTE["background"]
        # Keep the entire authored panel and caption rail inside wider portrait frames.
        self.camera.frame_height = max(14.24, 8*config.pixel_height/config.pixel_width)
        self.camera.frame_width = self.camera.frame_height*config.pixel_width/config.pixel_height
        title = fit_width(label(lesson["title"], 43), 7.0).move_to([0, 6.20, 0])
        subtitle = fit_width(label(lesson["subtitle"], 21, PALETTE["muted"]), 6.8).move_to([0, 5.62, 0])
        panel = PythagoreanPanel(lesson)
        presenter = Presenter(lesson["presenter"]["name"])
        note = VGroup(label("SQUARE THE LEGS", 20, PALETTE["muted"]), label("ADD THE AREAS", 24, PALETTE["mint"])).arrange(np.array([0, -1, 0]), buff=.16).move_to([1.36, -2.65, 0])
        line = Line([-3.45, -4.07, 0], [3.45, -4.07, 0], color=PALETTE["edge"], stroke_width=1)
        rail = CaptionRail(lesson)
        if not lesson.get("showCaptions", True):
            rail.set_opacity(0)
        clock = ValueTracker(0)
        def update(_):
            time = clock.get_value()
            time_us = round(time*1_000_000)
            cue = cue_at(lesson["gestures"], time_us)
            gesture = cue["kind"] if cue else "rest"
            progress = (time_us-cue["startUs"])/(cue["endUs"]-cue["startUs"]) if cue else 0
            presenter.pose(time, mouth_at(lesson, time_us), gesture, progress)
            panel.update_time(time)
            if lesson.get("showCaptions", True):
                rail.update_time(time_us)
        animated = VGroup(panel, presenter, rail)
        animated.add_updater(update)
        self.add(title, subtitle, note, line, clock, animated)
        self.play(clock.animate.set_value(lesson["durationUs"]/1_000_000), run_time=lesson["durationUs"]/1_000_000, rate_func=linear)


def lesson_from_context(context):
    """Read a named retained lesson file or inline plain data at render time."""
    parameters = context["parameters"]
    if "lesson" in parameters:
        return parse_lesson(parameters["lesson"])
    relative = parameters.get("lessonFile", "lesson.json")
    if not isinstance(relative, str):
        raise ValueError("The lesson file must be a relative path string.")
    root = Path(context["sourceRoot"]).resolve()
    path = root / relative
    if path.is_symlink() or path.resolve() != path or root not in path.parents:
        raise ValueError("The lesson must be a physical file inside the retained source root.")
    with path.open("rb") as handle:
        contents = handle.read(256*1024+1)
    if len(contents) > 256*1024:
        raise ValueError("Lesson JSON exceeds 256 KiB.")
    return parse_lesson(json.loads(contents))
