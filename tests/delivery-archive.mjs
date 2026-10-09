import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const folder=path.join(project,'work/tests');await mkdir(folder,{recursive:true});
globalThis.__archiveTest={files:new Map()};
const output=path.join(folder,'delivery-archive.cjs');
await build({entryPoints:[path.join(project,'src/delivery-archive.ts')],outfile:output,bundle:true,platform:'node',format:'cjs',logLevel:'silent',plugins:[{name:'offline-files',setup(b){
  b.onResolve({filter:/^fs$/},()=>({path:'fs',namespace:'offline'}));
  b.onLoad({filter:/.*/,namespace:'offline'},()=>({loader:'js',contents:`
    const files=globalThis.__archiveTest.files;
    export function mkdirSync(){}
    export function writeFileSync(p,v){files.set(p,v)}
    export function renameSync(p,q){files.set(q,files.get(p));files.delete(p)}
    export function existsSync(p){return files.has(p)}
    export function unlinkSync(p){files.delete(p)}
    export function readFileSync(p){if(!files.has(p))throw Error('missing');return files.get(p)}
  `}));
}}]});
const {archiveVerifiedDelivery,readArchivedDelivery}=(await import(pathToFileURL(output).href)).default;
const source='推特创作/03创作中/同名.md',dest='推特创作/04已发布/同名.md',markdown='## 正文\n完整**加粗**正文\n%%保留记录%%';
function fixture({collide=false,folder=true,changed=false,renameError}={}){
  const file={path:source,extension:'md'},other={path:dest};const moves=[];
  const vault={read:async()=>changed?markdown+'新内容':markdown,getAbstractFileByPath:p=>p==='推特创作/04已发布'&&folder?{children:[]}:p===file.path?file:p===dest&&collide?other:null,createFolder:async()=>{folder=true}};
  return {file,moves,app:{vault,fileManager:{renameFile:async(f,p)=>{if(renameError)throw Error(renameError);moves.push({from:f.path,to:p});f.path=p;}}}};
}
const receipt={verified:true,state:'published',commit_sent:true,url:'https://x.com/zwzw3888/status/123'};
let f=fixture({collide:true,folder:false});let r=await archiveVerifiedDelivery(f.app,f.file,source,markdown,receipt,'publish');
assert.equal(r.archived_path,'推特创作/04已发布/同名（2）.md');assert.equal(f.moves.length,1);assert.equal(f.file.path,r.archived_path);
assert.equal(readArchivedDelivery(f.file,markdown).url,receipt.url);
assert.equal(readArchivedDelivery(f.file,markdown+'又改'),undefined);
for(const value of [{verified:false,state:'failed'},{verified:false,state:'uncertain',commit_sent:true},{verified:true,state:'draft'},{...receipt,uncertain:true},{...receipt,commit_sent:false}]){
  f=fixture();r=await archiveVerifiedDelivery(f.app,f.file,source,markdown,value,'publish');assert.equal(f.moves.length,0);assert.equal(f.file.path,source);
}
f=fixture({changed:true});r=await archiveVerifiedDelivery(f.app,f.file,source,markdown,receipt,'publish');assert.equal(r.verified,true);assert.match(r.archive_error,/又有修改/);assert.equal(f.moves.length,0);
f=fixture({renameError:'没有写入权限'});r=await archiveVerifiedDelivery(f.app,f.file,source,markdown,receipt,'publish');assert.equal(r.verified,true);assert.equal(r.archive_error,'没有写入权限');assert.notEqual(r.uncertain,true);
f=fixture();f.file.path='推特创作/03创作中/评论/评论.md';r=await archiveVerifiedDelivery(f.app,f.file,f.file.path,markdown,receipt,'publish');assert.equal(f.moves.length,0);
f=fixture();r=await archiveVerifiedDelivery(f.app,f.file,source,markdown,{verified:true,state:'scheduled',commit_sent:true,scheduled_for:'2030-10-01T10:00:00Z'},'schedule','Asia/Shanghai');assert.equal(r.state,'scheduled');assert.equal(readArchivedDelivery(f.file,markdown).time_zone,'Asia/Shanghai');
console.log('通过：归档冲突不覆盖、缺失目录创建、失败/未知/错误状态不移动、新内容保留、移动失败不改发布结论、定时回执恢复');
