#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {setTimeout,clearTimeout} from 'node:timers';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer as createViteServer} from 'vite';
import {chromium} from 'playwright';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(root,'../output/playwright/bounded-read-development');
const requests=[],aborted=[],timers=new Set(),errors=[];
const vite=await createViteServer({root,server:{middlewareMode:true,hmr:false},appType:'custom'});
const html='<!doctype html><html><head><title>Bounded read development fixture</title></head><body><div id="root"></div><script type="module" src="/tests/fixtures/bounded-read-development.tsx"></script></body></html>';
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://fixture.local');
  if(url.pathname==='/api/bounded-read-fixture') {
    const scope=url.searchParams.get('scope');requests.push(scope);
    res.on('close',()=>{if(!res.writableEnded)aborted.push(scope);});
    const timer=setTimeout(()=>{timers.delete(timer);if(!res.destroyed){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({scope}));}},scope==='slow'?600:200);
    timers.add(timer);return;
  }
  if(url.pathname==='/') {res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml(req.url,html));return;}
  vite.middlewares(req,res,()=>{res.statusCode=404;res.end();});
});
let browser,result={};
const poll=async fn=>{for(let n=0;n<100;n++){if(await fn())return;await new Promise(r=>setTimeout(r,25));}throw Error('Condition did not settle');};
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
try {
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1000,height:600}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  await poll(async()=>await page.locator('#primary').textContent()==='first');
  assert.equal(await page.locator('#secondary').textContent(),'first');assert.equal(requests.filter(x=>x==='first').length,1);assert.deepEqual(aborted,[]);
  await page.click('#next');await poll(()=>requests.includes('next'));await page.click('#peer');
  await poll(async()=>await page.locator('#primary').textContent()==='next');assert.ok(!aborted.includes('next'));
  await page.click('#slow');await poll(()=>requests.includes('slow'));await page.click('#toggle');await poll(()=>aborted.includes('slow'));
  await page.click('#toggle');await poll(async()=>await page.locator('#primary').textContent()==='slow');
  assert.equal(requests.filter(x=>x==='slow').length,2);assert.deepEqual(errors,[]);
  await mkdir(output,{recursive:true});await page.screenshot({path:join(output,'strict-mode.png')});
  result={result:'PASS',checks:['StrictMode replay preserves a deduplicated request shared by two consumers','Removing one consumer preserves the remaining read','Removing the last consumer cancels its request','Remounting the canceled key reads successfully'],requests,aborted,errors};
  console.log(JSON.stringify(result,null,2));
} catch(error){result={result:'FAIL',error:String(error),requests,aborted,errors};throw error;}
finally {
  await mkdir(output,{recursive:true});await writeFile(join(output,'results.json'),JSON.stringify(result,null,2));
  if(browser)await browser.close();for(const timer of timers)clearTimeout(timer);await vite.close();await new Promise(r=>server.close(r));
}
