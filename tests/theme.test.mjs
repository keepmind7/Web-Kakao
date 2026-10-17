import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,readFileSync } from 'node:fs';
import vm from 'node:vm';

const themePath=new URL('../experiments/local-web/theme.js',import.meta.url);
// Missing implementation deliberately evaluates an empty script so RED is an
// absent browser behavior assertion, not an import/ENOENT setup failure.
const source=existsSync(themePath)?readFileSync(themePath,'utf8'):'';
function fixture({dark=false,saved,denied=false,store=new Map(saved===undefined?[]:[['web-kakao-theme',saved]])}={}){
  const listeners=new Map(),mediaListeners=new Set(),writes=[];
  class Element{
    constructor(){this.listeners=new Map();this.attributes=new Map();this.dataset={};this.value='';this.textContent='';this.title='';}
    addEventListener(type,fn){this.listeners.set(type,[...(this.listeners.get(type)||[]),fn]);}
    setAttribute(name,value){this.attributes.set(name,String(value));}
    getAttribute(name){return this.attributes.get(name)??null;}
    dispatch(type){for(const fn of this.listeners.get(type)||[])fn({type,target:this,currentTarget:this});}
  }
  const root=new Element(),button=new Element(),select=new Element();
  const media={matches:dark,media:'(prefers-color-scheme: dark)',addEventListener(type,fn){if(type==='change')mediaListeners.add(fn);},addListener(fn){mediaListeners.add(fn);}};
  const document={documentElement:root,readyState:'loading',getElementById:id=>id==='theme-toggle'?button:id==='theme-mode'?select:null,addEventListener(type,fn){listeners.set(type,[...(listeners.get(type)||[]),fn]);}};
  const context={document,matchMedia:()=>media,localStorage:{getItem(key){if(denied)throw new Error('storage unavailable');return store.get(key)??null;},setItem(key,value){if(denied)throw new Error('storage unavailable');writes.push({key,value:String(value)});store.set(key,String(value));},removeItem(key){if(denied)throw new Error('storage unavailable');writes.push({key,removed:true});store.delete(key);}},console};
  context.window=context;context.globalThis=context;vm.runInNewContext(source,context,{filename:'theme.js'});
  const initial=root.dataset.theme;
  document.readyState='interactive';for(const fn of listeners.get('DOMContentLoaded')||[])fn({type:'DOMContentLoaded'});
  return {root,button,select,initial,store,writes,os(value){media.matches=value;for(const fn of mediaListeners)fn({matches:value});},mode(value){select.value=value;select.dispatch('change');}};
}
test('theme applies system light synchronously before DOMContentLoaded',()=>{const f=fixture();assert.equal(f.initial,'light');assert.equal(f.root.dataset.theme,'light');assert.equal(f.select.value,'system');assert.equal(f.writes.length,0);});
test('theme applies system dark synchronously before DOMContentLoaded',()=>{assert.equal(fixture({dark:true}).initial,'dark');});
test('system theme follows OS changes in both directions',()=>{const f=fixture();f.os(true);assert.equal(f.root.dataset.theme,'dark');f.os(false);assert.equal(f.root.dataset.theme,'light');assert.equal(f.writes.length,0);});
test('saved manual theme ignores OS changes',()=>{const f=fixture({dark:true,saved:'light'});assert.equal(f.initial,'light');f.os(false);f.os(true);assert.equal(f.root.dataset.theme,'light');assert.equal(f.select.value,'light');});
test('theme toggle persists only the manual mode and survives reload',()=>{const f=fixture();f.button.dispatch('click');assert.equal(f.root.dataset.theme,'dark');assert.equal(f.store.get('web-kakao-theme'),'dark');assert.equal(f.select.value,'dark');const reload=fixture({store:f.store});assert.equal(reload.initial,'dark');assert.ok(f.writes.every(row=>row.key==='web-kakao-theme' && ['system','light','dark'].includes(row.value)));});
test('settings can choose light dark then return to live system mode',()=>{const f=fixture({dark:false});f.mode('dark');assert.equal(f.root.dataset.theme,'dark');f.mode('light');assert.equal(f.root.dataset.theme,'light');f.mode('system');f.os(true);assert.equal(f.root.dataset.theme,'dark');assert.equal(f.select.value,'system');assert.ok([undefined,'system'].includes(f.store.get('web-kakao-theme')));});
test('denied storage leaves toggle and system following usable',()=>{const f=fixture({dark:true,denied:true});assert.equal(f.root.dataset.theme,'dark');f.button.dispatch('click');assert.equal(f.root.dataset.theme,'light');f.mode('system');f.os(false);f.os(true);assert.equal(f.root.dataset.theme,'dark');});
test('invalid saved theme falls back to system without writing account data',()=>{const f=fixture({dark:true,saved:'unexpected-value'});assert.equal(f.initial,'dark');assert.equal(f.select.value,'system');assert.ok(f.writes.every(row=>row.key==='web-kakao-theme'));});
