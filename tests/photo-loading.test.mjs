import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {setTimeout as delay} from 'node:timers/promises';

const source=readFileSync(new URL('../experiments/local-web/photo-loader.js',import.meta.url),'utf8');
const src=n=>`/api/photo?room=r_${'a'.repeat(24)}&message=m_${(n+1).toString(16).padStart(24,'0')}&index=0&cap=${'b'.repeat(64)}`;
class Image extends EventTarget{
  constructor(){super();this.attributes=new Map();this.assignments=[];this.listeners=new Map();}
  set src(value){this.attributes.set('src',value);this.assignments.push(value);}
  get src(){return this.attributes.get('src');}
  getAttribute(name){return this.attributes.get(name) ?? null;}
  removeAttribute(name){this.attributes.delete(name);}
  addEventListener(name,fn,options){super.addEventListener(name,fn,options);this.listeners.set(name,fn);}
  removeEventListener(name,fn){super.removeEventListener(name,fn);if(this.listeners.get(name)===fn)this.listeners.delete(name);}
}
function fixture({locks,clock}={}){
  let observer;const observers=[];
  class Observer{constructor(callback){this.callback=callback;this.targets=new Set();this.disconnects=0;observer=this;observers.push(this);}observe(target){this.targets.add(target);}unobserve(target){this.targets.delete(target);}disconnect(){this.targets.clear();this.disconnects++;}show(...targets){this.callback(targets.map(target=>({target,isIntersecting:true})));}hide(target){this.callback([{target,isIntersecting:false}]);}}
  const context=vm.createContext({AbortController,DOMException,IntersectionObserver:Observer,navigator:{locks},queueMicrotask,setTimeout:clock?.setTimeout || setTimeout,clearTimeout:clock?.clearTimeout || clearTimeout});vm.runInContext(source,context);
  const loader=context.createPhotoLoader({root:{}});return {loader,observer,observers,images:Array.from({length:5},()=>new Image())};
}
const settle=async()=>{for(let n=0;n<5;n++)await Promise.resolve();};
const deferred=()=>{let resolve;const promise=new Promise(accept=>resolve=accept);return {promise,resolve};};
const until=async condition=>{const end=Date.now()+1000;while(!condition()){if(Date.now()>end)throw new Error('controlled lock fixture deadline');await delay(1);}};

test('viewport-gated images use only two slots and release on both load and error',()=>{
  const {loader,observer,images}=fixture();images.forEach((image,n)=>loader.image(image,src(n)));
  assert.ok(images.every(image=>!image.src),'offscreen photos must not get a source');
  observer.show(...images);assert.deepEqual(images.map(image=>Boolean(image.src)),[true,true,false,false,false]);
  images[0].dispatchEvent(new Event('load'));assert.ok(images[2].src);assert.equal(images[3].src,undefined);
  images[1].dispatchEvent(new Event('error'));assert.ok(images[3].src);assert.equal(images[4].src,undefined);loader.clear();
});
test('an image that leaves the viewport while queued waits until it returns',()=>{
  const {loader,observer,images}=fixture();images.slice(0,3).forEach((image,n)=>loader.image(image,src(n)));observer.show(...images.slice(0,3));observer.hide(images[2]);
  images[0].dispatchEvent(new Event('load'));assert.equal(images[2].src,undefined);observer.show(images[2]);assert.ok(images[2].src);loader.clear();
});
test('same source and retained image identity never repeat a completed request',()=>{
  const {loader,observer,images:[image]}=fixture();loader.image(image,src(0));observer.show(image);image.dispatchEvent(new Event('load'));loader.image(image,src(0));observer.show(image);assert.deepEqual(image.assignments,[src(0)]);loader.clear();
});
test('clear disconnects observation, cancels active and queued images and ignores old callbacks',()=>{
  const {loader,observer,observers,images}=fixture();let oldLoads=0,newLoads=0;
  images.slice(0,3).forEach((image,n)=>loader.image(image,src(n),{onLoad:()=>oldLoads++}));observer.show(...images.slice(0,3));const late=images[0].listeners.get('load');loader.clear();
  assert.equal(observer.targets.size,0);assert.equal(observer.disconnects,1);assert.ok(images.every(image=>!image.src));
  images.slice(0,3).forEach((image,n)=>loader.image(image,src(n+10),{onLoad:()=>newLoads++}));observers.at(-1).show(...images.slice(0,3));late();assert.equal(oldLoads,0);assert.equal(newLoads,0);assert.equal(images[2].src,undefined,'old load must not free a new generation slot');
  images[0].dispatchEvent(new Event('load'));assert.equal(newLoads,1);assert.ok(images[2].src);loader.clear();
});
test('explicit fetch shares image slots and aborted queued work never starts',async()=>{
  const {loader,observer,images}=fixture();images.slice(0,3).forEach((image,n)=>loader.image(image,src(n)));observer.show(...images.slice(0,3));
  const gate=deferred();let calls=0;const fetch=loader.run(async signal=>{calls++;assert.equal(signal.aborted,false);return gate.promise;});
  const controller=new AbortController();let unwanted=0;const canceled=loader.run(()=>unwanted++,{signal:controller.signal});controller.abort();await assert.rejects(canceled,{name:'AbortError'});
  await settle();assert.equal(calls,0);images[0].dispatchEvent(new Event('load'));await settle();assert.equal(calls,1);assert.equal(images[2].src,undefined,'explicit operation has priority over background photos');
  gate.resolve('download bytes');assert.equal(await fetch,'download bytes');await settle();assert.ok(images[2].src);assert.equal(unwanted,0);loader.clear();
});
test('page suspension aborts active fetch and ignores its late completion after a new generation',async()=>{
  const {loader,observers,images}=fixture(),gate=deferred();let signal;
  const old=loader.run(value=>{signal=value;return gate.promise;});await settle();loader.setActive(false);assert.equal(signal.aborted,true);await assert.rejects(old,{name:'AbortError'});
  loader.image(images[0],src(0));observers.at(-1).show(images[0]);assert.equal(images[0].src,undefined);loader.setActive(true);assert.ok(images[0].src);
  loader.image(images[1],src(1),{eager:true});loader.image(images[2],src(2),{eager:true});gate.resolve('late bytes');await settle();assert.equal(images[2].src,undefined,'old completion cannot free a new active slot');
  images[0].dispatchEvent(new Event('load'));assert.ok(images[2].src);loader.clear();
});
test('removing a rendered subtree drops queued images without a later request',()=>{
  const {loader,observer,images}=fixture();images.forEach((image,n)=>loader.image(image,src(n)));observer.show(...images);loader.removeTree({querySelectorAll:()=>images.slice(2)});
  images[0].dispatchEvent(new Event('load'));images[1].dispatchEvent(new Event('load'));assert.ok(images.slice(2).every(image=>!image.src));assert.equal(observer.targets.size,0);loader.clear();
});
test('non-capability photo URLs never start a request',()=>{
  const {loader,observer,images:[image]}=fixture();for(const value of ['https://example.invalid/image.png','/api/photo?room=bad','blob:arbitrary'])loader.image(image,value,{eager:true});observer.show(image);assert.equal(image.src,undefined);loader.clear();
});
test('late observer notifications from a cleared generation cannot start new image requests',()=>{
  const {loader,observer,observers,images:[image]}=fixture();loader.image(image,src(0));loader.clear();loader.image(image,src(1));observer.show(image);
  assert.equal(image.src,undefined,'old observer callback must be invalid');observers.at(-1).show(image);assert.equal(image.src,src(1));loader.clear();
});
test('subtree cancellation never starts another image inside that same removed subtree',()=>{
  const {loader,observer,images}=fixture();images.forEach((image,n)=>loader.image(image,src(n)));observer.show(...images);
  loader.removeTree({querySelectorAll:()=>images.slice(0,4)});
  assert.equal(images[2].assignments.length,0);assert.equal(images[3].assignments.length,0);assert.equal(images[4].src,src(4));loader.clear();
});
test('separate tabs use real shared Web Locks before starting photo HTTP',async()=>{
  const tabs=Array.from({length:3},()=>fixture({locks:navigator.locks}));
  try{
    for(const {loader,images} of tabs)images.slice(0,2).forEach((image,n)=>loader.image(image,src(n),{eager:true}));
    await until(()=>tabs.flatMap(f=>f.images).filter(image=>image.src).length>=2);
    assert.equal(tabs.flatMap(f=>f.images).filter(image=>image.src).length,2,'origin-wide photo HTTP maximum');
    tabs[0].loader.clear();await until(()=>tabs[1].images.slice(0,2).every(image=>image.src));assert.ok(tabs[2].images.every(image=>!image.src));
  }finally{tabs.forEach(f=>f.loader.clear());}
});
test('abort cancels a queued shared lock before it can fetch, without releasing another owner',async()=>{
  const owner=fixture({locks:navigator.locks}),waiter=fixture({locks:navigator.locks});let calls=0;
  try{
    owner.images.slice(0,2).forEach((image,n)=>owner.loader.image(image,src(n),{eager:true}));await until(()=>owner.images[1].src);
    const controller=new AbortController(),operation=waiter.loader.run(()=>calls++,{signal:controller.signal});
    const queued=await navigator.locks.query();assert.ok(queued.pending.some(row=>row.name.startsWith('web-kakao-photo-')),'fixture must reach the real shared-lock wait');
    controller.abort();await assert.rejects(operation,{name:'AbortError'});owner.loader.clear();await delay(5);assert.equal(calls,0);
  }finally{owner.loader.clear();waiter.loader.clear();}
});
test('image deadline releases a shared lock and a late old load cannot release its successor',async()=>{
  const timers=new Map();let timerId=0;const clock={setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)};
  const first=fixture({locks:navigator.locks,clock}),second=fixture({locks:navigator.locks});let errors=0;
  try{
    first.images.slice(0,2).forEach((image,n)=>first.loader.image(image,src(n),{eager:true,onError:()=>errors++}));await until(()=>first.images[1].src);const late=first.images[0].listeners.get('load');
    second.images.slice(0,3).forEach((image,n)=>second.loader.image(image,src(n+10),{eager:true}));
    assert.ok(timers.size>0,'active images need a bounded deadline');timers.values().next().value();await until(()=>second.images[0].src);assert.equal(errors,1);assert.equal(first.images[0].src,undefined);
    late();await delay(5);assert.equal(second.images[1].src,undefined);assert.equal(second.images[2].src,undefined);
  }finally{first.loader.clear();second.loader.clear();}
});
