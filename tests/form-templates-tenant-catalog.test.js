import assert from 'node:assert/strict';
import { test } from 'vitest';
import { FORM_TEMPLATES, currentFormTemplateRows, formProgress, resolveFormTemplates } from '../src/lib/formTemplates.js';

test('a tenant retirement hides the shared default without losing the pinned version',()=>{
  const rows=[
    {key:'grievance',version:1,active:true,available_to_start:true,label_en:'Platform default'},
    {key:'grievance',version:3,active:false,available_to_start:true,label_en:'Retired local version'},
    {key:'private_survey',version:9,active:true,available_to_start:false,label_en:'Pinned historical survey'},
  ];
  const available=currentFormTemplateRows(rows).filter(row=>row.active);
  assert.deepEqual(resolveFormTemplates(available,'en',{loaded:true}),[]);
  assert.equal(rows[0].version,1);
  assert.equal(rows[2].label_en,'Pinned historical survey');
});

test('member choices use the current local version and retain offline seed fallback',()=>{
  const rows=[
    {key:'grievance',version:1,active:true,available_to_start:true,label_en:'Platform default'},
    {key:'grievance',version:8,active:true,available_to_start:true,label_en:'Local grievance'},
    {key:'survey',version:2,active:true,available_to_start:false,label_en:'Archived survey'},
  ];
  const available=currentFormTemplateRows(rows).filter(row=>row.active);
  assert.deepEqual(resolveFormTemplates(available).map(x=>x.titleKey),['Local grievance']);
  assert.equal(resolveFormTemplates([]),FORM_TEMPLATES);
});

test('orders the selected versions by their own sort, not an older version\'s',()=>{
  const rows=[
    {key:'intake',version:1,active:false,available_to_start:true,sort:1},
    {key:'leave',version:1,active:true,available_to_start:true,sort:10},
    {key:'intake',version:2,active:true,available_to_start:true,sort:20},
  ];
  assert.deepEqual(currentFormTemplateRows(rows).map(row=>`${row.key}@${row.version}`),['leave@1','intake@2']);
});

test('an older version listed after a newer one never replaces the current version',()=>{
  const rows=[
    {key:'grievance',version:5,active:true,available_to_start:true,label_en:'Current local version'},
    {key:'grievance',version:2,active:true,available_to_start:true,label_en:'Superseded version'},
    {key:'grievance',version:'4',active:true,available_to_start:true,label_en:'String version, still older'},
  ];
  assert.deepEqual(currentFormTemplateRows(rows).map(row=>row.label_en),['Current local version']);
});

test('unsorted versions rank after sorted ones and tie-break by key in both directions',()=>{
  const rows=[
    {key:'zeta',version:1,available_to_start:true},
    {key:'alpha',version:1,available_to_start:true,sort:null},
    {key:'mid',version:1,available_to_start:true,sort:'3'},
    {key:'beta',version:1,available_to_start:true},
  ];
  assert.deepEqual(currentFormTemplateRows(rows).map(row=>row.key),['mid','alpha','beta','zeta']);
  assert.deepEqual(currentFormTemplateRows([...rows].reverse()).map(row=>row.key),['mid','alpha','beta','zeta']);
});

test('a malformed localized step title degrades to text instead of throwing',()=>{
  const [template]=resolveFormTemplates([{
    key:'custom',version:1,label_en:'Custom',
    field_schema:{steps:[{title:null,fields:[]},{title:'Plain title',fields:[]},{title:7,fields:[]}]},
  }]);
  assert.deepEqual(template.steps.map(step=>step.titleKey),['','Plain title','7']);
});

test('a multiselect answer counts as answered only when it has at least one choice',()=>{
  const template={steps:[{fields:[{key:'issues',required:true}]}]};
  assert.deepEqual(formProgress(template,{issues:[]}),{pct:0,nextFieldKey:'issues'});
  assert.deepEqual(formProgress(template,{issues:['pay']}),{pct:100,nextFieldKey:null});
});
