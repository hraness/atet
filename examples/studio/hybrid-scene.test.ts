import { expect,test } from "bun:test";
import { evaluateSpatialScene, cameraMathView, projectPoint } from "@hraness/slopcamera/code";
import { createHybridWorldScene, HYBRID_PANEL, HYBRID_PANEL_CAMERA } from "./hybrid-scene";
const bound=(assetId:string,interpretation:unknown)=>({asset:{assetId,payload:{path:`${assetId}.bin`,sha256:"a".repeat(64),bytes:100},interpretation,dependencies:[],provenance:{source:"authored",description:"Pure fixture"}},binding:{assetId,artifact:{path:`retained/${assetId}.bin`,sha256:"a".repeat(64),bytes:100}}});
const fixture=()=>({panel:bound("asset_video",{kind:"video",width:768,height:432,durationUs:4_000_000,frameRate:{numerator:24,denominator:1},colorSpace:"srgb",alpha:"opaque"}),font:bound("asset_font",{kind:"font",format:"otf",family:"Nebula Sans"})});
test("retained assets and calibrated world media remain exact under absolute camera samples",()=>{
 const input=fixture(),before=JSON.stringify(input),first=createHybridWorldScene(input),second=createHybridWorldScene(input);
 expect(second).toEqual(first);expect(JSON.stringify(input)).toBe(before);
 expect(first.bindings).toEqual([input.panel.binding,input.font.binding]);
 const start=evaluateSpatialScene(first.scene,{cameraId:"camera_panel",timeUs:0}),end=evaluateSpatialScene(first.scene,{cameraId:"camera_panel",timeUs:4_000_000});
 expect(start.camera).toEqual(HYBRID_PANEL_CAMERA);expect(end.camera.pose).not.toEqual(start.camera.pose);
 const a=projectPoint(cameraMathView(start.camera),HYBRID_PANEL.center),b=projectPoint(cameraMathView(end.camera),HYBRID_PANEL.center);
 expect(a).toMatchObject({pixel:[360,640]});expect(b).not.toEqual(a);
 expect(start.entities.find(item=>item.entity.entityId==="entity_panel_media")!.entity.placement.kind).toBe("world");
 expect(Object.isFrozen(HYBRID_PANEL_CAMERA.pose.position)).toBe(true);
 expect(evaluateSpatialScene(first.scene,{cameraId:"camera_panel",timeUs:1_000_000}).camera.pose).toEqual(start.camera.pose);
 expect(()=>createHybridWorldScene({...input,durationUs:1})).not.toThrow();
});
test("foreign getters, mismatched bindings and short media reject without invoking source",()=>{
 let invoked=false;const bad={...fixture()};Object.defineProperty(bad,"city",{enumerable:true,get(){invoked=true;throw Error("must not run");}});
 expect(()=>createHybridWorldScene(bad)).toThrow();expect(invoked).toBe(false);
 const input=fixture();input.panel.binding.artifact.sha256="f".repeat(64);expect(()=>createHybridWorldScene(input)).toThrow("exact retained");
 expect(()=>createHybridWorldScene({...fixture(),panel:bound("asset_video",{kind:"video",width:768,height:432,durationUs:1_000_000,frameRate:{numerator:24,denominator:1},colorSpace:"srgb",alpha:"opaque"})})).toThrow("complete authored segment");
});
test("portal motion returns to the exact calibrated native pose and holds the final cut",()=>{
 const {scene}=createHybridWorldScene({...fixture(),motion:"portal-loop"});
 const camera=(timeUs:number)=>evaluateSpatialScene(scene,{cameraId:"camera_panel",timeUs}).camera;
 expect(camera(2_200_000).pose).not.toEqual(HYBRID_PANEL_CAMERA.pose);
 expect(camera(3_800_000)).toEqual(HYBRID_PANEL_CAMERA);
 expect(camera(3_999_999)).toEqual(HYBRID_PANEL_CAMERA);
 expect(camera(0)).toEqual(camera(3_999_999));
});
