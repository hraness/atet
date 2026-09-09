/** Keep CLI parsing independent from embedded native source and runtime imports. */
export const STUDIO_TEMPLATES = ["blender-product", "blender-character", "blender-cloth", "blender-fluid", "cadquery-bracket", "manim-lesson"] as const;
export type StudioTemplate = typeof STUDIO_TEMPLATES[number];
