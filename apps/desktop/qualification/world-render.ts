/** Real saved-world qualification. Asset paths are explicit, never fetched by this script. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import sharp from "sharp";
import { chromium, type Page } from "playwright-core";
import { parseSpatialScene } from "../../../src/spatial-scene/index";
import type { ApplicationCapability, ApplicationContext } from "../application/context";
import { ApplicationError } from "../application/errors";
import { importSavedSpatialWorld } from "../application/spatial-world-import";
import { bindSpatialRenderInput, executeSpatialRender, recoverSpatialRenderOutput } from "../application/operations/spatial-render";
import { SpatialRenderReceiptSchema, type SpatialRenderRequest } from "../application/spatial-render";
import { PlaywrightHtmlOverlayRenderer } from "../cli/html-overlay-renderer";
import { BunProcessRunner } from "../cli/io";
import { createNodeBundleFileSystem } from "../core/storage";

const repositoryRoot=await realpath(resolve(import.meta.dir,"../../.."));
const argv=process.argv.slice(2),sourceFlag=argv.indexOf("--source");
assert.ok(sourceFlag>=0&&argv[sourceFlag+1],"Specify --source <saved.spz>; no implicit download or paid generation occurs.");
const originalPath=await realpath(resolve(argv[sourceFlag+1]!));
const originalIntegrity=await createNodeBundleFileSystem(dirname(originalPath)).inspectFile!(basename(originalPath),128*1024*1024);
const publicWorlds:Readonly<Record<string,{bytes:number;url:string}>>={
 "2dd125682bfb605e5c92b3d432899f0a0667dfb29b7322b39dc714cae0da1121":{bytes:7_234_742,url:"https://wlt-ai-cdn.art/tastier_spz_500/03facf44-511b-42d0-9ddb-9e2a0227e50e_500k.spz"},
 "8afa5454f0365ca80327ade2308fc10b43a44b945371e8d17ee9be9d6d40f136":{bytes:7_658_471,url:"https://wlt-ai-cdn.art/tastier_spz_500/0524c1a1-abf2-4969-ae40-9981ee836536_500k.spz"},
};
const publicWorld=publicWorlds[originalIntegrity.sha256];
assert.ok(publicWorld!==undefined&&publicWorld.bytes===originalIntegrity.bytes,"This qualifier accepts only the two exact retained public World Labs examples; unknown or newly generated assets need their own truthful provenance and qualification.");
const hash=(value:Uint8Array|string)=>createHash("sha256").update(value).digest("hex");
const root=join(repositoryRoot,"artifacts","world-qualification",new Date().toISOString().replaceAll(":","-"));
await mkdir(root,{recursive:true,mode:0o700});const sourceRoot=join(root,"source");await mkdir(sourceRoot,{mode:0o700});
const imported=await importSavedSpatialWorld({sourceRoot:dirname(originalPath),destinationRoot:sourceRoot,signal:new AbortController().signal,input:{
 splat:{path:basename(originalPath),...originalIntegrity},
 identities:{assetId:"asset_world",entityId:"entity_world",name:"Retained World Labs example"},
 normalization:{metersPerUnit:1,sourceUp:"y",sourceHandedness:"right",transform:{position:[0,0,0],rotation:[1,0,0,0],scale:[1,1,1]}},
 provenance:{kind:"saved",description:`Public World Labs/Spark lo-fi example from ${publicWorld.url}. Exact bytes bound in the qualification report. Rotation follows official Spark example. Scale1 is an authoring convention, not measured physical calibration.`},
}});
const camera={cameraId:"camera_world",name:"Directed environment camera",pose:{position:[0,0,0],rotation:[0,0,0,1]},projection:{kind:"perspective",width:960,height:540,fx:625,fy:625,cx:480,cy:270,near:.05,far:200}};
const scene=parseSpatialScene({kind:"slopcamera.spatial-scene",schemaVersion:1,sceneId:"scene_world_sample",coordinates:"right-handed-y-up-meters",durationUs:3_000_000,entities:[imported.entity],assets:imported.assets,cameras:[camera],generators:[],overrides:[],animations:[
 {channelId:"channel_world_camera_position",targetId:camera.cameraId,property:"position",interpolation:"linear",keys:[{timeUs:0,value:[0,0,0]},{timeUs:1_500_000,value:[.08,.015,-.04]},{timeUs:3_000_000,value:[.16,.03,-.08]}]},
 {channelId:"channel_world_camera_rotation",targetId:camera.cameraId,property:"rotation",interpolation:"slerp",keys:[{timeUs:0,value:[0,-Math.sin(.12),0,Math.cos(.12)]},{timeUs:3_000_000,value:[0,Math.sin(.12),0,Math.cos(.12)]}]},
]});
const scenePath=join(sourceRoot,"world.scene.json");await writeFile(scenePath,JSON.stringify(scene,null,2)+"\n");
const {controlledBytes,hybridScene,hybridPath}=await createHybridSource();
if(argv.includes("--preflight")){const report={kind:"slopcamera.saved-world-preflight",source:{...originalIntegrity,url:publicWorld.url},imported,hybridScene,hybridPath,nativeInvocations:0};await writeFile(join(root,"preflight.json"),JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify({passed:true,preflight:join(root,"preflight.json")}));process.exit(0);}
const nativeRunner=new BunProcessRunner();const native:unknown[]=[];
const runner={run:async(...args:Parameters<BunProcessRunner["run"]>)=>{const started=performance.now();const value=await nativeRunner.run(...args);native.push({argv:args[0],...value,milliseconds:performance.now()-started});return value;}};
async function run(argv:[string,...string[]]){const value=await runner.run(argv,{cwd:root,stdin:"ignore",timeoutMs:120_000,maxOutputBytes:2*1024*1024});assert.equal(value.exitCode,0,value.stderr);return value.stdout;}
function failureEvidence(value:unknown,depth=0):unknown{if(depth>6)return"cause-depth-limit";return value instanceof Error?{name:value.name,message:value.message.slice(0,8192),...(value instanceof ApplicationError?{code:value.code,details:value.details}:{}),...(value.cause===undefined?{}:{cause:failureEvidence(value.cause,depth+1)}),...(value instanceof AggregateError?{errors:value.errors.slice(0,16).map(error=>failureEvidence(error,depth+1))}:{})}:String(value).slice(0,8192);}
function assertSettledCancellation(cause:unknown,reason:unknown){
 const seen=new Set<unknown>();let cursor=cause;
 for(let depth=0;depth<16;depth++){
  assert.ok(cursor instanceof Error&&!seen.has(cursor),"Cancellation must retain its bounded exact original cause chain.");seen.add(cursor);
  assert.ok(!(cursor instanceof AggregateError)&&cursor.name!=="HtmlOverlayBrowserCleanupError","Cancellation with cleanup failures is not a passing qualification.");
  if(cursor instanceof ApplicationError){
   const details=cursor.details;assert.ok(cursor.code!=="unavailable"&&cursor.code!=="ambiguous"&&details?.leaseState!=="active","Retained active runtime or uncertain publication is not settled cancellation.");
   assert.ok(!Array.isArray(details?.cleanupErrors)||details.cleanupErrors.length===0,"Cancellation cannot suppress workspace cleanup failures.");
   for(const key of["spatialRender","spatialRenderOperation"]){const evidence=details?.[key];if(evidence!==null&&typeof evidence==="object")assert.ok(!("completion"in evidence)&&!("uncertainPublication"in evidence),"Cancelled render must not carry completed or uncertain output.");}
  }
  if(cursor===reason)return;cursor=cursor.cause;
 }
 throw new Error("Cancellation did not preserve its exact abort reason.");
}
const browser="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",ffmpeg="/opt/homebrew/bin/ffmpeg",ffprobe="/opt/homebrew/bin/ffprobe";
const capabilities:ApplicationCapability[]=[];for(const[name,path]of[["html-browser",browser],["ffmpeg",ffmpeg],["ffprobe",ffprobe]]as const)capabilities.push({name,command:path,available:true,version:(await run([path,name==="html-browser"?"--version":"-version"])).split("\n")[0]!});
let activeBrowsers=0;
let cancellation:{controller:AbortController;stage:"worker-start"|"screenshot";requestedAt?:number;screenshotSha256?:string;workerStarts:number;screenshots:number}|undefined;
function observed<T extends object>(target:T,callbacks:Record<string,(result:unknown)=>unknown>):T{
 return new Proxy(target,{get(object,property){const value:unknown=Reflect.get(object,property,object);if(typeof value!=="function")return value;const callback=typeof property==="string"?callbacks[property]:undefined;return callback===undefined?value.bind(object):async(...args:unknown[])=>callback(await Reflect.apply(value,object,args));}});
}
const rendererOptions={cacheRoot:join(root,"library-cache"),browserStepTimeoutMs:60_000,frameTimeoutMs:30_000,
 launch:async(options:Parameters<typeof chromium.launch>[0])=>{
  const browser=await chromium.launch(options);activeBrowsers++;browser.on("disconnected",()=>{activeBrowsers--;});
  return observed(browser,{newContext:value=>observed(value as object,{newPage:value=>{
   const page=value as Page;
   page.on("worker",()=>{if(cancellation===undefined)return;cancellation.workerStarts++;if(cancellation.stage==="worker-start"&&cancellation.requestedAt===undefined){cancellation.requestedAt=performance.now();cancellation.controller.abort(new Error("World qualification cancellation during actual Spark worker readiness"));}});
   return observed(page,{screenshot:value=>{if(cancellation!==undefined){cancellation.screenshots++;if(cancellation.stage==="screenshot"&&cancellation.requestedAt===undefined){assert.ok(value instanceof Uint8Array);cancellation.screenshotSha256=hash(value);cancellation.requestedAt=performance.now();cancellation.controller.abort(new Error("World qualification cancellation after actual sorted Spark screenshot"));}}return value;}});
  }})});
 }};
class ReverseWorldRenderer extends PlaywrightHtmlOverlayRenderer {
 protected override orderedFrameIndexes(frameCount:number):readonly number[]{assert.equal(frameCount,4);return[3,1,0,2];}
}
const forwardRenderer=new PlaywrightHtmlOverlayRenderer(rendererOptions),reverseRenderer=new ReverseWorldRenderer(rendererOptions);
let reverseFrameOrder=false;
const application:ApplicationContext={paths:{repositoryRoot,artifactRoot:join(root,"recordings"),privateRoot:join(root,"private"),projectRoot:join(root,"projects"),desktopRoot:join(repositoryRoot,"apps","desktop")},clock:{now:()=>new Date(),timestampMilliseconds:Date.now},runner,capabilities:async()=>capabilities,capability:async name=>capabilities.find(x=>x.name===name)??{name,available:false},htmlOverlayRenderer:{renderFrames:async(request,signal)=>await(reverseFrameOrder?reverseRenderer:forwardRenderer).renderFrames(request,signal)}};
const results:Record<string,unknown>={};
async function render(name:string,path:string,request:SpatialRenderRequest,assets?:{assetId:string;artifact:{path:string;sha256:string;bytes:number}}[],signal=new AbortController().signal){
 console.log(JSON.stringify({event:"render-start",name,root}));const started=performance.now();
 const input=await bindSpatialRenderInput(application,{source:{path:relative(repositoryRoot,path)},request,...(assets?{assets}:{})},signal);
 const workspaceDirectory=join(application.paths.privateRoot,name);await mkdir(workspaceDirectory,{recursive:true,mode:0o700});
 const identity={nodeKey:name,nodePlanSha256:hash(name),runId:"world-qualification",kind:"scene.render" as const,version:1,inputSchemaId:"slopcamera.operation.scene.render.input/v1",outputSchemaId:"slopcamera.operation.scene.render.output/v1"};
 const output=await executeSpatialRender({application,abortSignal:signal,workflow:{...identity,workspaceDirectory,beforePublication:async()=>undefined}},input).catch(async error=>{await writeFile(join(root,`${name}.failure.json`),JSON.stringify({failure:failureEvidence(error),native,activeBrowsers},null,2));throw error;});
 await recoverSpatialRenderOutput(application,input,output,identity,new AbortController().signal);
 const receipt=SpatialRenderReceiptSchema.parse(JSON.parse(await readFile(join(repositoryRoot,output.receipt.path),"utf8")));
 results[name]={output,runtime:receipt.runtime,milliseconds:performance.now()-started};await writeFile(join(root,"progress.json"),JSON.stringify({results,native},null,2));
 console.log(JSON.stringify({event:"render-complete",name,artifact:output.artifact}));return{output,receipt};
}
const request:SpatialRenderRequest={executionProfile:"three-spark-webgl2-hardware-v1",cameraId:camera.cameraId,mode:{kind:"beauty"},selection:{kind:"contact-sheet",timesUs:[0,1_500_000,0,2_999_999],columns:2,cellWidth:640,cellHeight:360,fit:"contain"}};
const preview=await render("world-contact",scenePath,request);
assert.equal(preview.receipt.samples[0]!.pngSha256,preview.receipt.samples[2]!.pngSha256,"Repeated camera/time must settle to the same actual pixels");
assert.notEqual(preview.receipt.samples[0]!.pngSha256,preview.receipt.samples[1]!.pngSha256,"Directed camera movement changes actual world pixels");
reverseFrameOrder=true;
const reversed=await render("world-reverse-frame-order",scenePath,request);
reverseFrameOrder=false;
assert.deepEqual(reversed.receipt.samples.map(sample=>sample.pngSha256),preview.receipt.samples.map(sample=>sample.pngSha256),"Reverse transport frame indices settle the same exact camera-dependent sort");
assert.equal(reversed.output.artifact.sha256,preview.output.artifact.sha256);
const hero=await render("world-hero",scenePath,{...request,selection:{kind:"frame",timeUs:1_500_000}});
if(argv.includes("--video")){
 const video=await render("world-video",scenePath,{...request,selection:{kind:"video",range:{startUs:0,endUs:3_000_000},frameRate:{numerator:24,denominator:1}}});
 await run([ffmpeg,"-v","error","-nostdin","-i",join(repositoryRoot,video.output.artifact.path),"-an","-c:v","libx264","-crf","18","-pix_fmt","yuv420p","-movflags","+faststart",join(root,"world-camera.mp4")]);
 const probe=JSON.parse(await run([ffprobe,"-v","error","-count_frames","-show_streams","-show_format","-of","json",join(root,"world-camera.mp4")])) as {streams:{codec_type:string;nb_read_frames:string;r_frame_rate:string;avg_frame_rate:string;duration:string;width:number;height:number;pix_fmt:string}[];format:{duration:string}};
 const stream=probe.streams.find(value=>value.codec_type==="video");assert.ok(stream!==undefined);assert.equal(probe.streams.length,1);
 assert.equal(stream.nb_read_frames,"72");assert.equal(stream.r_frame_rate,"24/1");assert.equal(stream.avg_frame_rate,"24/1");assert.equal(Number(stream.duration),3);assert.equal(Number(probe.format.duration),3);
 assert.equal(stream.width,960);assert.equal(stream.height,540);assert.equal(stream.pix_fmt,"yuv420p");results.videoProbe=probe;
}
// Original, controlled geometry gives a pixel oracle independent of unknown
// public-world geometry. SPZ v2 encodes XYZ as signed24-bit fixedpoint, RGB via
// SH_C0/0.15, opacity as bytes/255, and scales as exp(byte/16-10).
async function createHybridSource(){
const raw=new Uint8Array(16+2*19),header=new DataView(raw.buffer);header.setUint32(0,0x5053474e,true);header.setUint32(4,2,true);header.setUint32(8,2,true);raw[13]=12;
for(const[index,point]of[[0,0,-2],[.75,0,-2]].entries())for(const[axis,value]of point.entries()){const encoded=Math.round(value*4096);for(let byte=0;byte<3;byte++)raw[16+index*9+axis*3+byte]=(encoded>>>(byte*8))&255;}
raw.fill(255,34,36);
const radianceScale=.28209479177387814/.15;
for(const[index,color]of[[1,0,0],[0,0,1]].entries())for(const[channel,value]of color.entries())raw[36+index*3+channel]=Math.round(((value-.5)/radianceScale+.5)*255);
raw.fill(Math.round((Math.log(.08)+10)*16),42,48);raw.fill(128,48,54);
const controlledBytes=gzipSync(raw),controlledPath=join(root,"original-hybrid.spz");await writeFile(controlledPath,controlledBytes);
const hybrid=await importSavedSpatialWorld({sourceRoot:root,destinationRoot:sourceRoot,signal:new AbortController().signal,input:{splat:{path:basename(controlledPath),bytes:controlledBytes.length,sha256:hash(controlledBytes)},identities:{assetId:"asset_hybrid_splat",entityId:"entity_hybrid_splat",name:"Original two-point occlusion control"},normalization:{metersPerUnit:1,sourceUp:"y",sourceHandedness:"right",transform:{position:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1]}},provenance:{kind:"saved",description:"Original mathematically encoded SPZ fixture created by this qualifier; no generated-world or provider claim."}}});
const hybridScene=parseSpatialScene({kind:"slopcamera.spatial-scene",schemaVersion:1,sceneId:"scene_hybrid_control",coordinates:"right-handed-y-up-meters",durationUs:2_000_000,
 entities:[hybrid.entity,{kind:"mesh",entityId:"entity_occluder",name:"Known opaque depth control",parentId:null,origin:{kind:"authored"},placement:{kind:"world"},visible:true,transform:{position:[0,0,-3],rotation:[0,0,0,1],scale:[1,1,1]},geometry:{kind:"plane",width:.5,height:.5},material:{kind:"unlit",color:"#19c75f",opacity:1}}],assets:hybrid.assets,
 cameras:[{...camera,cameraId:"camera_hybrid",projection:{kind:"perspective",width:320,height:240,fx:160,fy:160,cx:160,cy:120,near:.1,far:10}}],generators:[],overrides:[],
 animations:[{channelId:"channel_occluder_position",targetId:"entity_occluder",property:"position",interpolation:"linear",keys:[{timeUs:0,value:[0,0,-3]},{timeUs:1_000_000,value:[0,0,-1]}]}]});
const hybridPath=join(sourceRoot,"hybrid.scene.json");await writeFile(hybridPath,JSON.stringify(hybridScene,null,2)+"\n");
return{controlledBytes,hybridScene,hybridPath};
}
const hybridOutput=await render("hybrid-opaque-occlusion",hybridPath,{...request,cameraId:"camera_hybrid",selection:{kind:"contact-sheet",timesUs:[0,1_000_000],columns:2,cellWidth:320,cellHeight:240,fit:"contain"}});
assert.equal(hybridOutput.receipt.frameArtifacts.length,2);
const [behind,inFront]=await Promise.all(hybridOutput.receipt.frameArtifacts.map(async artifact=>await sharp(join(repositoryRoot,artifact.path)).ensureAlpha().raw().toBuffer()));assert.ok(behind!==undefined&&inFront!==undefined);
const pixel=(bytes:Uint8Array,x:number,y:number)=>[...bytes.subarray((y*320+x)*4,(y*320+x)*4+4)];
const red=pixel(behind,160,120),green=pixel(inFront,160,120),blue=pixel(behind,220,120),blueUnchanged=pixel(inFront,220,120);
assert.ok(red[0]!>180&&red[1]!<60&&red[2]!<60&&red[3]!>240,"Known front red splat must cover the plane behind it.");
assert.ok(green.every((value,index)=>Math.abs(value-[25,199,95,255][index]!)<=2),"Known opaque plane in front must replace the center splat with its exact authored green.");
assert.ok(blue[2]!>180&&blue[0]!<60&&blue[1]!<60&&blue[3]!>240,"Known off-center blue splat must project to its independent calibrated pixel.");
assert.deepEqual(blueUnchanged,blue,"Moving the center occluder must preserve the off-center world splat.");results.hybridOracle={red,green,blue,blueUnchanged,sourceSha256:hash(controlledBytes),projection:hybridScene.cameras[0]!.projection};
for(const stage of["worker-start","screenshot"]as const){
 cancellation={controller:new AbortController(),stage,workerStarts:0,screenshots:0};let rejected=false,cause:unknown;
 try{await render(`world-cancel-${stage}`,scenePath,{...request,selection:{kind:"video",range:{startUs:0,endUs:1_000_000},frameRate:{numerator:24,denominator:1}}},undefined,cancellation.controller.signal);}catch(error){rejected=true;cause=error;}
 assert.ok(rejected&&cancellation.controller.signal.aborted&&cancellation.requestedAt!==undefined,"Cancellation must be requested inside an actual Spark browser and reject completion.");assert.equal(activeBrowsers,0,"Browser protocol connections must close after cancellation; this counter alone does not prove OS process termination.");assert.ok(cancellation.workerStarts>0);
 assertSettledCancellation(cause,cancellation.controller.signal.reason);
 if(stage==="screenshot"){assert.equal(cancellation.screenshots,1);assert.equal(cancellation.screenshotSha256,preview.receipt.samples[0]!.pngSha256,"Cancellation follows the same fully ready/sorted first world frame.");}else assert.equal(cancellation.screenshots,0);
 results[`cancellation-${stage}`]={rejected,workerStarts:cancellation.workerStarts,screenshots:cancellation.screenshots,screenshotSha256:cancellation.screenshotSha256,settlementMs:performance.now()-cancellation.requestedAt,openBrowserConnections:activeBrowsers,connectionEvidence:"Browser disconnected events; OS process termination requires the production shutdown custody proof",cause:failureEvidence(cause)};cancellation=undefined;
 await writeFile(join(root,"progress.json"),JSON.stringify({results,native},null,2));
}
await rename(sourceRoot,`${sourceRoot}.removed`);
const replay=await render("world-retained-replay",join(repositoryRoot,hero.output.sceneSource.path),{...request,selection:{kind:"frame",timeUs:1_500_000}},hero.output.retainedAssets.map(({assetId,artifact})=>({assetId,artifact})));
assert.equal(replay.output.artifact.sha256,hero.output.artifact.sha256,"Saved world and metadata replay after the import directory is absent");
assert.equal(activeBrowsers,0);
const report={kind:"slopcamera.saved-world-qualification",schemaVersion:1,source:{path:originalPath,...originalIntegrity,url:publicWorld.url,catalog:"https://github.com/sparkjsdev/spark/blob/v2.1.0/examples/lofi/worlds.js",cameraBasis:"https://github.com/sparkjsdev/spark/blob/v2.1.0/examples/lofi/index.html",attribution:"World Labs / Spark public example; not generated by this task"},imported,capabilities,native,results,creativeReview:"pending-personal-visual-inspection",limits:["Authoring scale is not measured physical calibration.","Static radiance field; no validated simulation or internal object/material semantics.","Public fixture media is retained only in ignored qualification artifacts and is not packaged."]};
await writeFile(join(root,"report.json"),JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify({passed:true,report:join(root,"report.json")}));
