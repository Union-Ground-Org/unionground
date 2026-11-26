import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {LanguageProvider} from '../src/lib/LanguageContext.jsx';
import {WorkloadView} from '../src/views/WorkloadView.jsx';
import {WorkloadConfiguredEntry} from '../src/components/WorkloadConfiguredEntry.jsx';
import {WorkloadConfiguredHistory} from '../src/components/WorkloadConfiguredHistory.jsx';
import {defaultWorkloadDefinition,workloadDefinitionError,workloadPersonalSummary,workloadValuesError} from '../src/lib/workloadConfiguration.js';
import {clearDeviceParityState} from '../src/lib/deviceParity.js';
const field=(key,type,extra={})=>({key,label:key,type,kind:'field',visible:true,required:false,retired:false,unit:'',summary:'none',options:[],...extra});
const definition=()=>({title:'Fictional service log',period:'week',statuses:['draft','complete'],fields:[field('volume','number'),field('accepted','boolean',{required:true})]});
const configuration=(patch={})=>({organizationId:'test-fernbridge',version:1,definition:definition(),...patch});
const mount=node=>render(<LanguageProvider lang="en">{node}</LanguageProvider>);
beforeEach(()=>{clearDeviceParityState();window.history.replaceState(null,'','/m/workload');});
describe('configured workload gate regressions',()=>{
  it.each([['employment','ptHours'],['otWorked','otHours'],['leaveType','leaveTiming']])('rejects unavailable %s dependencies before apply', (controller,dependent)=>{
    for(const state of ['hidden','retired']){
      const d=defaultWorkloadDefinition();
      Object.assign(d.fields.find(f=>f.key===dependent),state==='hidden'?{visible:false}:{retired:true});
      if(controller==='employment')Object.assign(d.fields.find(f=>f.key===controller),{required:true,options:['part_time']});
      expect(workloadDefinitionError(d)).not.toBeNull();
      Object.assign(d.fields.find(f=>f.key===controller),{visible:false,required:false});
      expect(workloadDefinitionError(d)).toBeNull();
    }
    const fullTime=defaultWorkloadDefinition();fullTime.fields.find(f=>f.key==='employment').options=['full_time'];fullTime.fields.find(f=>f.key==='ptHours').visible=false;
    expect(workloadDefinitionError(fullTime)).toBeNull();
  });
  it.each([false,true])('submits known zero overtime for a blank hours field on %s edit',async edit=>{
    const cfg=configuration({definition:defaultWorkloadDefinition()}),save=vi.fn().mockResolvedValue({id:'saved'});
    const view=mount(<WorkloadConfiguredEntry configuration={cfg} entry={edit?{id:'old',values:{otWorked:false},status:'logged'}:null} onSave={save}/>);
    fireEvent.submit(view.container.querySelector('form'));
    await waitFor(()=>expect(save).toHaveBeenCalledWith(expect.objectContaining({values:expect.objectContaining({otWorked:false,otHours:0})})));
  });
  it('lets explicit no overtime satisfy required hours while retaining unknown and rejecting hidden answers',()=>{
    const d=defaultWorkloadDefinition();d.fields.find(f=>f.key==='otHours').required=true;
    expect(workloadValuesError(d,{otWorked:false},'logged')).toBeNull();
    expect(workloadValuesError(d,{},'logged')).toBe('otHours');
    d.fields.find(f=>f.key==='otHours').visible=false;
    expect(workloadValuesError(d,{otWorked:false,otHours:null},'logged')).toBe('unknown');
  });
  it('renders derived zero for required overtime hours so native validity permits no overtime',async()=>{
    const d=defaultWorkloadDefinition();d.fields.find(f=>f.key==='otHours').required=true;
    const save=vi.fn().mockResolvedValue({id:'saved'}),view=mount(<WorkloadConfiguredEntry configuration={configuration({definition:d})} onSave={save}/>);
    expect(screen.getByLabelText(/Overtime hours/)).toHaveValue(0);
    expect(view.container.querySelector('form').checkValidity()).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'Submit to secure ledger'}));
    await waitFor(()=>expect(save).toHaveBeenCalledWith(expect.objectContaining({values:expect.objectContaining({otWorked:false,otHours:0})})));
  });
  it('D preserves unsaved values and status across tab navigation while keeping scopes separate',async()=>{
    const cfg=configuration(),save=vi.fn().mockResolvedValue({id:'saved'});
    const view=mount(<WorkloadView data={{workload:{configuration:cfg,entries:[]}}} onLogWork={save}/>);
    fireEvent.change(screen.getByLabelText('volume'),{target:{value:'7'}});
    fireEvent.change(screen.getByLabelText('Status'),{target:{value:'complete'}});
    fireEvent.click(screen.getByRole('button',{name:'History'}));
    fireEvent.click(screen.getByRole('button',{name:'Submit',exact:true}));
    expect(screen.getByLabelText('volume')).toHaveValue(7);expect(screen.getByLabelText('Status')).toHaveValue('complete');
    view.rerender(<LanguageProvider lang="en"><WorkloadView data={{workload:{configuration:{...cfg,organizationId:'test-willowmere'},entries:[]}}} onLogWork={save}/></LanguageProvider>);
    expect(screen.getByLabelText('volume')).toHaveValue(null);expect(screen.getByLabelText('Status')).toHaveValue('draft');
    view.rerender(<LanguageProvider lang="en"><WorkloadView data={{workload:{configuration:{...cfg,version:2},entries:[]}}} onLogWork={save}/></LanguageProvider>);
    expect(screen.getByLabelText('volume')).toHaveValue(null);
    view.rerender(<LanguageProvider lang="en"><WorkloadView data={{workload:{configuration:cfg,entries:[]}}} onLogWork={save}/></LanguageProvider>);
    expect(screen.getByLabelText('volume')).toHaveValue(7);
    fireEvent.click(screen.getByRole('button',{name:'Submit to secure ledger'}));
    await screen.findByText('Workload entry saved.');
    expect(save).toHaveBeenCalledWith(expect.objectContaining({configurationVersion:1,status:'complete',values:{volume:7,accepted:false}}));
    expect(screen.getByLabelText('volume')).toHaveValue(null);expect(screen.getByLabelText('Status')).toHaveValue('draft');
  });
  it('E keeps configured collective statistics behind the existing survey gate',()=>{
    const gate=vi.fn(node=><div data-testid="collective-survey-gate">{node}</div>);
    mount(<WorkloadView data={{workload:{configuration:configuration(),entries:[],stats:{enoughData:true,period:'2026-Q3',submittersBand:'25-49',categories:[{key:'priority',avg:7,median:6,p90:10}],tiles:{pctFullTime:80,pctPartTime:20,avgOtHours:1.5}}}}} onLogWork={vi.fn()} statsGate={gate}/>);
    fireEvent.click(screen.getByRole('button',{name:'Stats'}));
    expect(gate).toHaveBeenCalled();expect(screen.getByTestId('collective-survey-gate')).toHaveTextContent('2026-Q3');
    expect(screen.queryByText('Your workload report')).toBeNull();
  });
  it('keeps unknown collective tiles unavailable instead of displaying zero',()=>{
    const view=mount(<WorkloadView data={{workload:{configuration:configuration(),entries:[],stats:{enoughData:true,categories:[],tiles:{pctFullTime:null,pctPartTime:null,avgOtHours:null}}}}}/>);
    fireEvent.click(screen.getByRole('button',{name:'Stats'}));
    expect([...view.container.querySelectorAll('.mwl-tile__val')].map(node=>node.textContent)).toEqual(['—','—','—']);
  });
  it('allows an unchecked required boolean through native validity and submits false',async()=>{
    const save=vi.fn().mockResolvedValue({id:'saved'});const view=mount(<WorkloadConfiguredEntry configuration={configuration()} onSave={save}/>);
    const checkbox=screen.getByRole('checkbox',{name:'accepted *'});expect(checkbox.required).toBe(false);expect(checkbox).not.toBeChecked();
    expect(view.container.querySelector('form').checkValidity()).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'Submit to secure ledger'}));await waitFor(()=>expect(save).toHaveBeenCalledWith(expect.objectContaining({values:{accepted:false}})));
  });
  it('rejects contradictory original overtime on the web as well as the database',()=>{
    expect(workloadValuesError(defaultWorkloadDefinition(),{otWorked:true,otHours:0},'logged')).toBe('otHours');
    expect(workloadValuesError(defaultWorkloadDefinition(),{otWorked:true},'logged')).toBe('otHours');
    expect(workloadValuesError(defaultWorkloadDefinition(),{otWorked:false,otHours:2},'logged')).toBe('otHours');
    expect(workloadValuesError(defaultWorkloadDefinition(),{employment:'part_time'},'logged')).toBe('ptHours');
    expect(workloadValuesError(defaultWorkloadDefinition(),{leaveType:'sick_leave'},'logged')).toBe('leaveTiming');
    expect(workloadValuesError(defaultWorkloadDefinition(),{otWorked:true,otHours:2,employment:'part_time',ptHours:20,leaveType:'sick_leave',leaveTiming:'planned'},'logged')).toBeNull();
  });
  it('uses the historical worked date and period for both filtering and totals',()=>{
    const cfg=configuration({definition:{...definition(),period:'month'}}),snapshot=configuration({definition:{...definition(),fields:[field('volume','number',{summary:'sum'}),field('workedOn','date')]}});
    const rows=[{id:'a',createdAt:'2026-11-05T12:00:00Z',configurationSnapshot:snapshot,values:{volume:3,workedOn:'2026-10-31'},status:'draft'},{id:'b',createdAt:'2026-11-05T12:00:00Z',configurationSnapshot:snapshot,values:{volume:4,workedOn:'2026-11-01'},status:'draft'}];
    expect(workloadPersonalSummary(rows)[0]).toMatchObject({period:'2026-10-26',value:7});
    const view=mount(<WorkloadConfiguredHistory entries={rows} configuration={cfg}/>);
    expect(screen.getByRole('option',{name:'2026-10-26'})).toBeInTheDocument();
    expect(screen.queryByRole('option',{name:'2026-11'})).toBeNull();
    fireEvent.change(screen.getByLabelText('Reporting period'),{target:{value:'2026-10-26'}});
    expect(view.container.querySelectorAll('.mwl-histrow')).toHaveLength(2);expect(screen.getByText(/volume: 7/)).toBeInTheDocument();
  });
  it('preserves version-zero note allowances in the editor',async()=>{
    const cfg=configuration({version:0,definition:defaultWorkloadDefinition()}),save=vi.fn().mockResolvedValue({id:'saved'});
    const view=mount(<WorkloadConfiguredEntry configuration={cfg} entry={{id:'legacy',values:{note:'n'.repeat(501)},status:'logged'}} onSave={save}/>);
    fireEvent.submit(view.container.querySelector('form'));await waitFor(()=>expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].values.note).toHaveLength(501);
  });
  it('retains the actionable daily-limit error',async()=>{
    const view=mount(<WorkloadConfiguredEntry configuration={configuration()} onSave={vi.fn().mockRejectedValue({details:'workload_daily_limit'})}/>);
    fireEvent.submit(view.container.querySelector('form'));expect(await screen.findByRole('alert')).toHaveTextContent("You have already added 3 workplace log entries today, which is the daily limit. You can add more tomorrow.");
  });
  it('does not rename stored builtin labels through current organization overrides',()=>{
    const cfg=configuration({definition:{...definition(),fields:[field('priority','number',{label:'workload.cat.priority',summary:'sum'})]}});
    render(<LanguageProvider lang="en" labelOverrides={{'workload.cat.priority':'Triage'}}><WorkloadConfiguredHistory entries={[{id:'one',configurationSnapshot:cfg,values:{priority:7},status:'draft'}]} configuration={cfg}/></LanguageProvider>);
    expect(screen.queryAllByText('Triage')).toHaveLength(0);expect(screen.getAllByText('Priority')[0]).toBeInTheDocument();
  });
});
