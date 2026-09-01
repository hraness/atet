import { z } from "zod";

import type { HtmlOverlayInlineDocument } from "./contracts";
import {
  serializeHtmlOverlayImportMap,
  type HtmlOverlayLibrarySpecifier,
} from "./libraries";

export const HTML_OVERLAY_SCAFFOLD_KINDS = [
  "plain",
  "motion",
  "paper-shaders",
  "three",
  "vgpu",
] as const;

export const HtmlOverlayScaffoldKindSchema = z.enum(HTML_OVERLAY_SCAFFOLD_KINDS);
export type HtmlOverlayScaffoldKind = typeof HTML_OVERLAY_SCAFFOLD_KINDS[number];

export const HTML_OVERLAY_TRANSPARENT_RESET_CSS = `html,
body {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
  background: transparent !important;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}`;

function documentShell(
  body: string,
  moduleSource: string,
  importMap: string | null,
): string {
  const importMapElement = importMap === null
    ? ""
    : `\n    <script type="importmap">${importMap}</script>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
${HTML_OVERLAY_TRANSPARENT_RESET_CSS}
    </style>${importMapElement}
  </head>
  <body>
${body}
    <script type="module">
${moduleSource}
    </script>
  </body>
</html>
`;
}

const PLAIN_SCAFFOLD = documentShell(
  `    <div class="label">Recording</div>
    <style>
      .label {
        position: absolute;
        left: 6%;
        bottom: 8%;
        padding: 0.55em 0.8em;
        border: 1px solid rgb(255 255 255 / 24%);
        border-radius: 0.7em;
        color: white;
        background: rgb(12 16 24 / 82%);
        font: 600 clamp(24px, 4vw, 72px) / 1 system-ui, sans-serif;
        opacity: 0;
        transform-origin: left center;
      }
    </style>`,
  `      const label = document.querySelector(".label");
      AtetOverlay.onFrame(({ progress }) => {
        const reveal = Math.min(1, progress * 8);
        label.style.opacity = String(reveal);
        label.style.transform = \`scale(\${0.94 + reveal * 0.06})\`;
      });`,
  null,
);

const MOTION_SCAFFOLD = documentShell(
  `    <div class="card">Deterministic motion</div>
    <style>
      .card {
        position: absolute;
        left: 8%;
        top: 12%;
        padding: 0.7em 0.9em;
        border-radius: 0.8em;
        color: white;
        background: linear-gradient(135deg, rgb(83 67 255 / 92%), rgb(205 74 255 / 82%));
        box-shadow: 0 1em 3em rgb(14 8 48 / 28%);
        font: 650 clamp(28px, 5vw, 84px) / 1 system-ui, sans-serif;
        opacity: 0;
      }
    </style>`,
  `      import { animate } from "motion";

      const card = document.querySelector(".card");
      AtetOverlay.trackAnimation(animate(
        card,
        {
          opacity: [0, 1, 1, 0],
          transform: [
            "translateY(40px) scale(.96)",
            "translateY(0) scale(1)",
            "translateY(0) scale(1)",
            "translateY(-24px) scale(.98)",
          ],
        },
        { duration: AtetOverlay.durationMs / 1000, ease: "linear" },
      ));`,
  serializeHtmlOverlayImportMap(["motion"]),
);

const PAPER_SCAFFOLD = documentShell(
  `    <div class="shader" aria-hidden="true"></div>
    <style>
      .shader {
        position: absolute;
        inset: 10%;
        overflow: hidden;
        border-radius: min(8vw, 96px);
        filter: drop-shadow(0 24px 64px rgb(21 9 60 / 25%));
      }
    </style>`,
  `      import {
        ShaderFitOptions,
        ShaderMount,
        getShaderColorFromString,
        meshGradientFragmentShader,
      } from "@paper-design/shaders";

      const colors = ["#6d5dfc", "#ff67c7", "#56e0d3", "#ffd166"];
      const shader = new ShaderMount(
        document.querySelector(".shader"),
        meshGradientFragmentShader,
        {
          u_colors: colors.map(getShaderColorFromString),
          u_colorsCount: colors.length,
          u_distortion: 0.8,
          u_fit: ShaderFitOptions.cover,
          u_grainMixer: 0.16,
          u_grainOverlay: 0.08,
          u_offsetX: 0,
          u_offsetY: 0,
          u_originX: 0.5,
          u_originY: 0.5,
          u_rotation: 0,
          u_scale: 1,
          u_swirl: 0.35,
          u_worldHeight: AtetOverlay.height,
          u_worldWidth: AtetOverlay.width,
        },
        { alpha: true, premultipliedAlpha: false },
        0,
      );

      AtetOverlay.onFrame(({ timeMs }) => shader.setFrame(timeMs));`,
  serializeHtmlOverlayImportMap(["@paper-design/shaders"]),
);

const THREE_SCAFFOLD = documentShell(
  `    <canvas class="scene" aria-hidden="true"></canvas>
    <style>
      .scene {
        display: block;
        width: 100%;
        height: 100%;
        contain: strict;
      }
    </style>`,
  `      import * as THREE from "three";

      // Keep this scene seek-stable: derive motion from progress/timeMs and use
      // AtetOverlay.randomFor(key), never requestAnimationFrame or mutable RNG.
      const MAX_DRAW_CALLS = 64;
      const MAX_TRIANGLES = 200_000;
      const canvas = document.querySelector(".scene");
      const renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        canvas,
        powerPreference: "high-performance",
        premultipliedAlpha: false,
      });
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1;
      renderer.shadowMap.enabled = false;
      // The authoring canvas owns preview/final supersampling. Use 1x for
      // iteration and raise deviceScaleFactor only for a selected final render.
      renderer.setPixelRatio(devicePixelRatio);
      renderer.setSize(AtetOverlay.width, AtetOverlay.height, false);
      renderer.setClearColor(0x000000, 0);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(
        42,
        AtetOverlay.width / AtetOverlay.height,
        0.1,
        100,
      );

      const disposable = new Set();
      const track = (resource) => {
        disposable.add(resource);
        return resource;
      };

      // Replace only this function when generating a subject. Reuse geometry
      // and materials, prefer instancing for repeated forms, and track every
      // GPU resource created outside this starter.
      function createSubject() {
        const subject = new THREE.Group();
        const geometry = track(new THREE.IcosahedronGeometry(0.72, 1));
        const material = track(new THREE.MeshStandardMaterial({
          color: 0x7c6cff,
          flatShading: true,
          metalness: 0.18,
          roughness: 0.42,
        }));
        for (const [x, y, z, scale] of [
          [-0.72, 0, 0, 1],
          [0.72, 0, 0, 0.82],
          [0, 0.72, -0.08, 0.68],
          [0, -0.72, 0.08, 0.58],
        ]) {
          const part = new THREE.Mesh(geometry, material);
          part.position.set(x, y, z);
          part.scale.setScalar(scale);
          subject.add(part);
        }
        return subject;
      }

      const subject = createSubject();
      scene.add(subject);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x20243a, 2.1));
      const keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
      keyLight.position.set(3, 5, 4);
      scene.add(keyLight);

      const bounds = new THREE.Box3().setFromObject(subject);
      const sphere = bounds.getBoundingSphere(new THREE.Sphere());
      const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov * 0.5);
      const horizontalHalfFov = Math.atan(
        Math.tan(verticalHalfFov) * camera.aspect,
      );
      const fitHalfFov = Math.min(verticalHalfFov, horizontalHalfFov);
      const framingDistance = Math.max(
        0.01,
        (sphere.radius / Math.sin(fitHalfFov)) * 1.25,
      );
      camera.near = Math.max(0.01, framingDistance / 100);
      camera.far = framingDistance * 20;
      camera.updateProjectionMatrix();
      const cameraDirection = new THREE.Vector3(0.42, 0.24, 1).normalize();
      camera.position.copy(sphere.center).addScaledVector(
        cameraDirection,
        framingDistance,
      );
      camera.lookAt(sphere.center);

      const explodeParts = subject.children.map((part) => {
        const home = part.position.clone();
        const direction = home.clone();
        if (direction.lengthSq() === 0) direction.set(0, 1, 0);
        direction.normalize();
        return { direction, home, part };
      });
      const numberParameter = (name, fallback, minimum, maximum) => {
        const value = AtetOverlay.parameters[name];
        return typeof value === "number" && Number.isFinite(value)
          ? THREE.MathUtils.clamp(value, minimum, maximum)
          : fallback;
      };
      const explodeDistance = numberParameter("explode", 0.45, 0, 4);
      const orbitTurns = numberParameter("orbitTurns", 1, -8, 8);
      const zoom = numberParameter("zoom", 1, 0.25, 4);

      canvas.addEventListener("webglcontextlost", (event) => {
        event.preventDefault();
        throw new Error("The Three.js rendering context was lost.");
      });
      AtetOverlay.ready(renderer.compileAsync(scene, camera));

      AtetOverlay.onFrame(({ progress }) => {
        const phase = progress * Math.PI * 2;
        subject.rotation.set(
          Math.sin(phase) * 0.08,
          phase * orbitTurns,
          Math.cos(phase) * 0.04,
        );
        const explode = Math.sin(progress * Math.PI) ** 2 * explodeDistance;
        for (const { direction, home, part } of explodeParts) {
          part.position.copy(home).addScaledVector(direction, explode);
        }
        camera.position.copy(sphere.center).addScaledVector(
          cameraDirection,
          framingDistance / zoom,
        );
        camera.lookAt(sphere.center);
        renderer.render(scene, camera);
        if (
          renderer.info.render.calls > MAX_DRAW_CALLS
          || renderer.info.render.triangles > MAX_TRIANGLES
        ) {
          throw new Error(
            "Three.js render budget exceeded: "
              + renderer.info.render.calls
              + " calls, "
              + renderer.info.render.triangles
              + " triangles.",
          );
        }
      });

      addEventListener("pagehide", () => {
        for (const resource of disposable) resource.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
      }, { once: true });`,
  serializeHtmlOverlayImportMap(["three"]),
);

const VGPU_SCAFFOLD = documentShell(
  `    <canvas class="effect" aria-hidden="true"></canvas>
    <style>
      .effect {
        display: block;
        width: 100%;
        height: 100%;
        contain: strict;
      }
    </style>`,
  `      import { effect, frame, init, surface, target } from "vgpu";

      // Keep this starter seek-stable: derive every value from the absolute
      // Atet frame and submit one bounded fullscreen pass per output frame.
      const canvas = document.querySelector(".effect");
      const shaderSource = \`
        struct Params {
          time: f32,
          resolution: vec2f,
          intensity: f32,
        }

        @group(0) @binding(0) var<uniform> params: Params;

        fn palette(value: f32) -> vec3f {
          let phase = vec3f(0.08, 0.31, 0.58) + value;
          return vec3f(0.55) + 0.45 * cos(6.2831853 * phase);
        }

        @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
          let safeHeight = max(params.resolution.y, 1.0);
          let aspect = params.resolution.x / safeHeight;
          let point = (uv - vec2f(0.5)) * vec2f(aspect, 1.0);
          let wave = sin(point.x * 5.0 + params.time * 1.4) * 0.08
            + sin(point.x * 11.0 - params.time * 0.9) * 0.035;
          let band = exp(-abs(point.y - wave) * 18.0);
          let halo = exp(-length(point) * 3.4);
          let alpha = clamp(
            (band * 0.72 + halo * 0.22) * params.intensity,
            0.0,
            0.86,
          );
          let color = palette(point.x * 0.16 + params.time * 0.035);
          return vec4f(color * alpha, alpha);
        }
      \`;

      const numberParameter = (name, fallback, minimum, maximum) => {
        const value = AtetOverlay.parameters[name];
        return typeof value === "number" && Number.isFinite(value)
          ? Math.min(maximum, Math.max(minimum, value))
          : fallback;
      };
      const intensity = numberParameter("intensity", 1, 0, 2);
      const speed = numberParameter("speed", 1, -8, 8);
      const initialization = (async () => {
        if (navigator.gpu === undefined) {
          throw new Error("The vgpu scaffold requires WebGPU in the selected browser runtime.");
        }
        const gpu = await init({ powerPreference: "high-performance" });
        let asynchronousError = null;
        const releaseErrorListener = gpu.onError((error) => {
          asynchronousError ??= error;
        });
        void gpu.gpu.lost.then(() => {
          if (!gpu.disposed) {
            asynchronousError ??= new Error(
              "The WebGPU device was lost during the HTML overlay render.",
            );
          }
        });
        try {
          const output = surface(gpu, canvas, {
            alphaMode: "premultiplied",
            autoResize: false,
            clearColor: [0, 0, 0, 0],
            dpr: devicePixelRatio,
          });
          const shader = effect(gpu, shaderSource, {
            set: {
              params: {
                intensity,
                resolution: output.size,
                time: 0,
              },
            },
          });
          const pipelineTarget = target(gpu, {
            format: output.format,
            size: [1, 1],
          });
          try {
            await shader.compile(pipelineTarget);
          } finally {
            pipelineTarget.destroy();
          }
          await gpu.settled();
          if (asynchronousError !== null) throw asynchronousError;
          return {
            dispose() {
              releaseErrorListener();
              gpu.dispose();
            },
            gpu,
            output,
            shader,
            takeError() {
              const error = asynchronousError;
              asynchronousError = null;
              return error;
            },
          };
        } catch (error) {
          try {
            releaseErrorListener();
            gpu.dispose();
          } catch {
            // Preserve the initialization failure if cleanup also fails.
          }
          throw error;
        }
      })();

      AtetOverlay.ready(initialization);
      AtetOverlay.onFrame(async ({ timeMs }) => {
        const state = await initialization;
        state.shader.set({
          params: {
            intensity,
            resolution: state.output.size,
            time: timeMs * speed / 1000,
          },
        });
        const submitted = frame(state.gpu, (currentFrame) => {
          currentFrame.pass(
            { clear: [0, 0, 0, 0], target: state.output },
            state.shader,
          );
        });
        await submitted.done;
        await state.gpu.settled();
        const error = state.takeError();
        if (error !== null) throw error;
      });

      addEventListener("pagehide", () => {
        void initialization.then((state) => state.dispose()).catch(() => undefined);
      }, { once: true });`,
  serializeHtmlOverlayImportMap(["vgpu"]),
);

const SCAFFOLDS = Object.freeze({
  motion: MOTION_SCAFFOLD,
  "paper-shaders": PAPER_SCAFFOLD,
  plain: PLAIN_SCAFFOLD,
  three: THREE_SCAFFOLD,
  vgpu: VGPU_SCAFFOLD,
}) satisfies Readonly<Record<HtmlOverlayScaffoldKind, string>>;

const SCAFFOLD_LIBRARIES = Object.freeze({
  motion: ["motion"],
  "paper-shaders": ["@paper-design/shaders"],
  plain: [],
  three: ["three"],
  vgpu: ["vgpu"],
}) satisfies Readonly<
  Record<HtmlOverlayScaffoldKind, readonly HtmlOverlayLibrarySpecifier[]>
>;

export interface HtmlOverlayScaffoldInput {
  readonly document: HtmlOverlayInlineDocument;
  /** Exact browser libraries required by the generated document. */
  readonly libraries: HtmlOverlayLibrarySpecifier[];
}

export const THREE_REFERENCE_RESOURCE_NAME = "reference-image" as const;
export const THREE_REFERENCE_RESOURCE_URL_PATH =
  "assets/reference-image" as const;

export interface ThreeReferenceScaffoldInput<TArtifact, TMediaType>
  extends HtmlOverlayScaffoldInput {
  readonly resources: readonly [{
    readonly artifact: TArtifact;
    readonly mediaType: TMediaType;
    readonly name: typeof THREE_REFERENCE_RESOURCE_NAME;
    readonly urlPath: typeof THREE_REFERENCE_RESOURCE_URL_PATH;
  }];
}

export function createHtmlOverlayScaffoldInput(
  kind: HtmlOverlayScaffoldKind,
): HtmlOverlayScaffoldInput {
  const parsed = HtmlOverlayScaffoldKindSchema.parse(kind);
  const libraries: HtmlOverlayLibrarySpecifier[] = [
    ...SCAFFOLD_LIBRARIES[parsed],
  ];
  Object.freeze(libraries);
  return Object.freeze({
    document: Object.freeze({ html: SCAFFOLDS[parsed] }),
    libraries,
  });
}

export function createHtmlOverlayScaffold(kind: HtmlOverlayScaffoldKind): string {
  return SCAFFOLDS[HtmlOverlayScaffoldKindSchema.parse(kind)];
}

/**
 * Binds one exact image to the general Three.js starter as code-generation
 * provenance. The author edits the returned document's createSubject()
 * function after inspecting that image; Atet never evaluates model text.
 */
export function createThreeReferenceScaffoldInput<TArtifact, TMediaType>(
  artifact: TArtifact,
  mediaType: TMediaType,
): ThreeReferenceScaffoldInput<TArtifact, TMediaType> {
  const scaffold = createHtmlOverlayScaffoldInput("three");
  const resource = Object.freeze({
    artifact,
    mediaType,
    name: THREE_REFERENCE_RESOURCE_NAME,
    urlPath: THREE_REFERENCE_RESOURCE_URL_PATH,
  });
  const resources = Object.freeze([resource] as const);
  return Object.freeze({ ...scaffold, resources });
}
