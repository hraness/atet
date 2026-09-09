/** Trusted, deterministic sample authoring; generated media stays under artifacts/. */
import { parseSpatialScene, type SpatialAssetManifest, type SpatialSceneV1 } from "../../../src/spatial-scene/index";

const identity = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const common = { parentId: null, placement: { kind: "world" }, origin: { kind: "authored" }, visible: true };
const cylinderForward = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const floorRotation = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
// Y-up, roll-free camera pose: local -Z points at the target.
const pose = (position: readonly number[], target: readonly number[] = [0, 0, 0]) => {
  const dx=position[0]!-target[0]!,dy=position[1]!-target[1]!,dz=position[2]!-target[2]!;
  const horizontal=Math.hypot(dx,dz);
  if(horizontal<1e-10)throw new Error("Sample camera requires a nonvertical look direction");
  const yaw=Math.atan2(dx,dz)/2,pitch=-Math.atan2(dy,horizontal)/2;
  return {position:[...position],rotation:[Math.cos(yaw)*Math.sin(pitch),Math.sin(yaw)*Math.cos(pitch),-Math.sin(yaw)*Math.sin(pitch),Math.cos(yaw)*Math.cos(pitch)]};
};
const material = (color: string, roughness = .4, metalness = .15) => ({ kind: "standard", color, opacity: 1, roughness, metalness });

export function createCameraProductSample(assets: { font: SpatialAssetManifest; shadow: SpatialAssetManifest; roundedBody: SpatialAssetManifest }, width = 960, height = 540): SpatialSceneV1 {
  const entities: unknown[] = [];
  const mesh = (id: string, name: string, geometry: unknown, position: readonly number[], color: string, options: { rotation?: readonly number[]; scale?: readonly number[]; roughness?: number; metalness?: number } = {}) => {
    entities.push({ ...common, entityId: `entity_${id}`, name, kind: "mesh", geometry,
      transform: { ...identity, position, ...(options.rotation ? { rotation: options.rotation } : {}), ...(options.scale ? { scale: options.scale } : {}) },
      material: material(color, options.roughness, options.metalness) });
  };
  const box = (id: string, size: number[], at: number[], color: string, roughness = .4) => {
    const rounded=["body","grip","top_plate","bottom_plate","viewfinder"].includes(id);
    mesh(id,id.replaceAll("_"," "),rounded?{kind:"asset",assetId:assets.roundedBody.assetId,materialMode:"entity"}:{kind:"box",size},at,color,{roughness,...(rounded?{scale:size}:{})});
  };
  const lens = (id: string, radius: number, depth: number, z: number, color: string, roughness = .3, metalness = .5) => mesh(id, id.replaceAll("_", " "), {kind:"cylinder",radius,height:depth}, [0,0,z], color, {rotation:cylinderForward,roughness,metalness});
  box("body", [2.7,1.55,.75], [0,0,0], "#bdc2ba", .32);
  box("grip", [.61,1.39,.15], [.97,-.02,.45], "#282d2c", .9);
  box("top_plate", [2.7,.14,.77], [0,.81,0], "#d2d6ce", .25);
  box("bottom_plate", [2.7,.11,.77], [0,-.80,0], "#8e968c", .3);
  box("viewfinder", [.52,.30,.14], [-.88,.36,.46], "#172526", .2);
  box("viewfinder_glass", [.40,.19,.03], [-.88,.36,.55], "#28525a", .1);
  mesh("control_dial", "Exposure dial", {kind:"cylinder",radius:.27,height:.16}, [.86,.94,0], "#323938", {roughness:.25,metalness:.7});
  mesh("shutter", "Shutter release", {kind:"cylinder",radius:.105,height:.13}, [.42,.96,.10], "#ef7e52", {roughness:.35,metalness:.2});
  lens("mount", .68,.15,.46,"#838d86",.2,.85);
  lens("lens_barrel", .60,.66,.83,"#222927",.6,.25);
  lens("focus_ring", .64,.26,.87,"#39413d",.7,.25);
  lens("front_rim", .62,.11,1.19,"#68766c",.2,.8);
  lens("lens_gasket", .56,.025,1.256,"#121b1a",.5,.1);
  lens("optical_glass", .49,.027,1.28,"#162f3a",.08,.55);
  lens("inner_glass", .30,.028,1.297,"#16302c",.13,.4);
  lens("aperture", .135,.029,1.314,"#071616",.8,0);
  for (let i=0;i<64;i++) {
    const a=i*Math.PI/32;
    mesh(`focus_rib_${i}`,`Focus ring rib ${i+1}`,{kind:"box",size:[.023,.032,.25]},[Math.sin(a)*.642,Math.cos(a)*.642,.87],"#58635a",{rotation:[0,0,-Math.sin(a/2),Math.cos(a/2)],roughness:.55,metalness:.35});
  }
  for (let i=0;i<9;i++) box(`grip_rib_${i}`,[.49,.023,.034],[.97,-.53+i*.13,.544],"#474e48",.95);
  for (const x of [-1.19,1.19]) for (const y of [-.64,.64]) mesh(`screw_${x<0?'l':'r'}_${y<0?'b':'t'}`,"Body fastener",{kind:"cylinder",radius:.032,height:.015},[x,y,.386],"#5f6961",{rotation:cylinderForward,metalness:.9});
  mesh("floor","Floor",{kind:"plane",width:200,height:200},[0,-.87,0],"#ddd9d0",{rotation:floorRotation,roughness:1,metalness:0});
  entities.push({...common,entityId:"entity_backdrop",name:"Backdrop",kind:"mesh",geometry:{kind:"plane",width:300,height:200},material:{kind:"unlit",color:"#c1bbae",opacity:1},transform:{...identity,position:[0,0,-25]}});
  entities.push({...common,entityId:"entity_shadow",name:"Authored contact shadow",kind:"image",assetId:assets.shadow.assetId,width:4.4,height:3.0,fit:"stretch",opacity:.4,transform:{...identity,position:[0,-.864,.25],rotation:floorRotation}});
  const light=(id:string,kind:string,color:string,intensity:number,at:number[])=>entities.push({...common,entityId:`entity_${id}`,name:id,kind:"light",light:kind,color,intensity,transform:{...identity,...(kind==="directional"?pose(at,[0,0,.3]):{position:at})}});
  light("ambient","ambient","#e1e9ef",.75,[0,0,0]);
  light("key","directional","#fff0dc",2.7,[-3,4,5]);
  light("rim","directional","#d2e8f0",1.6,[3,1,-4]);
  light("fill","point","#f8e6c5",12,[3,1,3]);
  const text=(id:string,value:string,size:number,x:number,y:number,color:string)=>entities.push({...common,entityId:`entity_${id}`,name:id,kind:"text",fontAssetId:assets.font.assetId,text:value,fontSize:size,width:width-90,color,align:"left",placement:{kind:"view",cameraId:"camera_product",units:"pixels",order:10},transform:{...identity,position:[x+(width-90)/2,y,0]}});
  text("wordmark","FIELD / 01",18,46,42,"#303b35");
  text("caption","A camera study",12,46,height-35,"#586159");
  text("detail","RETAINED GEOMETRY  ·  DIRECTED CAMERA",9,width*.59,height-34,"#697267");
  const camera={cameraId:"camera_product",name:"Product dolly",pose:pose([3.7,1.85,6],[0,.04,.3]),projection:{kind:"perspective",width,height,fx:width*.88,fy:width*.88,cx:width/2,cy:height/2,near:.05,far:200}};
  const times=[0,1_000_000,2_000_000,3_000_000,4_000_000];
  const poses=times.map(t=>{const u=t/4_000_000,s=u*u*(3-2*u),a=.53-.34*s;return pose([Math.sin(a)*7,1.6-.25*s,Math.cos(a)*7],[0,.03,.3]);});
  return parseSpatialScene({kind:"atet.spatial-scene",schemaVersion:1,sceneId:"scene_camera_product",coordinates:"right-handed-y-up-meters",durationUs:4_000_000,entities,cameras:[camera],assets:Object.values(assets),generators:[],overrides:[],animations:[
    {channelId:"channel_camera_position",targetId:camera.cameraId,property:"position",interpolation:"linear",keys:times.map((timeUs,i)=>({timeUs,value:poses[i]!.position}))},
    {channelId:"channel_camera_rotation",targetId:camera.cameraId,property:"rotation",interpolation:"slerp",keys:times.map((timeUs,i)=>({timeUs,value:poses[i]!.rotation}))},
  ]});
}

export const cameraContactShadowSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><defs><radialGradient id="s"><stop offset="0" stop-color="#1d211b" stop-opacity=".9"/><stop offset=".35" stop-color="#1d211b" stop-opacity=".5"/><stop offset="1" stop-color="#1d211b" stop-opacity="0"/></radialGradient></defs><rect width="512" height="512" fill="url(#s)"/></svg>`;

/** A real rendered clip, still and editable diagram share one directed scene. */
export function createSpatialStoryboardSample(assets: { video: SpatialAssetManifest; still: SpatialAssetManifest; diagram: SpatialAssetManifest; font: SpatialAssetManifest }): SpatialSceneV1 {
  const width=960,height=540,cameraId="camera_storyboard";
  const surface=(id:string,kind:"video"|"image"|"diagram",asset:SpatialAssetManifest,position:number[],opacity=1)=>({
    ...common,entityId:`entity_${id}`,name:id,kind,assetId:asset.assetId,width:6.4,height:3.6,fit:"contain",opacity,
    transform:{...identity,position},...(kind==="video"?{sourceOffsetUs:0,playback:"loop"}:{}) });
  const text=(id:string,value:string,size:number,x:number,y:number,color:string)=>({
    ...common,entityId:`entity_${id}`,name:id,kind:"text",fontAssetId:assets.font.assetId,text:value,fontSize:size,width:850,color,align:"left",
    placement:{kind:"view",cameraId,units:"pixels",order:10},transform:{...identity,position:[x+425,y,0]} });
  const animation=(id:string,property:string,interpolation:string,keys:{timeUs:number;value:unknown}[])=>({channelId:`channel_${id}_${property}`,targetId:`entity_${id}`,property,interpolation,keys});
  const transition=(before:unknown,after:unknown)=>[0,1_700_000,2_000_000,2_400_000,2_800_000,3_100_000,6_000_000].map(timeUs=>{
    const u=Math.max(0,Math.min(1,(timeUs-1_700_000)/1_400_000)),s=u*u*(3-2*u);
    const value=Array.isArray(before)&&Array.isArray(after)?before.map((v:number,i:number)=>v+(after[i]-v)*s):Number(before)+(Number(after)-Number(before))*s;
    return{timeUs,value};
  });
  return parseSpatialScene({kind:"atet.spatial-scene",schemaVersion:1,sceneId:"scene_spatial_storyboard",coordinates:"right-handed-y-up-meters",durationUs:6_000_000,
    assets:Object.values(assets),generators:[],overrides:[],
    cameras:[{cameraId,name:"Presentation camera",pose:pose([0,.2,9],[0,0,0]),projection:{kind:"perspective",width,height,fx:850,fy:850,cx:480,cy:270,near:.05,far:100}}],
    entities:[
      {...common,entityId:"entity_backdrop",name:"Warm paper backdrop",kind:"mesh",geometry:{kind:"plane",width:60,height:40},material:{kind:"unlit",color:"#ece8df",opacity:1},transform:{...identity,position:[0,0,-10]}},
      surface("video","video",assets.video,[0,0,0]),
      surface("still","image",assets.still,[-5,-2,-3],0),
      surface("diagram","diagram",assets.diagram,[7,0,-3],0),
      text("title","FROM SCENE TO STORY",18,46,42,"#344239"),
      text("footer","A rendered film, a still and a diagram. One camera.",12,46,height-34,"#697267"),
    ],animations:[
      animation("video","position","linear",transition([0,0,0],[-3.0,.78,-2])),
      animation("video","scale","linear",transition([1,1,1],[.53,.53,.53])),
      animation("video","rotation","slerp",[{timeUs:0,value:[0,0,0,1]},{timeUs:1_700_000,value:[0,0,0,1]},{timeUs:3_100_000,value:[0,Math.sin(.11),0,Math.cos(.11)]},{timeUs:6_000_000,value:[0,Math.sin(.11),0,Math.cos(.11)]}]),
      animation("still","position","linear",transition([-5,-2,-3],[-2.95,-1.3,-2.1])),
      animation("still","scale","linear",transition([.3,.3,.3],[.53,.53,.53])),
      animation("still","opacity","linear",transition(0,1)),
      animation("diagram","position","linear",transition([7,0,-3],[1.8,0,-.3])),
      animation("diagram","scale","linear",transition([.7,.7,.7],[.72,.72,.72])),
      animation("diagram","opacity","linear",transition(0,1)),
    ]});
}

export const storyboardDiagram = {version:1,name:"retained-creative-scene",canvas:{width:960,height:540},shapes:[
  {id:"scene",type:"rect",x:260,y:50,width:440,height:120,label:"Retained scene"},
  {id:"camera",type:"rect",x:260,y:230,width:440,height:100,label:"Directed camera"},
  {id:"film",type:"rect",x:260,y:390,width:440,height:100,label:"Rendered film"},
],edges:[{id:"scene-camera",from:"scene",to:"camera"},{id:"camera-film",from:"camera",to:"film"}]};
