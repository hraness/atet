/** Opt-in real native/browser qualification. Writes only ignored artifacts. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { arch, cpus, release, totalmem } from "node:os";
import sharp from "sharp";
import { chromium, type Page } from "playwright-core";
import {
  applySpatialScenePatch, evaluateSpatialScene, generatedSpatialEntityId, parseSpatialScene,
  spatialGeneratorOutputSha256, spatialSceneSha256, type SpatialAssetManifest,
} from "../../../src/spatial-scene/index";
import { BunProcessRunner } from "../cli/io";
import { PlaywrightHtmlOverlayRenderer } from "../cli/html-overlay-renderer";
import type { ApplicationCapability, ApplicationContext } from "../application/context";
import { bindSpatialRenderInput, executeSpatialRender, recoverSpatialRenderOutput } from "../application/operations/spatial-render";
import { SpatialRenderReceiptSchema, type SpatialRenderRequest, type SpatialRenderResult } from "../application/spatial-render";

const repositoryRoot = await realpath(resolve(import.meta.dir, "../../.."));
const root = join(repositoryRoot, "artifacts", "spatial-qualification", new Date().toISOString().replaceAll(":", "-"));
await mkdir(root, { recursive: true, mode: 0o700 });
const assetsRoot = join(root, "source"); await mkdir(assetsRoot, { mode: 0o700 });
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const nativeRunner = new BunProcessRunner();
const referenceProfile = process.argv.includes("--reference");
const shotProfile = process.argv.includes("--shot");
assert.ok(!(referenceProfile && shotProfile), "Choose one qualification profile.");
let activeRender = "fixture", activeBatch = 0, activeBrowsers = 0;
let cancellation: { controller: AbortController; requestedAt?: number } | undefined;
const measures = { native: [] as { render: string; argv: readonly string[]; milliseconds: number }[], launches: [] as { render: string; batch: number; milliseconds: number; arguments: readonly string[] }[],
  frames: [] as { render: string; batch: number; frame: number; evaluationStart: number; evaluationMs: number; screenshotMs?: number; completeMs?: number }[],
  batches: [] as { render: string; batch: number; milliseconds: number; frames: number }[], libraryFetches: [] as { render: string; url: string }[], parentPeakRssBytes: 0,
  graphics: [] as { render: string; batch: number; renderer: string; vendor: string; version: string; unmaskedRenderer: string | null }[] };
const memoryTimer = setInterval(() => { measures.parentPeakRssBytes = Math.max(measures.parentPeakRssBytes, process.memoryUsage().rss); }, 250); memoryTimer.unref();
const runner = { run: async (...args: Parameters<BunProcessRunner["run"]>) => {
  const start = performance.now(); try { return await nativeRunner.run(...args); }
  finally { measures.native.push({ render: activeRender, argv: args[0], milliseconds: performance.now() - start }); }
} };
function observed<T extends object>(target: T, callbacks: Record<string, (result: unknown, args: unknown[], start: number) => unknown>): T {
  return new Proxy(target, { get(object, property) {
    const value: unknown = Reflect.get(object, property, object);
    if (typeof value !== "function") return value;
    const callback = typeof property === "string" ? callbacks[property] : undefined;
    return callback === undefined ? value.bind(object) : async (...args: unknown[]) => {
      const start = performance.now(); const result: unknown = await Reflect.apply(value, object, args);
      return callback(result, args, start);
    };
  } });
}
const actualRenderer = new PlaywrightHtmlOverlayRenderer({ cacheRoot: join(root, "library-cache"), browserStepTimeoutMs: 60_000, frameTimeoutMs: 30_000,
  fetch: async (input, init) => { measures.libraryFetches.push({ render: activeRender, url: String(input) }); return await fetch(input, init); },
  launch: async options => {
    const start = performance.now(), launched = await chromium.launch(options);
    measures.launches.push({ render: activeRender, batch: activeBatch, milliseconds: performance.now() - start, arguments: options.args ?? [] });
    activeBrowsers++; launched.on("disconnected", () => { activeBrowsers--; });
    return observed(launched, { newContext: result => observed(result as object, {
      newPage: result => observed(result as object, {
        evaluateHandle: result => observed(result as object, { evaluate: (value, args, start) => {
          const frame = args[1]; if (frame !== null && typeof frame === "object" && "frame" in frame && typeof frame.frame === "number") {
            measures.frames.push({ render: activeRender, batch: activeBatch, frame: frame.frame, evaluationStart: start, evaluationMs: performance.now() - start });
          }
          return value;
        } }),
        screenshot: async (value, _args, start) => {
          const frame = measures.frames.at(-1); if (frame !== undefined) { frame.screenshotMs = performance.now() - start; frame.completeMs = performance.now() - frame.evaluationStart; }
          if (frame?.frame === 0) {
            const graphics = await (result as Page).evaluate(() => {
              const gl = document.querySelector("canvas")?.getContext("webgl2"); if (!gl) throw new Error("Missing qualified WebGL2 canvas");
              const extension = gl.getExtension("WEBGL_debug_renderer_info");
              return {renderer:String(gl.getParameter(gl.RENDERER)),vendor:String(gl.getParameter(gl.VENDOR)),version:String(gl.getParameter(gl.VERSION)),unmaskedRenderer:extension===null?null:String(gl.getParameter(extension.UNMASKED_RENDERER_WEBGL))};
            });
            measures.graphics.push({ render: activeRender, batch: activeBatch, ...graphics });
          }
          if (cancellation !== undefined && cancellation.requestedAt === undefined) { cancellation.requestedAt = performance.now(); cancellation.controller.abort(new Error("Qualification cancellation after first actual frame")); }
          return value;
        },
      }),
    }) });
  },
});
const commands: unknown[] = [];
async function run(argv: [string, ...string[]]) {
  const output = await runner.run(argv, { cwd: root, stdin: "ignore", timeoutMs: 120_000, maxOutputBytes: 8 * 1024 * 1024 });
  commands.push({ argv, ...output });
  assert.equal(output.exitCode, 0, output.stderr);
  return output.stdout;
}
const ffmpeg = "/opt/homebrew/bin/ffmpeg", ffprobe = "/opt/homebrew/bin/ffprobe";
const browser = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const capabilities: ApplicationCapability[] = [];
for (const [name, command, flag] of [["ffmpeg", ffmpeg, "-version"], ["ffprobe", ffprobe, "-version"], ["html-browser", browser, "--version"]] as const) {
  capabilities.push({ name, command, available: true, version: (await run([command, flag])).split("\n")[0]! });
}
const application: ApplicationContext = {
  paths: { repositoryRoot, artifactRoot: join(root, "recordings"), privateRoot: join(root, "private"), projectRoot: join(root, "projects"), desktopRoot: join(repositoryRoot, "apps", "desktop") },
  clock: { now: () => new Date(), timestampMilliseconds: Date.now }, runner,
  capability: async name => capabilities.find(item => item.name === name) ?? { name, available: false },
  capabilities: async () => capabilities,
  htmlOverlayRenderer: { async renderFrames(request, signal) {
    const batch = activeBatch, start = performance.now();
    console.log(JSON.stringify({ event: "batch-start", render: activeRender, batch, frames: request.authoring.timing.durationUs / 1_000_000 }));
    const result = await actualRenderer.renderFrames(request, signal);
    measures.batches.push({ render: activeRender, batch, milliseconds: performance.now() - start, frames: result.frameCount });
    activeBatch++;
    console.log(JSON.stringify({ event: "batch-complete", render: activeRender, batch, milliseconds: performance.now() - start }));
    await writeFile(join(root, "measurements-progress.json"), JSON.stringify(measures, null, 2));
    return result;
  } },
};
const raw = Buffer.from([[240,20,40,255], [20,230,80,128], [30,70,240,64]].flatMap(color => Array.from({ length: 32 }, () => color).flat()));
await writeFile(join(assetsRoot, "original.rgba"), raw);
await run([ffmpeg, "-v", "error", "-nostdin", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "8x4", "-framerate", "3", "-i", join(assetsRoot, "original.rgba"), "-frames:v", "3", "-c:v", "qtrle", "-pix_fmt", "argb", "-color_primaries", "bt709", "-color_trc", "iec61966-2-1", "-colorspace", "rgb", join(assetsRoot, "video.mov")]);
await sharp({ create: { width: 64, height: 32, channels: 4, background: { r: 240, g: 160, b: 20, alpha: 0.7 } } }).png().toFile(join(assetsRoot, "image.png"));
await copyFile(join(repositoryRoot, "src/assets/fonts/nebula-sans/NebulaSans-Book.otf"), join(assetsRoot, "font.otf"));
await writeFile(join(assetsRoot, "diagram.json"), JSON.stringify({ version: 1, name: "scene-native-diagram", canvas: { width: 320, height: 180 }, shapes: [{ id: "box", type: "rect", x: 20, y: 20, width: 280, height: 140, label: "Editable scene", icon: "check" }], edges: [] }));
function animatedTriangleGlb(): Buffer {
  const binary = Buffer.alloc(112);
  [-.6,-.6,0,.6,-.6,0,0,.6,0, 0,0,1,0,0,1,0,0,1].forEach((v,i) => binary.writeFloatLE(v,i*4));
  [0,1,2].forEach((v,i) => binary.writeUInt16LE(v,72+i*2));
  [0,1, 0,0,0,.25,0,0].forEach((v,i) => binary.writeFloatLE(v,80+i*4));
  const json = JSON.stringify({ asset:{version:"2.0"}, buffers:[{byteLength:112}], bufferViews:[{buffer:0,byteOffset:0,byteLength:36},{buffer:0,byteOffset:36,byteLength:36},{buffer:0,byteOffset:72,byteLength:6},{buffer:0,byteOffset:80,byteLength:8},{buffer:0,byteOffset:88,byteLength:24}], accessors:[{bufferView:0,componentType:5126,count:3,type:"VEC3",min:[-.6,-.6,0],max:[.6,.6,0]},{bufferView:1,componentType:5126,count:3,type:"VEC3"},{bufferView:2,componentType:5123,count:3,type:"SCALAR"},{bufferView:3,componentType:5126,count:2,type:"SCALAR",min:[0],max:[1]},{bufferView:4,componentType:5126,count:2,type:"VEC3"}], meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1},indices:2}]}], nodes:[{mesh:0}], scenes:[{nodes:[0]}], scene:0, animations:[{samplers:[{input:3,output:4,interpolation:"LINEAR"}],channels:[{sampler:0,target:{node:0,path:"translation"}}]}] });
  const jsonBytes = Buffer.from(json.padEnd(Math.ceil(Buffer.byteLength(json)/4)*4," "));
  const glb = Buffer.alloc(28+jsonBytes.length+binary.length);
  glb.writeUInt32LE(0x46546c67,0);glb.writeUInt32LE(2,4);glb.writeUInt32LE(glb.length,8);glb.writeUInt32LE(jsonBytes.length,12);glb.writeUInt32LE(0x4e4f534a,16);jsonBytes.copy(glb,20);
  glb.writeUInt32LE(binary.length,20+jsonBytes.length);glb.writeUInt32LE(0x004e4942,24+jsonBytes.length);binary.copy(glb,28+jsonBytes.length);return glb;
}
await writeFile(join(assetsRoot, "model.glb"), animatedTriangleGlb());
const assets: SpatialAssetManifest[] = [];
async function asset(assetId: string, path: string, interpretation: SpatialAssetManifest["interpretation"], dependencies: string[] = []) {
  const bytes = await readFile(join(assetsRoot,path));
  assets.push({assetId,payload:{path,sha256:hash(bytes),bytes:bytes.length},interpretation,dependencies,provenance:{source:"authored",description:"Original bounded native qualification fixture; declared OFL font imported from repository."}});
}
await asset("asset_video","video.mov",{kind:"video",width:8,height:4,durationUs:1_000_000,frameRate:{numerator:3,denominator:1},alpha:"straight",colorSpace:"srgb"});
await asset("asset_image","image.png",{kind:"image",width:64,height:32,alpha:"straight",colorSpace:"srgb",mimeType:"image/png"});
await asset("asset_font","font.otf",{kind:"font",format:"otf",family:"Nebula Sans"});
await asset("asset_diagram","diagram.json",{kind:"diagram",schemaVersion:1,theme:"light"},["asset_font"]);
await asset("asset_model","model.glb",{kind:"gltf",format:"glb",metersPerUnit:1,sourceUp:"y"});
const transform = {position:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1]};
const common = {parentId:null,placement:{kind:"world"},origin:{kind:"authored"},visible:true,transform};
const generated = { ...common, entityId:generatedSpatialEntityId("generator_tiles","accent"),name:"Accent",kind:"mesh",origin:{kind:"generated",generatorId:"generator_tiles",key:"accent"},transform:{...transform,position:[1.4,-.7,0]},geometry:{kind:"box",size:[.35,.35,.35]},material:{kind:"unlit",color:"#e35544",opacity:1} };
const camera = {cameraId:"camera_main",name:"Main",pose:{position:[0,0,5],rotation:[0,0,0,1]},projection:{kind:"perspective",width:320,height:180,fx:190,fy:195,cx:160,cy:90,near:.1,far:20}};
const scene = parseSpatialScene({kind:"atet.spatial-scene",schemaVersion:1,sceneId:"scene_qualification",coordinates:"right-handed-y-up-meters",durationUs:1_000_000,assets,entities:[
  {...common,entityId:"entity_video",name:"Video",kind:"video",assetId:"asset_video",width:1.5,height:.75,fit:"stretch",opacity:1,sourceOffsetUs:0,playback:"loop",transform:{...transform,position:[-1.5,.7,0]}},
  {...common,entityId:"entity_image",name:"Image",kind:"image",assetId:"asset_image",width:1.5,height:.75,fit:"contain",opacity:1,transform:{...transform,position:[1.5,.7,0]}},
  {...common,entityId:"entity_diagram",name:"Diagram",kind:"diagram",assetId:"asset_diagram",width:1.5,height:.85,fit:"contain",opacity:1,transform:{...transform,position:[-1.5,-.65,0]}},
  {...common,entityId:"entity_model",name:"Imported animated model",kind:"mesh",geometry:{kind:"asset",assetId:"asset_model",materialMode:"entity",clip:{index:0,offsetUs:0,playback:"loop"}},material:{kind:"unlit",color:"#55aaff",opacity:1}}, generated,
  {...common,entityId:"entity_title",name:"Title",kind:"text",fontAssetId:"asset_font",text:"ATET / DIRECTED SCENE",fontSize:12,width:284,color:"#ffffff",align:"left",placement:{kind:"view",cameraId:"camera_main",units:"pixels",order:10},transform:{...transform,position:[160,155,0]}},
],cameras:[camera,{...camera,cameraId:"camera_second",name:"Second",pose:{...camera.pose,position:[.3,.2,5]}}],animations:[],generators:[{generatorId:"generator_tiles",sourceSha256:hash("qualification retained generator"),closureSha256:hash("no dependencies"),parametersSha256:hash("one accent"),seed:1,outputSha256:spatialGeneratorOutputSha256([generated]),execution:{kind:"attempt",attemptId:"original-qualification",runtimeSha256:hash(Bun.version)},editableKeys:[{key:"accent",properties:["color","transform"]}]}],overrides:[]});
const scenePath = join(assetsRoot,"scene.json");await writeFile(scenePath,JSON.stringify(scene,null,2)+"\n");
const checks: {name:string;passed:true}[] = [];const checked=(name:string,condition:boolean)=>{assert.ok(condition,name);checks.push({name,passed:true});};
const results: Record<string, SpatialRenderResult> = {};const timings: Record<string,number> = {};
const starts: Record<string, number> = {};
async function render(name:string,source:string,request:SpatialRenderRequest,extraAssets?:{assetId:string;artifact:SpatialRenderResult["artifact"]}[],signal = new AbortController().signal) {
  activeRender = name; activeBatch = 0;
  console.log(JSON.stringify({event:"render-start",name,root}));const start=performance.now();
  starts[name] = start;
  const input=await bindSpatialRenderInput(application,{source:{path:relative(repositoryRoot,source)},request,...(extraAssets===undefined?{}:{assets:extraAssets})});
  const workspaceDirectory=join(application.paths.privateRoot,name);await mkdir(workspaceDirectory,{recursive:true,mode:0o700});
  const identity={nodeKey:name,nodePlanSha256:hash(name),runId:"qualification",kind:"scene.render" as const,version:1,inputSchemaId:"atet.operation.scene.render.input/v1",outputSchemaId:"atet.operation.scene.render.output/v1"};
  const output=await executeSpatialRender({application,abortSignal:signal,workflow:{...identity,workspaceDirectory,beforePublication:async()=>undefined}},input);
  await recoverSpatialRenderOutput(application,input,output,identity,new AbortController().signal);
  results[name]=output;timings[name]=performance.now()-start;
  await writeFile(join(root,"checkpoint.json"),JSON.stringify({results,timings,starts,measures},null,2));
  console.log(JSON.stringify({event:"render-complete",name,wallMs:timings[name],artifact:output.artifact}));return output;
}
const contact:SpatialRenderRequest={cameraId:"camera_main",mode:{kind:"beauty"},selection:{kind:"contact-sheet",timesUs:[0,700_000,0],columns:3,cellWidth:320,cellHeight:180,fit:"contain"}};
const rationalRequest: SpatialRenderRequest = {cameraId:"camera_main",overrides:[],mode:{kind:"beauty"},selection:{kind:"video",range:{startUs:0,endUs:200_200},frameRate:{numerator:30_000,denominator:1_001},clock:{kind:"shot",sceneStartUs:0,playback:"once"}}};
if (referenceProfile) {
  await qualifyReference();
} else if (shotProfile) {
  const rational = await render("rational",scenePath,rationalRequest);
  checked("Genuine explicit shot clock retains six exact rational frames",rational.render.frameCount===6&&rational.render.encodedEvidence?.endPts==="6006");
  const alphaFramePath=join(root,"shot-alpha.png");
  await run([ffmpeg,"-v","error","-nostdin","-i",join(repositoryRoot,rational.artifact.path),"-frames:v","1",alphaFramePath]);
  const alphaFrame=await sharp(alphaFramePath).ensureAlpha().raw().toBuffer();
  const sourcePixel=[...(await sharp(join(assetsRoot,"image.png")).ensureAlpha().raw().toBuffer()).subarray(0,4)];
  const actualPixel=[...alphaFrame.subarray((63*320+217)*4,(63*320+217)*4+4)];
  checked("Linear working target retains straight source image color and alpha",actualPixel.every((value,index)=>Math.abs(value-sourcePixel[index]!)<=1));
  checked("Transparent scene background remains canonical no-hit RGBA zero",[...alphaFrame.subarray((10*320+10)*4,(10*320+10)*4+4)].every(value=>value===0));
  const report={kind:"atet.spatial-shot-qualification",schemaVersion:1,checks,results,timings,capabilities,commands,alphaControl:{sourcePixel,actualPixel,framePath:alphaFramePath}};
  await writeFile(join(root,"shot-report.json"),JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify({passed:true,checks:checks.length,report:join(root,"shot-report.json")},null,2));
  await qualifyMixed();
} else {
  await qualifyMixed();
}
clearInterval(memoryTimer);

async function qualifyMixed() {
const original=await render("original",scenePath,contact);
const receipt=SpatialRenderReceiptSchema.parse(JSON.parse(await readFile(join(repositoryRoot,original.receipt.path),"utf8")));
checked("Repeated absolute sample has identical actual pixels",receipt.samples[0]!.pngSha256===receipt.samples[2]!.pngSha256);
checked("Imported clip and video change the actual rendered image",receipt.samples[0]!.pngSha256!==receipt.samples[1]!.pngSha256);
const edited=applySpatialScenePatch(scene,{kind:"atet.spatial-scene-patch",schemaVersion:1,expectedSceneSha256:spatialSceneSha256(scene),operations:[{kind:"set-override",override:{entityId:generated.entityId,property:"color",value:"#44ee77"}},{kind:"set-camera",camera:{...scene.cameras[0]!,pose:{position:[.2,0,5],rotation:[0,0,0,1]}}}]}).scene;
const editedPath=join(assetsRoot,"edited.json");await writeFile(editedPath,JSON.stringify(edited));
const changed=await render("edited",editedPath,contact);
checked("Named-part and camera edit visibly changes output",changed.artifact.sha256!==original.artifact.sha256);
checked("Original source bytes retained unchanged",spatialSceneSha256(JSON.parse(await readFile(scenePath,"utf8")))===spatialSceneSha256(scene));
const a=evaluateSpatialScene(scene,{cameraId:"camera_main",timeUs:0}),b=evaluateSpatialScene(scene,{cameraId:"camera_second",timeUs:0});
checked("Two cameras share evaluated world state",a.stateSha256===b.stateSha256&&a.viewSha256!==b.viewSha256);
if(results.rational===undefined)await render("rational",scenePath,rationalRequest);
checked("Actual MOV preserves 30000/1001 cadence",results.rational!.render.encodedEvidence?.frameCount===6&&results.rational!.render.encodedEvidence?.endPts==="6006");
await rename(assetsRoot,`${assetsRoot}.removed`);
const replay=await render("replay",join(repositoryRoot,original.sceneSource.path),contact,original.retainedAssets.map(({assetId,artifact})=>({assetId,artifact})));
checked("Retained closure replays after original directory is unavailable",replay.artifact.sha256===original.artifact.sha256);
const report={kind:"atet.spatial-scene-qualification",schemaVersion:1,checks,results,timings,capabilities,commands,limits:["320x180 original bounded mixed fixture; no general performance claim.","Video-only scene output; existing-project audio/cuts/speed qualification is recorded separately."]};
await writeFile(join(root,"report.json"),JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({passed:true,checks:checks.length,report:join(root,"report.json")},null,2));
}

async function qualifyReference() {
  const colorsA = [[240,20,40,255], [20,230,80,255], [30,70,240,255]];
  const colorsB = [[20,180,240,255], [100,40,240,255], [240,210,20,255]];
  for (const [name, colors] of [["a", colorsA], ["b", colorsB]] as const) {
    const bytes = Buffer.from(colors.flatMap(color => Array.from({ length: 32 }, () => color).flat()));
    await writeFile(join(assetsRoot, `transition-${name}.rgba`), bytes);
    await run([ffmpeg,"-v","error","-nostdin","-f","rawvideo","-pixel_format","rgba","-video_size","8x4","-framerate","3","-i",join(assetsRoot,`transition-${name}.rgba`),"-frames:v","3","-c:v","qtrle","-pix_fmt","argb",join(assetsRoot,`transition-${name}.mov`)]);
    await asset(`asset_transition_${name}`,`transition-${name}.mov`,{kind:"video",width:8,height:4,durationUs:1_000_000,frameRate:{numerator:3,denominator:1},alpha:"opaque",colorSpace:"srgb"});
  }
  await sharp({create:{width:64,height:32,channels:4,background:{r:240,g:160,b:20,alpha:1}}}).png().toFile(join(assetsRoot,"graphic-control.png"));
  await asset("asset_graphic_control","graphic-control.png",{kind:"image",width:64,height:32,alpha:"opaque",colorSpace:"srgb",mimeType:"image/png"});
  const reference = parseSpatialScene({ ...scene, sceneId:"scene_reference",durationUs:15_000_000,
    assets:assets.filter(item=>!["asset_transition_a","asset_graphic_control"].includes(item.assetId)),
    cameras:scene.cameras.map(item=>({...item,projection:{...item.projection,width:1920,height:1080,fx:1140,fy:1170,cx:960,cy:540}})),
    entities:[...scene.entities.map(entity=>entity.kind==="text"?{...entity,fontSize:72,width:1704,transform:{...entity.transform,position:[960,930,0]}}:entity),
      {...common,entityId:"entity_video_b",name:"Second original video fade",kind:"video",assetId:"asset_transition_b",width:1.5,height:.75,fit:"stretch",opacity:0,sourceOffsetUs:0,playback:"loop",transform:{...transform,position:[-1.5,.7,.01]}},
      {...common,entityId:"entity_background",name:"Unlit SDR background",kind:"mesh",geometry:{kind:"plane",width:100,height:100},material:{kind:"unlit",color:"#111827",opacity:1},transform:{...transform,position:[0,0,-1]}},
    ],
    animations:[{channelId:"channel_transition",targetId:"entity_video_b",property:"opacity",interpolation:"linear",keys:[{timeUs:0,value:0},{timeUs:7_500_000,value:1},{timeUs:15_000_000,value:0}]}],
    overrides:[{entityId:generated.entityId,property:"color",value:"#44ee77"}],
  });
  const referencePath=join(assetsRoot,"reference.json");await writeFile(referencePath,JSON.stringify(reference,null,2)+"\n");
  const evaluationStart=performance.now();for(let index=0;index<450;index++)evaluateSpatialScene(reference,{cameraId:"camera_main",timeUs:Math.round(index*1_000_000/30)});
  const evaluatedMilliseconds=performance.now()-evaluationStart;
  const full=await render("reference-1080p",referencePath,{cameraId:"camera_main",mode:{kind:"beauty"},selection:{kind:"video",range:{startUs:0,endUs:15_000_000},frameRate:{numerator:30,denominator:1}}});
  checked("Reference profile rendered all450 actual1920x1080 frames",full.render.frameCount===450&&full.render.width===1920&&full.render.height===1080&&full.render.encodedEvidence?.endPts==="450");
  const fullReceipt=SpatialRenderReceiptSchema.parse(JSON.parse(await readFile(join(repositoryRoot,full.receipt.path),"utf8")));
  await run([ffmpeg,"-v","error","-nostdin","-i",join(repositoryRoot,full.artifact.path),"-vf","select=eq(n\\,0)+eq(n\\,225)+eq(n\\,449)","-fps_mode","passthrough","-frames:v","3",join(root,"reference-selected-%02d.png")]);
  const preview=parseSpatialScene({...reference,sceneId:"scene_preview",cameras:reference.cameras.map(item=>({...item,projection:{...item.projection,width:960,height:540,fx:570,fy:585,cx:480,cy:270}})),
    entities:reference.entities.map(entity=>entity.kind==="text"?{...entity,fontSize:36,width:852,transform:{...entity.transform,position:[480,465,0]}}:entity)});
  const previewPath=join(assetsRoot,"preview.json");await writeFile(previewPath,JSON.stringify(preview));
  await render("warm-preview",previewPath,{cameraId:"camera_main",mode:{kind:"beauty"},selection:{kind:"frame",timeUs:5_333_333}});
  await render("warm-contact",previewPath,{cameraId:"camera_main",mode:{kind:"beauty"},selection:{kind:"contact-sheet",timesUs:Array.from({length:12},(_,index)=>index*1_250_000),columns:4,cellWidth:480,cellHeight:270,fit:"contain"}});
  const view = (order:number) => ({kind:"view" as const,cameraId:"camera_main",units:"pixels" as const,order});
  const control = parseSpatialScene({kind:"atet.spatial-scene",schemaVersion:1,sceneId:"scene_graphic_control",coordinates:"right-handed-y-up-meters",durationUs:1_500_000,
    cameras:[preview.cameras[0]!],assets:assets.filter(item=>["asset_transition_a","asset_transition_b","asset_graphic_control","asset_font"].includes(item.assetId)),generators:[],overrides:[],
    entities:[
      {...common,entityId:"entity_background",name:"Graphic background",kind:"mesh",geometry:{kind:"plane",width:960,height:540},material:{kind:"unlit",color:"#182030",opacity:1},placement:view(0),transform:{...transform,position:[480,270,0]}},
      {...common,entityId:"entity_bitmap",name:"Opaque 2D color control",kind:"image",assetId:"asset_graphic_control",width:160,height:80,fit:"stretch",opacity:1,placement:view(2),transform:{...transform,position:[150,200,0]}},
      {...common,entityId:"entity_title",name:"Legibility control",kind:"text",fontAssetId:"asset_font",text:"TYPE / 2D / VIDEO",fontSize:40,width:840,color:"#ffffff",align:"left",placement:view(10),transform:{...transform,position:[480,80,0]}},
      ...(["a","b"] as const).map((name,index)=>({...common,entityId:`entity_transition_${name}`,name:`Original video ${name.toUpperCase()}`,kind:"video",assetId:`asset_transition_${name}`,width:480,height:240,fit:"stretch",opacity:1,sourceOffsetUs:0,playback:"freeze",placement:view(3+index),transform:{...transform,position:[520,345,0]}})),
    ],animations:[{channelId:"channel_fade",targetId:"entity_transition_b",property:"opacity",interpolation:"linear",keys:[{timeUs:0,value:0},{timeUs:1_000_000,value:1}]}],
  });
  const controlPath=join(assetsRoot,"control.json");await writeFile(controlPath,JSON.stringify(control,null,2)+"\n");
  const graphic=await render("graphic-control",controlPath,{cameraId:"camera_main",mode:{kind:"beauty"},selection:{kind:"contact-sheet",timesUs:[0,500_000,1_000_000],columns:3,cellWidth:960,cellHeight:540,fit:"contain"}});
  const graphicReceipt=SpatialRenderReceiptSchema.parse(JSON.parse(await readFile(join(repositoryRoot,graphic.receipt.path),"utf8")));
  const rgba=await sharp(join(repositoryRoot,graphic.artifact.path)).ensureAlpha().raw().toBuffer();
  const pixel=(tile:number,x:number,y:number)=>[...rgba.subarray(((y*2880+tile*960+x)*4),((y*2880+tile*960+x)*4)+4)];
  const linear=(byte:number)=>{const value=byte/255;return value<=.04045?value/12.92:((value+.055)/1.055)**2.4;};
  const srgb=(value:number)=>Math.round(255*(value<=.0031308?12.92*value:1.055*value**(1/2.4)-.055));
  const expected=[colorsA[0]!,[...colorsA[1]!.slice(0,3).map((value,index)=>srgb((linear(value)+linear(colorsB[1]![index]!))/2)),255],colorsB[2]!];
  const observedPixels=[];
  for(let tile=0;tile<3;tile++){
    checked(`2D opaque graphic source color survives tile${tile}`,pixel(tile,150,200).every((value,index)=>value===[240,160,20,255][index]));
    const seen=pixel(tile,520,345);observedPixels.push({tile,actual:seen,expected:expected[tile]});
    checked(`Two-video opacity transition matches source frame and linear blend at tile${tile}`,seen.every((value,index)=>Math.abs(value-expected[tile]![index]!)<=2));
  }
  let whitePixels=0;for(let y=45;y<115;y++)for(let x=50;x<910;x++){const value=pixel(0,x,y);if(value[0]!>240&&value[1]!>240&&value[2]!>240)whitePixels++;}
  checked("Declared-font title contains a legible-size high-contrast glyph region",whitePixels>1500);
  const assetEvidence: {kind:string;entityId:string;timeUs:number|null;sourceFrameIndex?:number;sourcePts?:number;sourceExactTimeUs?:unknown}[]=[];
  for(const batch of graphicReceipt.batches){
    const metadata=JSON.parse(await readFile(join(repositoryRoot,batch.path),"utf8")) as {preparedAssets:{kind:string;entityId:string;timeUs:number|null;sourceFrameIndex?:number;sourcePts?:number;sourceExactTimeUs?:unknown}[]};
    assetEvidence.push(...metadata.preparedAssets.filter(item=>item.entityId.startsWith("entity_transition_")));
  }
  checked("Both transition videos retain exact0/1/2 source-frame evidence",["a","b"].every(name=>[0,500_000,1_000_000].every((time,index)=>assetEvidence.some(item=>item.entityId===`entity_transition_${name}`&&item.timeUs===time&&item.sourceFrameIndex===index))));
  let cancellationSettlementMs:number|undefined;
  cancellation={controller:new AbortController()};
  try { await render("cancellation",previewPath,{cameraId:"camera_main",mode:{kind:"beauty"},selection:{kind:"video",range:{startUs:0,endUs:1_000_000},frameRate:{numerator:30,denominator:1}}},undefined,cancellation.controller.signal);throw new Error("Cancellation unexpectedly returned a completed artifact"); }
  catch(error){assert.ok(cancellation.controller.signal.aborted&&cancellation.requestedAt!==undefined,String(error));cancellationSettlementMs=performance.now()-cancellation.requestedAt;checked("Actual in-flight cancellation settles browser ownership",activeBrowsers===0);}
  cancellation=undefined;
  const stats=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return{count:values.length,p50:sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*.5)-1)]??null,p95:sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*.95)-1)]??null};};
  const fullFrames=measures.frames.filter(item=>item.render==="reference-1080p"),warm=fullFrames.filter(item=>item.frame>0);
  const encoder=measures.native.filter(item=>item.render==="reference-1080p"&&item.argv.includes("-start_number"));
  async function directoryBytes(path:string):Promise<number>{let size=0;for(const entry of await readdir(path,{withFileTypes:true})){if(entry.isSymbolicLink())continue;const child=join(path,entry.name);size+=entry.isDirectory()?await directoryBytes(child):(await stat(child)).size;}return size;}
  const report={kind:"atet.spatial-reference-qualification",schemaVersion:1,checks,results,timings,capabilities,commands,
    fixture:{durationUs:15_000_000,width:1920,height:1080,frameRate:{numerator:30,denominator:1},frames:450,sceneSha256:spatialSceneSha256(reference),entities:reference.entities.length,assets:reference.assets.map(item=>({assetId:item.assetId,payload:item.payload,interpretation:item.interpretation})),cameras:reference.cameras.length},
    machine:{model:cpus()[0]?.model,logicalCores:cpus().length,totalMemoryBytes:totalmem(),architecture:arch(),kernelRelease:release(),bun:Bun.version,sharp:sharp.versions},
    measurements:{coldPreparationToFirstEvaluationMs:fullFrames[0]!.evaluationStart-starts["reference-1080p"]!,firstFrameEvaluationMs:fullFrames[0]!.evaluationMs,
      warmInPageSeekMs:stats(warm.map(item=>item.evaluationMs)),warmInPageSeekAndPngMs:stats(warm.flatMap(item=>item.completeMs===undefined?[]:[item.completeMs])),
      evaluatedFramesPerSecond:450/(evaluatedMilliseconds/1000),evaluatedMilliseconds,encodedOutputMilliseconds:encoder.reduce((sum,item)=>sum+item.milliseconds,0),
      completeOutputMilliseconds:timings["reference-1080p"],completeOutputFramesPerSecond:450/(timings["reference-1080p"]!/1000),parentPeakRssBytes:measures.parentPeakRssBytes,
      gpuPeakMemoryBytes:null,aggregateChildPeakRssBytes:null,actualPngPayloadBytes:fullReceipt.costs.actualPngBytes,outputBytes:full.artifact.bytes,retainedTaskTreeBytes:await directoryBytes(root),
      cancellationSettlementMs,cache:{libraryNetworkFetches:measures.libraryFetches.length,fullReferenceBrowserLaunches:measures.launches.filter(item=>item.render==="reference-1080p").length,
        videoDecodes:measures.native.filter(item=>item.render==="reference-1080p"&&item.argv.some(value=>value.startsWith("select=eq"))).length,
        behavior:"Approved module bytes cached across batches; source-video frame decode cached within each32-frame preparation batch. Browser runtime snapshots/context and mesh/material objects rebuilt; OS and driver cache warmth not controlled."},
      provisionalTargets:{warm960x540PreviewMs:500,observedWarmPreviewMs:timings["warm-preview"],previewMet:timings["warm-preview"]!<=500,contact12x480x270Ms:10000,observedContactMs:timings["warm-contact"],contactMet:timings["warm-contact"]!<=10000}},
    graphicControl:{observedPixels,whitePixels,assetEvidence,artifact:graphic.artifact},measures,
    limits:["Cold means task-owned approved-module cache and browser snapshot preparation; OS/disk caches and Chrome installation were already warm.","In-page seek excludes durable runtime verification, browser startup and prepared asset decoding; it is not complete preview latency.","GPU memory and aggregate concurrent child RSS unavailable; host time wrapper and parent RSS reported separately.","Title coverage/pixels are automated evidence; saved full-resolution images require human creative review.","Provisional500ms preview and10s contact targets are reported as met/missed, never treated as passed by reducing resolution."]};
  await writeFile(join(root,"report.json"),JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify({passed:true,checks:checks.length,report:join(root,"report.json"),measurements:report.measurements},null,2));
}
