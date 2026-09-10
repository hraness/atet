/** Native creative sample qualification. Run only in the owning browser lane. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { arch, cpus, release } from "node:os";
import sharp from "sharp";
import { parseSpatialScene, applySpatialScenePatch, evaluateSpatialScene, spatialSceneSha256, type SpatialAssetManifest } from "../../../src/spatial-scene/index";
import { spatialSelectionColor } from "../html-overlay/spatial";
import type { ApplicationCapability, ApplicationContext } from "../application/context";
import { bindSpatialRenderInput, executeSpatialRender, recoverSpatialRenderOutput } from "../application/operations/spatial-render";
import { SpatialRenderReceiptSchema, type SpatialRenderRequest } from "../application/spatial-render";
import { PlaywrightHtmlOverlayRenderer } from "../cli/html-overlay-renderer";
import { BunProcessRunner } from "../cli/io";
import { createCameraProductSample, cameraContactShadowSvg, createSpatialStoryboardSample, storyboardDiagram } from "./creative-scenes";
import { cameraBodyGlb } from "./creative-geometry";

const repositoryRoot = await realpath(resolve(import.meta.dir, "../../.."));
const root = join(repositoryRoot,"artifacts","creative-qualification",new Date().toISOString().replaceAll(":","-"));
await mkdir(root,{recursive:true,mode:0o700});
const sourceRoot=join(root,"source"); await mkdir(sourceRoot,{mode:0o700});
const hash=(v:Uint8Array|string)=>createHash("sha256").update(v).digest("hex");
const runner=new BunProcessRunner();
const native:unknown[]=[];
async function command(argv:[string,...string[]]) {
  const started=performance.now();const result=await runner.run(argv,{cwd:root,stdin:"ignore",timeoutMs:120_000,maxOutputBytes:2*1024*1024});
  native.push({argv,...result,milliseconds:performance.now()-started});assert.equal(result.exitCode,0,result.stderr);return result.stdout;
}
const ffmpeg="/opt/homebrew/bin/ffmpeg",ffprobe="/opt/homebrew/bin/ffprobe",browser="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const capabilities:ApplicationCapability[]=[];
for(const [name,path]of [["ffmpeg",ffmpeg],["ffprobe",ffprobe],["html-browser",browser]] as const) capabilities.push({name,command:path,available:true,version:(await command([path,name==="html-browser"?"--version":"-version"])).split("\n")[0]!});
const renderer=new PlaywrightHtmlOverlayRenderer({cacheRoot:join(root,"library-cache"),browserStepTimeoutMs:60_000,frameTimeoutMs:30_000});
const application:ApplicationContext={paths:{repositoryRoot,artifactRoot:join(root,"recordings"),privateRoot:join(root,"private"),projectRoot:join(root,"projects"),desktopRoot:join(repositoryRoot,"apps","desktop")},clock:{now:()=>new Date(),timestampMilliseconds:Date.now},runner,capabilities:async()=>capabilities,capability:async name=>capabilities.find(x=>x.name===name)??{name,available:false},htmlOverlayRenderer:renderer};
const results:Record<string,unknown>={};
async function render(name:string,sourcePath:string,request:SpatialRenderRequest) {
  console.log(JSON.stringify({event:"render-start",name,root}));const started=performance.now();
  const input=await bindSpatialRenderInput(application,{source:{path:relative(repositoryRoot,sourcePath)},request});
  const workspaceDirectory=join(application.paths.privateRoot,name);await mkdir(workspaceDirectory,{recursive:true,mode:0o700});
  const identity={nodeKey:name,nodePlanSha256:hash(name),runId:"creative-qualification",kind:"scene.render" as const,version:1,inputSchemaId:"slopcamera.operation.scene.render.input/v1",outputSchemaId:"slopcamera.operation.scene.render.output/v1"};
  const output=await executeSpatialRender({application,abortSignal:new AbortController().signal,workflow:{...identity,workspaceDirectory,beforePublication:async()=>undefined}},input);
  await recoverSpatialRenderOutput(application,input,output,identity,new AbortController().signal);
  const receipt=SpatialRenderReceiptSchema.parse(JSON.parse(await readFile(join(repositoryRoot,output.receipt.path),"utf8")));
  const milliseconds=performance.now()-started;results[name]={output,milliseconds,runtime:receipt.runtime};
  await writeFile(join(root,"progress.json"),JSON.stringify({results,native},null,2));
  console.log(JSON.stringify({event:"render-complete",name,milliseconds,artifact:output.artifact,runtime:receipt.runtime}));
  return {output,receipt,milliseconds};
}
await copyFile(join(repositoryRoot,"src/assets/fonts/nebula-sans/NebulaSans-Book.otf"),join(sourceRoot,"font.otf"));
await sharp(Buffer.from(cameraContactShadowSvg)).png().toFile(join(sourceRoot,"shadow.png"));
async function asset(assetId:string,path:string,interpretation:SpatialAssetManifest["interpretation"]):Promise<SpatialAssetManifest>{const bytes=await readFile(join(sourceRoot,path));return{assetId,payload:{path,bytes:bytes.length,sha256:hash(bytes)},interpretation,dependencies:[],provenance:{source:"authored",description:"SLOPCAMERA authored creative sample"}};}
const font=await asset("asset_font","font.otf",{kind:"font",format:"otf",family:"Nebula Sans"});
const shadow=await asset("asset_shadow","shadow.png",{kind:"image",width:512,height:512,colorSpace:"srgb",alpha:"straight",mimeType:"image/png"});
await writeFile(join(sourceRoot,"rounded-body.glb"),cameraBodyGlb());
const roundedBody=await asset("asset_rounded_body","rounded-body.glb",{kind:"gltf",format:"glb",metersPerUnit:1,sourceUp:"y"});
const source=createCameraProductSample({font,shadow,roundedBody});
const scenePath=join(sourceRoot,"camera.scene.json");await writeFile(scenePath,JSON.stringify(source,null,2)+"\n");
const request:SpatialRenderRequest={executionProfile:"three-webgl2-hardware-v1",cameraId:"camera_product",mode:{kind:"beauty"},selection:{kind:"contact-sheet",timesUs:[0,2_000_000,3_999_999],columns:3,cellWidth:640,cellHeight:360,fit:"contain"}};
const contact=await render("product-contact",scenePath,request);
const first=await render("product-hero",scenePath,{...request,selection:{kind:"frame",timeUs:2_000_000}});
const {executionProfile:_hardware,...software}=request;
const control=await render("product-software-control",scenePath,{...software,selection:{kind:"frame",timeUs:2_000_000}});
const actualPixels=await sharp(join(repositoryRoot,first.output.artifact.path)).ensureAlpha().raw().toBuffer();
const controlPixels=await sharp(join(repositoryRoot,control.output.artifact.path)).ensureAlpha().raw().toBuffer();
assert.equal(actualPixels.length,controlPixels.length);let absoluteError=0,changed=0,maximumError=0;
for(let i=0;i<actualPixels.length;i++){const difference=Math.abs(actualPixels[i]!-controlPixels[i]!);absoluteError+=difference;if(difference>2)changed++;maximumError=Math.max(maximumError,difference);}
const comparison={meanAbsoluteChannelError:absoluteError/actualPixels.length,channelsBeyondTwoLevels:changed/actualPixels.length,maximumChannelError:maximumError,
  singleObservedOperationRatio:control.milliseconds/first.milliseconds,
  timingScope:{repetitions:1,order:["hardware contact","hardware frame","software frame"],libraryCache:"Shared initially empty directory; frame runs reuse the contact's downloaded modules",browserState:"Fresh isolated process per render; browser/runtime caches may be warm",claim:"Observed end-to-end ratio only; not a GPU throughput benchmark"}};
// Cross-device raster edges may differ; this is a declared visual tolerance, not byte equality.
assert.ok(comparison.meanAbsoluteChannelError<1.5&&comparison.channelsBeyondTwoLevels<.015,"hardware raster differs beyond declared preview fidelity tolerance");
const variant=applySpatialScenePatch(source,{kind:"slopcamera.spatial-scene-patch",schemaVersion:1,expectedSceneSha256:spatialSceneSha256(source),operations:[{kind:"set-color",entityId:"entity_body",color:"#ca7453"},{kind:"set-color",entityId:"entity_top_plate",color:"#dfa684"}]}).scene;
const variantPath=join(sourceRoot,"camera-terracotta.scene.json");await writeFile(variantPath,JSON.stringify(variant,null,2)+"\n");
const variation=await render("product-variant",variantPath,{...request,selection:{kind:"frame",timeUs:2_000_000}});
assert.notEqual(variation.output.artifact.sha256,first.output.artifact.sha256);
assert.equal(spatialSceneSha256(parseSpatialScene(JSON.parse(await readFile(scenePath,"utf8")))),spatialSceneSha256(source));
const selection=await render("product-selection",scenePath,{...request,mode:{kind:"object-id",coverage:{kind:"alpha-threshold",threshold:.5}},selection:{kind:"frame",timeUs:2_000_000}});
const selectionPixels=await sharp(join(repositoryRoot,selection.output.artifact.path)).ensureAlpha().raw().toBuffer();
const variantPixels=await sharp(join(repositoryRoot,variation.output.artifact.path)).ensureAlpha().raw().toBuffer();
const body=evaluateSpatialScene(source,{cameraId:request.cameraId,timeUs:2_000_000}).entities.find(item=>item.entity.entityId==="entity_body")!;
const bodyColor=spatialSelectionColor(body.selectionId);
let bodyPixels=0,redGreenShift=0;
for(let i=0;i<selectionPixels.length;i+=4)if(bodyColor.every((c,j)=>selectionPixels[i+j]===c)&&selectionPixels[i+3]===255){
 bodyPixels++;redGreenShift+=(variantPixels[i]!-variantPixels[i+1]!)-(actualPixels[i]!-actualPixels[i+1]!);
}
const semanticVariant={bodyPixels,meanRedGreenShift:redGreenShift/bodyPixels};
assert.ok(bodyPixels>1000&&semanticVariant.meanRedGreenShift>15,"Stable body selection must acquire the intended terracotta hue in actual pixels");
const mediaPresence:Record<string,unknown>={};
if(process.argv.includes("--video")||process.argv.includes("--storyboard")){
 const video=await render("product-video",scenePath,{...request,selection:{kind:"video",range:{startUs:0,endUs:4_000_000},frameRate:{numerator:24,denominator:1}}});
 await command([ffmpeg,"-v","error","-nostdin","-i",join(repositoryRoot,video.output.artifact.path),"-an","-c:v","libx264","-crf","18","-pix_fmt","yuv420p","-movflags","+faststart",join(root,"field-camera.mp4")]);
 const probe=JSON.parse(await command([ffprobe,"-v","error","-count_frames","-show_streams","-show_format","-of","json",join(root,"field-camera.mp4")])) as {streams:{codec_type:string;nb_read_frames:string}[]};
 assert.equal(probe.streams.find(x=>x.codec_type==="video")?.nb_read_frames,"96");
 if(process.argv.includes("--storyboard")){
  await copyFile(join(repositoryRoot,video.output.artifact.path),join(sourceRoot,"product.mov"));
  await copyFile(join(repositoryRoot,variation.output.artifact.path),join(sourceRoot,"variant.png"));
  await writeFile(join(sourceRoot,"storyboard.diagram.json"),JSON.stringify(storyboardDiagram)+"\n");
  const videoAsset=await asset("asset_product_film","product.mov",{kind:"video",width:960,height:540,durationUs:4_000_000,frameRate:{numerator:24,denominator:1},alpha:"straight",colorSpace:"srgb"});
  const still=await asset("asset_product_still","variant.png",{kind:"image",width:960,height:540,colorSpace:"srgb",alpha:"straight",mimeType:"image/png"});
  const diagram={...await asset("asset_story_diagram","storyboard.diagram.json",{kind:"diagram",schemaVersion:1,theme:"light"}),dependencies:[font.assetId]};
  const storyboard=createSpatialStoryboardSample({video:videoAsset,still,diagram,font});
  const storyboardPath=join(sourceRoot,"storyboard.scene.json");await writeFile(storyboardPath,JSON.stringify(storyboard,null,2)+"\n");
  const storyboardRequest:SpatialRenderRequest={executionProfile:"three-webgl2-hardware-v1",cameraId:"camera_storyboard",mode:{kind:"beauty"},selection:{kind:"contact-sheet",timesUs:[0,2_400_000,3_100_000,5_999_999],columns:2,cellWidth:640,cellHeight:360,fit:"contain"}};
  const storyboardContact=await render("storyboard-contact",storyboardPath,storyboardRequest);
  assert.notEqual(storyboardContact.receipt.samples[0]!.pngSha256,storyboardContact.receipt.samples[3]!.pngSha256);
  const layout=await render("storyboard-layout",storyboardPath,{...storyboardRequest,selection:{kind:"frame",timeUs:3_100_000}});
  const ids=await render("storyboard-selection",storyboardPath,{...storyboardRequest,mode:{kind:"object-id",coverage:{kind:"alpha-threshold",threshold:.5}},selection:{kind:"frame",timeUs:3_100_000}});
  const layoutPixels=await sharp(join(repositoryRoot,layout.output.artifact.path)).ensureAlpha().raw().toBuffer();
  const idPixels=await sharp(join(repositoryRoot,ids.output.artifact.path)).ensureAlpha().raw().toBuffer();
  const evaluated=evaluateSpatialScene(storyboard,{cameraId:storyboardRequest.cameraId,timeUs:3_100_000});
  for(const entityId of ["entity_video","entity_still","entity_diagram"]){
   const entity=evaluated.entities.find(item=>item.entity.entityId===entityId)!,color=spatialSelectionColor(entity.selectionId);
   let pixels=0,minimum=255,maximum=0;
   for(let i=0;i<idPixels.length;i+=4)if(color.every((c,j)=>idPixels[i+j]===c)&&idPixels[i+3]===255){pixels++;const l=(layoutPixels[i]!+layoutPixels[i+1]!+layoutPixels[i+2]!)/3;minimum=Math.min(minimum,l);maximum=Math.max(maximum,l);}
   mediaPresence[entityId]={pixels,luminanceRange:maximum-minimum};
   assert.ok(pixels>1000&&maximum-minimum>40,`${entityId} must be separately visible with actual media detail after the transition`);
  }
  const storyboardFilm=await render("storyboard-video",storyboardPath,{...storyboardRequest,selection:{kind:"video",range:{startUs:0,endUs:6_000_000},frameRate:{numerator:24,denominator:1}}});
  await command([ffmpeg,"-v","error","-nostdin","-i",join(repositoryRoot,storyboardFilm.output.artifact.path),"-an","-c:v","libx264","-crf","18","-pix_fmt","yuv420p","-movflags","+faststart",join(root,"spatial-storyboard.mp4")]);
  const storyboardProbe=JSON.parse(await command([ffprobe,"-v","error","-count_frames","-show_streams","-of","json",join(root,"spatial-storyboard.mp4")])) as {streams:{codec_type:string;nb_read_frames:string}[]};
  assert.equal(storyboardProbe.streams.find(x=>x.codec_type==="video")?.nb_read_frames,"144");
 }
}
const report={kind:"slopcamera.creative-sample-qualification",schemaVersion:1,host:{arch:arch(),os:release(),cpu:cpus()[0]?.model},capabilities,results,native,comparison,semanticVariant,mediaPresence,creativeReview:"pending-personal-visual-inspection",notes:["Authored camera concept, not a replica of a commercial camera.","Contact shadow is an authored raster element, not a physically computed shadow.","Whole operation timing includes runtime verification, launch, publication and recovery; it is not GPU-only timing."]};
await writeFile(join(root,"report.json"),JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({passed:true,report:join(root,"report.json"),contact:contact.output.artifact.path}));
