"""An explicitly trusted author entrypoint, evaluated only by a render job."""

from toolkit import EducationalScene, lesson_from_context


class PythagoreanLesson(EducationalScene):
    lesson_data = lesson_from_context(SLOPCAMERA_CONTEXT)
