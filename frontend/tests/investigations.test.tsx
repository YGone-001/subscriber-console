import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../src/providers/I18nProvider';
import { InvestigationCoverage, InvestigationTimeline } from '../src/features/investigations/InvestigationEvidence';
import { InvestigationEditor } from '../src/features/investigations/InvestigationEditor';
import { alertReturn, contextPath, investigationEntry, investigationListPath, investigationReturn, recordLink, type InvestigationContext, type RecordView } from '../src/features/investigations/investigation-model';
import { investigationsEn, investigationsZh } from '../src/lib/locales/investigations';

const id='00000001-0000-4000-8000-000000000001';
const at='2026-11-12T01:00:00Z';
const context:InvestigationContext={generatedAt:at,from:at,to:'2026-11-12T02:00:00Z',anchor:{alertId:id,resourceId:id,targetId:id,name:'DEMO',state:'active',severity:'warning',firstTriggeredAt:at},resources:[{resourceId:id,name:'SMF A',domain:'5gc',role:'smf',kind:'network_function',lifecycleState:'active'}],relations:[],events:[{key:'configuration:'+id,kind:'configuration',id,resourceId:id,sourceId:id,at,outcome:'ok',basis:'same_resource',changed:true}],coverage:{inventory:{state:'complete',returned:1,limit:21,historyCoverage:'unknown'},configuration:{state:'complete',returned:1,limit:128,historyCoverage:'unknown'}},completeness:'complete',relationshipBasis:'current_declared_one_hop'};
const record:RecordView={record:{investigationId:id,alertId:id,resourceId:id,from:at,to:context.to,title:'Human notes',status:'investigating',notes:'<script>secret is not markup</script>',conclusion:'Inconclusive',knowledgeIds:[],revision:2,createdAt:at,updatedAt:at,createdBy:'operator',updatedBy:'operator',recentChanges:[]},knowledge:[],knowledgeCoverage:{state:'complete',returned:0,limit:8,historyCoverage:'unknown'}};
function render(element:React.ReactNode){return renderToStaticMarkup(<MemoryRouter><I18nProvider>{element}</I18nProvider></MemoryRouter>);}

test('investigation routes retain entity-specific return context and reject external destinations',()=>{
  const path=investigationEntry(id,'/nf-alerts?view=history&severity=critical');assert.equal(alertReturn(path.split('?')[1]),'/nf-alerts?view=history&severity=critical');
  assert.equal(alertReturn(investigationEntry(id,'https://evil.test').split('?')[1]),'/nf-alerts');
  const detail=recordLink(id,'/investigations?status=resolved&cursor=abc');assert.equal(investigationReturn(detail.split('?')[1]),'/investigations?status=resolved&cursor=abc');
  assert.equal(investigationReturn('?returnTo=%2F%2Fevil.test'),'/investigations');assert.equal(investigationReturn('?returnTo=%2Fnf-alerts'),'/investigations');
});
test('saved context uses server-owned window and invalid resource-like names cannot become anchors',()=>{
  assert.equal(contextPath('smfd'),null);assert.equal(contextPath('http://evil.test'),null);
  const url=new URL(contextPath(id,'bad-from','bad-to',id)!,'http://local.test');assert.equal(url.searchParams.get('investigationId'),id);assert.equal(url.searchParams.has('from'),false);assert.equal(url.searchParams.has('to'),false);
});
test('directory query preserves supported filters and excludes UI-only values',()=>{
  const query=investigationListPath(new URLSearchParams({q:'.*',status:'open',resourceId:id,cursor:'abc',returnTo:'//evil',kind:'health'}));
  const url=new URL(query,'http://local.test');assert.equal(url.searchParams.get('q'),'.*');assert.equal(url.searchParams.get('resourceId'),id);assert.equal(url.searchParams.get('limit'),'25');assert.equal(url.searchParams.has('returnTo'),false);assert.equal(url.searchParams.has('kind'),false);
});
test('configuration timeline distinguishes observation time from modification or causation',()=>{
  const html=render(<InvestigationTimeline data={context}/>);assert.ok(html.toLowerCase().includes('datetime="'+at.toLowerCase()+'"'));const visibleTime=html.match(/<time\b[^>]*>(.*?)<\/time>/i)?.[1]||'';assert.ok(visibleTime.includes('2026')&&visibleTime.includes(':'),'visible evidence time must retain its date and clock fields');assert.ok(html.includes('configuration')||html.includes('\u914d\u7f6e'));assert.ok(!html.includes('confidence'));assert.ok(html.includes(`/config-snapshots/${id}`));
  const filtered=render(<InvestigationTimeline data={context} category="health"/>);assert.ok(!filtered.includes('datetime='));
});
test('unavailable source does not become a returned zero or successful read',()=>{
  const html=render(<InvestigationCoverage data={{...context,completeness:'unavailable',coverage:{configuration:{state:'unavailable',reason:'read_failed',returned:0,limit:128,historyCoverage:'unknown'}}}}/>);
  assert.ok(html.includes('data-state="unavailable"'));assert.ok(!html.includes('Returned 0'));assert.ok(!html.includes('\u8fd4\u56de 0'));
});
test('viewer sees escaped human notes and cannot save an investigation',()=>{
  const html=render(<InvestigationEditor view={record} canWrite={false} readError={false} onReload={async()=>record} onSaved={()=>{}}/>);
  assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(html.includes('disabled=""'));assert.ok(!html.includes('type="submit"'));
});
test('operator editor presents record versions and explicit conclusion fields',()=>{
  const html=render(<InvestigationEditor view={record} canWrite readError={false} onReload={async()=>record} onSaved={()=>{}}/>);assert.ok(html.includes('investigation-conclusion'));assert.ok(html.includes('investigation-notes'));assert.ok(html.includes('type="submit"'));assert.ok(html.includes('operator'));
});
test('investigation translations retain identical bilingual key sets',()=>{assert.deepEqual(Object.keys(investigationsEn).sort(),Object.keys(investigationsZh).sort());for(const key of Object.keys(investigationsEn)){assert.ok(investigationsEn[key].trim());assert.ok(investigationsZh[key].trim());}});
