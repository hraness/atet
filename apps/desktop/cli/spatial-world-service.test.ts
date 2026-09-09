import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { operationApplicationContext } from "../application/operations/test-support";
import type { WorldLabsAttemptSummary, WorldLabsService } from "../application/world-labs-port";
import { parseCliArgs } from "./args";
import { executeSpatialWorldCommand } from "./spatial-world-service";
import { createCliTestRunner } from "./run-cli-test-helper";
import type { CliIo } from "./io";

const runCli = createCliTestRunner(import.meta.url);

const request = { attemptId: "world_test", prompt: "A quiet stone courtyard in morning light", displayName: "Courtyard", quality: "100k" };
const savedImport = {splat:{path:"saved.spz",bytes:100,sha256:"a".repeat(64)},identities:{assetId:"asset_world",entityId:"entity_world",name:"Saved world"},
 normalization:{metersPerUnit:1,sourceUp:"y",sourceHandedness:"right",transform:{position:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1]}},provenance:{kind:"saved",description:"Explicit saved world"}};
test("world CLI requires a separate paid grant and never treats a plan as paid authorization", () => {
  const base=["scene","world","generate","--input","world.json"];
  for(const suffix of [[],["--allow-paid-generation"],["--allow-paid-generation","--budget-id","samples","--maximum-credits","NaN"]]) expect(()=>parseCliArgs([...base,...suffix])).toThrow();
  expect(parseCliArgs([...base,"--allow-paid-generation","--budget-id","samples","--maximum-credits","12500"])).toMatchObject({kind:"spatial-world",action:"generate",maximumCredits:12500,allowPaidGeneration:true});
  expect(()=>parseCliArgs(["scene","world","plan","--input","world.json","--allow-paid-generation"])).toThrow();
  expect(()=>parseCliArgs(["scene","world","recover","world_test"])).toThrow("operation-id");
});

test("canonical world CLI honors injected API and download transports through retention", async () => {
 const root=await realpath(await mkdtemp(join(tmpdir(),"atet-world-cli-transports-")));
 try {
  await writeFile(join(root,"world.json"),JSON.stringify(request));
  const output:string[]=[],errors:string[]=[],calls:string[]=[],downloads:string[]=[];
  const io:CliIo={cwd:()=>root,env:{WORLDLABS_API_KEY:"world-test-secret"},now:()=>new Date(),platform:process.platform,stdout:value=>output.push(value),stderr:value=>errors.push(value)};
  const dependencies={io,paths:operationApplicationContext(root).paths,stateRoot:join(root,"state"),
   fetch:async(input:RequestInfo|URL,init?:RequestInit)=>{
    calls.push(`${init?.method??"GET"} ${String(input)}`);
    expect(new Headers(init?.headers).get("WLT-Api-Key")).toBe("world-test-secret");
    const done=init?.method!=="POST";
    return Response.json({operation_id:"operation_test",done,...(done?{response:{world_id:"world_test",model:"marble-1.1",display_name:"Courtyard",assets:{splats:{spz_urls:{"100k":"https://world-assets.example/world.spz"}},mesh:{collider_mesh_url:"https://world-assets.example/collider.glb"}}}}:{})});
   },
   gatewayMediaDownload:async({url,maximumBytes}:{url:URL;maximumBytes?:number})=>{downloads.push(url.href);expect(maximumBytes).toBe(128*1024*1024);return{data:Uint8Array.of(1,2,3),mediaType:undefined};},
  };
  expect(await runCli(["scene","world","generate","--input","world.json","--allow-paid-generation","--budget-id","samples","--maximum-credits","12500","--json"],dependencies)).toBe(0);
  expect(await runCli(["scene","world","resume","world_test","--json"],dependencies)).toBe(0);
  expect(calls).toEqual(["POST https://api.worldlabs.ai/marble/v1/worlds:generate","GET https://api.worldlabs.ai/marble/v1/operations/operation_test"]);
  expect(downloads).toEqual(["https://world-assets.example/world.spz","https://world-assets.example/collider.glb"]);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({status:"retained",reservedCredits:1580});
  expect(errors).toEqual([]);expect(output.join("")).not.toContain("world-test-secret");
  const controller=new AbortController();controller.abort();
  expect(await runCli(["scene","world","generate","--input","world.json","--allow-paid-generation","--budget-id","samples","--maximum-credits","12500","--json"],{...dependencies,abortSignal:controller.signal})).toBe(11);
  expect(calls).toHaveLength(2);
 } finally {await rm(root,{recursive:true,force:true});}
});

test("world CLI plans offline and resume dispatches only one provider read", async () => {
 const root=await mkdtemp(join(tmpdir(),"atet-world-cli-"));
 try {
  await writeFile(join(root,"world.json"),JSON.stringify(request));
  const application=operationApplicationContext(root),calls:string[]=[];
  const pending:WorldLabsAttemptSummary={kind:"atet.world-labs-attempt",schemaVersion:1,attemptId:"world_test",requestSha256:"a".repeat(64),model:"marble-1.1",quality:"100k",status:"pending",reservedCredits:1580,operationId:"operation_test"};
  const service:WorldLabsService={plan(){throw new Error("plan must be pure");},async generate(){calls.push("generate");throw new Error("unexpected paid dispatch");},async resume(){calls.push("resume");return pending;},async inspect(){calls.push("inspect");return pending;},async recover(){calls.push("recover");return pending;}};
  const planned=await executeSpatialWorldCommand(application,{kind:"spatial-world",action:"plan",input:"world.json",json:true},{environment:{},service});
  expect(planned).toMatchObject({reservedCredits:1580,model:"marble-1.1"});expect(calls).toEqual([]);
  const result=await executeSpatialWorldCommand(application,{kind:"spatial-world",action:"resume",attemptId:"world_test",json:true},{environment:{},service});
  expect(result).toMatchObject({status:"pending",nextCommand:"atet scene world resume world_test --json"});expect(calls).toEqual(["resume"]);
  await writeFile(join(root,"import.json"),JSON.stringify(savedImport));
  await expect(executeSpatialWorldCommand(application,{kind:"spatial-world",action:"import",input:"import.json",sourceRoot:root,outputRoot:"src/private-world",json:true},{environment:{}})).rejects.toThrow("dedicated directory");
 } finally {await rm(root,{recursive:true,force:true});}
});

test("canonical world CLI reports malformed offline plans as invalid input without provider access", async () => {
 const root=await realpath(await mkdtemp(join(tmpdir(),"atet-world-cli-invalid-plan-")));
 try {
  await writeFile(join(root,"world.json"),JSON.stringify({...request,quality:"unsupported"}));
  const errors:string[]=[],output:string[]=[];
  let providerCalls=0;
  const io:CliIo={cwd:()=>root,env:{},now:()=>new Date(),platform:process.platform,stdout:value=>output.push(value),stderr:value=>errors.push(value)};
  const exit=await runCli(["scene","world","plan","--input","world.json","--json"],{
   io,paths:operationApplicationContext(root).paths,stateRoot:join(root,"state"),
   fetch:async()=>{providerCalls++;throw new Error("Offline planning must not access the provider");},
  });
  expect(exit).toBe(7);
  expect(providerCalls).toBe(0);
  expect(errors.join("")+output.join("")).toContain("invalid-data");
  expect(errors.join("")+output.join("")).not.toContain("internal");
 } finally {await rm(root,{recursive:true,force:true});}
});

test("canonical world CLI reports malformed saved imports as invalid input without provider access", async () => {
 const root=await realpath(await mkdtemp(join(tmpdir(),"atet-world-cli-invalid-import-")));
 try {
  const errors:string[]=[],output:string[]=[];
  let providerCalls=0;
  const io:CliIo={cwd:()=>root,env:{},now:()=>new Date(),platform:process.platform,stdout:value=>output.push(value),stderr:value=>errors.push(value)};
  const {normalization:_normalization,...missingNormalization}=savedImport;
  for(const malformed of [missingNormalization,{...savedImport,identities:{...savedImport.identities,colliderAssetId:"asset_collider"}}]){
   await writeFile(join(root,"import.json"),JSON.stringify(malformed));
   const exit=await runCli(["scene","world","import","--input","import.json","--source-root",".","--output-root","artifacts/atet/generated/import-test","--json"],{
    io,paths:operationApplicationContext(root).paths,stateRoot:join(root,"state"),
    fetch:async()=>{providerCalls++;throw new Error("Saved import must not access the provider");},
   });
   expect(exit).toBe(7);
  }
  expect(providerCalls).toBe(0);
  expect(errors.join("")+output.join("")).toContain("invalid-data");
  expect(errors.join("")+output.join("")).not.toContain("internal");
 } finally {await rm(root,{recursive:true,force:true});}
});
