import assert from 'node:assert/strict';
import { ApiClient } from '../src/services/api-client.js';
import { MetricsCollector } from '../src/services/metrics.js';
import { getAutoAcceptVerificationRunner, submitDurableAutoAccept, stopAutoAcceptVerificationRecovery } from '../src/services/notifier.js';
import { listAutoAcceptVerificationJobs } from '../src/repositories/auto-accept-verification-repository.js';
import { getDb,closePool } from '../src/db/client.js';
import { notifyRules } from '../src/db/schema.js';
import type { AutoAcceptVerificationJob } from '../src/services/auto-accept-verifier.js';
import { env } from '../src/config/env.js';
async function main(){
 const oldFetch=globalThis.fetch;const saved={...env}; Object.assign(env,{API_URL:'https://provider.example.test/booking/bidding/list',SPX_ROLE:'monolith'});
 const collector=new MetricsCollector({teamId:2}); const other=new MetricsCollector({teamId:1});
 const api=new ApiClient({credentials:{spxCookie:'synthetic',spxDeviceId:'synthetic'},metricsCollector:collector});
 let canRun=true; let posts=0; let readStart=0; let dispatchAt=0;
 const options={teamId:2,metricsCollector:collector,canVerify:()=>canRun};
 await getDb().insert(notifyRules).values({id:'stage-rule',teamId:2,name:'synthetic',origins:'[]',destinations:'[]',vehicleTypes:'[]',need:1});
 globalThis.fetch=async(url)=>{
  if(String(url).includes('accept')){posts++;dispatchAt=Date.now();canRun=false;return Response.json({retcode:0,message:'',data:{}})}
  readStart ||= Date.now(); return Response.json({retcode:0,message:'',data:{pageno:1,count:1,total:1,request_list:[{booking_id:808,request_id:809,request_acceptance_status:2}]}});
 };
 const matchedAt=Date.now();const job:AutoAcceptVerificationJob={teamId:2,ruleId:'stage-rule',ruleName:'synthetic',bookingId:808,requestIds:[809],trips:[{request_id:809,booking_id:808}],claimToken:0,acceptResult:{ok:false,httpStatus:0},acceptStartedAt:matchedAt,acceptFinishedAt:matchedAt,acceptRttMs:0,ambiguousAccept:true,acceptAll:false,traceId:'stage-delayed-prepare'};
 try{
  const runner=getAutoAcceptVerificationRunner(api,options);const prepare=runner.prepare.bind(runner);
  runner.prepare=async(...args)=>{await new Promise(resolve=>setTimeout(resolve,60));return prepare(...args)};
  await submitDurableAutoAccept(api,job,{...options,firstMatchedAtMs:matchedAt});await runner.idle();
  assert.equal(posts,1);const stage=collector.snapshot().operations.firstMatchToAcceptStart;
  assert.equal(stage.count,1);assert.ok(stage.lastMs!>=60,'match-to-dispatch includes durable prepare');
  assert.ok(collector.snapshot().operations.acceptRtt.lastMs!<stage.lastMs!,'accept RTT excludes durable prepare');
  const [persisted]=await listAutoAcceptVerificationJobs(2);assert.ok(persisted);
  assert.ok(persisted.job.acceptFinishedAt>=dispatchAt);
  await stopAutoAcceptVerificationRecovery(api,2);
  canRun=true;
  const restored=getAutoAcceptVerificationRunner(api,options);
  (api as unknown as {readScheduler:{deferFor(ms:number):void}}).readScheduler.deferFor(80);
  const readAdmissionAt=api.getRateLimitRetryAt();
  await restored.runDue();await restored.idle();
  assert.ok(readStart>=persisted.job.acceptFinishedAt);
  assert.equal(collector.snapshot().operations.verificationQueueWait.count,1,'dual-tab reads contribute one queue interval');
  const sampledReadAt=persisted.job.acceptFinishedAt+collector.snapshot().operations.verificationQueueWait.lastMs!;
  assert.ok(sampledReadAt>=readAdmissionAt && sampledReadAt<=readStart,'queue interval starts at persisted completion and ends at admitted provider dispatch before fetch');
  assert.ok(collector.snapshot().operations.verificationQueueWait.lastMs!>=70,'provider admission wait belongs in queue wait');
  assert.equal(other.snapshot().operations.verificationQueueWait.count,0);assert.equal(posts,1,'restoration never replays POST');
  const before=collector.snapshot().operations.firstMatchToAcceptStart.count;
  canRun=false;await assert.rejects(submitDurableAutoAccept(api,{...job,traceId:'denied'}, {...options,firstMatchedAtMs:matchedAt}));
  assert.equal(collector.snapshot().operations.firstMatchToAcceptStart.count,before,'denied preparation records zero dispatch samples');
  console.log('durable-stage-metrics: delayed prepare, isolated RTT, restored owning-team read/admission queue interval and denied zero dispatch passed');
 }finally{await stopAutoAcceptVerificationRecovery(api,2);globalThis.fetch=oldFetch;Object.assign(env,saved);await closePool()}
}
main().catch(error=>{console.error(error);process.exitCode=1});
