// Diagnostic data derived from the reviewed deterministic seed, not a hosted read.
// supabase/migrations/20260829024000_organization_intelligence_seed_conflict_repair.sql:52-80
export const nodes = ['agency','union'].flatMap(chartKind => Array.from({length:25},(_,index)=>{
 const n=index+1, agency=chartKind==='agency';
 return {id:`${chartKind}-${n}`,chartKind,nodeKind:n===1?'organization':agency?'division':'chapter',parentId:n===1?null:`${chartKind}-1`,
 label:n===1?(agency?'Human Services Agency':'Statewide Council'):`${agency?'Regional operations division':'Chapter leadership circle'} ${String(n-1).padStart(2,'0')}`,
 subtitle:n===1?(agency?'Agency reporting structure':'Organization-wide member governance'):(agency?'Service delivery and workplace operations':'Chapter officers, stewards, and workplace leaders'),
 positionX:n===1?50:10+((n-2)%5)*20,positionY:n===1?5:22+Math.floor((n-2)/5)*16,sortOrder:n};
}));

export const relationshipNodes = Array.from({ length: 25 }, (_, index) => ({
  id: `person-${index + 1}`,
  label: `Organization relationship member ${String(index + 1).padStart(2, "0")}`,
  roleLabel: index % 3 === 0 ? "Steward" : index % 3 === 1 ? "Coordinator" : "Member organizer",
}));

export const relationships = relationshipNodes.map((node, index) => ({
  id: `relationship-${index + 1}`,
  sourceId: node.id,
  targetId: relationshipNodes[(index + 1) % relationshipNodes.length].id,
  kind: index % 2 ? "organizes_with" : "works_with",
  strength: (index % 5) + 1,
}));

export const topicProgress = relationshipNodes.map((node, index) => ({
  memberId: node.id,
  topicKey: `topic-${index + 1}`,
  topicLabel: `Organization readiness topic ${String(index + 1).padStart(2, "0")}`,
  state: index % 2 ? "developing" : "introduced",
  progress: (index * 4) % 101,
}));

export const timeline = Array.from({ length: 25 }, (_, index) => ({
  id: `timeline-${index + 1}`,
  kind: index % 3 === 1 ? "payroll_snapshot" : "leadership_term",
  title: `Organization leadership and payroll event ${String(index + 1).padStart(2, "0")}`,
  detail: `Source-derived local diagnostic timeline detail ${index + 1}.`,
  effectiveOn: `202${index % 7}-0${(index % 9) + 1}-15`,
  ...(index % 3 === 1 ? {
    amountCents: 18450000 + index * 100,
    amountBasis: "Annual aggregate",
    sourceLabel: "Organization-provided payroll file",
    sourceAsOf: `202${index % 7}-0${(index % 9) + 1}-15`,
  } : {}),
}));
