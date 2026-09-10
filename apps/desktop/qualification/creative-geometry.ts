/** Original smooth beveled unit box, retained as ordinary GLB triangles. */
export function cameraBodyGlb(): Buffer {
  const positions:number[]=[],normals:number[]=[],indices:number[]=[],radius=.07,core=.5-radius;
  // Extra samples near the edges resolve each bevel without tessellating flat faces.
  const coordinates=[-.5,-.49,-.47,-.45,-core,core,.45,.47,.49,.5];
  for(let axis=0;axis<3;axis++)for(const sign of [-1,1]){
    const u=(axis+1)%3,v=(axis+2)%3;
    const vertex=(a:number,b:number)=>{
      const p=[0,0,0];p[axis]=sign*.5;p[u]=a;p[v]=b;
      const center=p.map(c=>Math.min(core,Math.max(-core,c))),d=p.map((c,i)=>c-center[i]!),length=Math.hypot(...d);
      normals.push(...d.map(c=>c/length));positions.push(...center.map((c,i)=>c+radius*d[i]!/length));
    };
    const base=positions.length/3,stride=coordinates.length;
    for(const a of coordinates)for(const b of coordinates)vertex(a,b);
    for(let i=0;i<stride-1;i++)for(let j=0;j<stride-1;j++){
      const a=base+i*stride+j,b=a+stride,c=b+1,d=a+1;
      indices.push(...(sign===1?[a,b,c,a,c,d]:[a,c,b,a,d,c]));
    }
  }
  const count=positions.length/3,indexOffset=(positions.length+normals.length)*4,binary=Buffer.alloc(indexOffset+indices.length*2);
  [...positions,...normals].forEach((n,i)=>binary.writeFloatLE(n,i*4));
  indices.forEach((n,i)=>binary.writeUInt16LE(n,indexOffset+i*2));
  const json=JSON.stringify({asset:{version:"2.0",generator:"SLOPCAMERA authored rounded camera body"},buffers:[{byteLength:binary.length}],
    bufferViews:[{buffer:0,byteOffset:0,byteLength:positions.length*4},{buffer:0,byteOffset:positions.length*4,byteLength:normals.length*4},{buffer:0,byteOffset:indexOffset,byteLength:indices.length*2}],
    accessors:[{bufferView:0,componentType:5126,count,type:"VEC3",min:[-.5,-.5,-.5],max:[.5,.5,.5]},{bufferView:1,componentType:5126,count,type:"VEC3"},{bufferView:2,componentType:5123,count:indices.length,type:"SCALAR"}],
    meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1},indices:2,mode:4}]}],nodes:[{mesh:0}],scenes:[{nodes:[0]}],scene:0});
  const text=Buffer.from(json.padEnd(Math.ceil(Buffer.byteLength(json)/4)*4," ")),glb=Buffer.alloc(28+text.length+binary.length);
  glb.writeUInt32LE(0x46546c67,0);glb.writeUInt32LE(2,4);glb.writeUInt32LE(glb.length,8);glb.writeUInt32LE(text.length,12);glb.writeUInt32LE(0x4e4f534a,16);text.copy(glb,20);
  glb.writeUInt32LE(binary.length,20+text.length);glb.writeUInt32LE(0x004e4942,24+text.length);binary.copy(glb,28+text.length);return glb;
}
