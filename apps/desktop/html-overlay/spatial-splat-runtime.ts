/** Only the explicit Spark profile receives these additions. The legacy generated document stays byte-identical. */
export function addSpatialSplatRuntime(document: string): string {
  const replace = (source: string, replacement: string) => {
    if (document.split(source).length !== 2) throw new Error("Spatial Spark runtime anchor changed; review the pinned renderer adapter.");
    document = document.replace(source, replacement);
  };
  replace('import * as THREE from "three";', 'import * as THREE from "three";\nimport { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";');
  replace('SlopcameraOverlay.ready(initialization);', `
// Exact offline readback avoids Three's wall-clock fence polling under the
// absolute Slopcamera frame clock. Both APIs bind the same target and MRT attachment.
renderer.readRenderTargetPixelsAsync=async(target,x,y,width,height,buffer,face,attachment)=>{
  const texture=target.textures?.[attachment],gl=renderer.getContext();
  if(attachment!==2||texture?.format!==THREE.RGBAFormat||texture?.type!==THREE.UnsignedByteType||buffer.BYTES_PER_ELEMENT!==1||buffer.byteLength<width*height*4||x<0||y<0||x+width>target.width||y+height>target.height)throw new Error("Spark requested an unqualified MRT readback.");
  if(gl.getError()!==gl.NO_ERROR)throw new Error("Spark GPU failed before readback.");
  renderer.readRenderTargetPixels(target,x,y,width,height,buffer,face,attachment);
  if(gl.getError()!==gl.NO_ERROR||gl.isContextLost())throw new Error("Spark GPU readback failed.");return buffer;
};
const spark=new SparkRenderer({renderer,autoUpdate:false,preUpdate:false,enableLod:false,enableDriveLod:false,enableLodFetching:false,
  maxPagedSplats:65536,numLodFetchers:0,lodRaycast:0,accumExtSplats:true,premultipliedAlpha:true,encodeLinear:true,sortRadial:false,minSortIntervalMs:0,depthTest:true,depthWrite:false,
  preBlurAmount:input.splatKernel.preBlurAmount,blurAmount:input.splatKernel.blurAmount});
spark.readPause=0;spark.sortPause=0;spark.sortDelay=0;
const splatMeshes=new Map();
const disposeSplats=()=>{for(const mesh of splatMeshes.values())mesh.dispose();splatMeshes.clear();spark.dispose();};
const splatInitialization=initialization.then(async()=>{
  const gl=renderer.getContext();
  if(gl.getParameter(gl.MAX_TEXTURE_SIZE)<4096||gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS)<1||gl.getParameter(gl.MAX_DRAW_BUFFERS)<3)throw new Error("Spark GPU allocation capabilities are unavailable.");
  for(const item of input.splats){
    const response=await fetch(item.url);if(!response.ok)throw new Error("Retained SPZ resource is unavailable.");
    const bytes=await response.arrayBuffer();
    if(bytes.byteLength!==item.resource.bytes)throw new Error("Retained SPZ resource length changed.");
    const hash=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes));
    const sha256=Array.from(hash,value=>value.toString(16).padStart(2,"0")).join("");
    if(sha256!==item.resource.sha256)throw new Error("Retained SPZ resource digest changed.");
    const mesh=new SplatMesh({fileBytes:bytes,fileType:"spz",extSplats:true,maxSplats:item.facts.splats,lod:false,enableLod:false,editable:false,raycastable:false});
    splatMeshes.set(item.key,mesh);await mesh.initialized;
    if(disposed)throw new Error("Spatial renderer was disposed during splat preparation.");
    if(mesh.extSplats?.numSplats!==item.facts.splats)throw new Error("Spark decoded a different splat count from the admitted source.");
    mesh.matrixAutoUpdate=false;mesh.frustumCulled=false;
  }
}).catch(error=>{disposeSplats();throw error;});
SlopcameraOverlay.ready(splatInitialization);`);
  replace('SlopcameraOverlay.onFrame(({frame:index})=>{', 'SlopcameraOverlay.onFrame(async({frame:index})=>{');
  replace('camera.updateMatrixWorld(true);return camera;', 'camera.near=data.near;camera.far=data.far;camera.updateMatrixWorld(true);return camera;');
  replace('    for(const object of frame.objects){', `    const hasFrameSplats=frame.objects.some(object=>object.kind==="splat");spark.visible=hasFrameSplats;world.add(spark);
    for(const object of frame.objects){
      if(object.kind==="splat"){
        const mesh=splatMeshes.get(object.key);if(!mesh)throw new Error("Splat frame binding is absent.");
        mesh.matrix.fromArray(object.matrix);world.add(mesh);continue;
      }`);
  replace('    renderer.setRenderTarget(beautyTarget);renderer.clear(true,true,true);renderer.render(world,camera);', `    if(spark.sorting||spark.sortDirty||spark.sortTimeoutId!==-1||spark.updateTimeoutId!==-1)throw new Error("A previous Spark view did not settle.");
    // Explicit offline samples may seek backwards; never apply a wall-clock throttle.
    spark.lastSortTime=0;
    spark.time=frame.timeUs/1000000;spark.renderSize.set(SlopcameraOverlay.width,SlopcameraOverlay.height);
    world.updateMatrixWorld(true);if(hasFrameSplats)await spark.update({scene:world,camera});
    if(spark.sorting||spark.sortDirty||(hasFrameSplats&&spark.display!==spark.current))throw new Error("Spark did not settle the exact directed camera sample.");
    if(contextFailure||disposed)throw contextFailure??new Error("Spatial renderer was disposed while sorting.");
    renderer.setRenderTarget(beautyTarget);renderer.clear(true,true,true);renderer.render(world,camera);`);
  replace('addEventListener("pagehide",()=>{disposed=true;', 'addEventListener("pagehide",()=>{disposeSplats();disposed=true;');
  return document;
}
