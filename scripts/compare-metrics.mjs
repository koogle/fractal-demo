import {readFileSync} from 'node:fs';
const [beforePath,afterPath]=process.argv.slice(2);
if(!beforePath||!afterPath) { console.error('Usage: node scripts/compare-metrics.mjs before.json after.json');process.exit(2); }
const before=JSON.parse(readFileSync(beforePath)),after=JSON.parse(readFileSync(afterPath));
if(before.scenario!==after.scenario||before.schemaVersion!==after.schemaVersion)throw new Error('Scenario/schema mismatch');
for(const key of ['width','height','dpr','iterations','textureBudgetBytes','maxJobs','fadeMs','seed','stressRound']) {
  if(before.metadata[key]!==after.metadata[key])throw new Error(`Benchmark configuration mismatch: ${key}`);
}
const rows=[];
for(const [metric,b] of Object.entries(before.summary)) {
 const a=after.summary[metric];if(typeof a!=='number'||typeof b!=='number')continue;
 rows.push({metric,before:Number(b.toFixed(3)),after:Number(a.toFixed(3)),changePercent:b?Number(((a/b-1)*100).toFixed(1)):null});
}
console.table(rows);
console.table(after.checks.map(check=>({check:check.name,pass:check.pass,settleMs:check.settleMs??null})));
if(!after.pass) process.exitCode=1;
