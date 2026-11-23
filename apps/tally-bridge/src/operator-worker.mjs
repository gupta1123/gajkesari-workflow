const equalText=(a,b)=>String(a??"").trim().toLowerCase()===String(b??"").trim().toLowerCase();

export function summarizeDashboard(dashboard,job,customers,buckets) {
  const {customer,invoice}=job.parameters;
  const matches=(row)=>(!customer || equalText(customer,row.partyLedgerName)) && (!invoice || equalText(invoice,row.linkedInvoiceNumber));
  const evidence=dashboard.narrationAnalysis.filter(matches);
  const recoveries=dashboard.tabs.debitNoteQueue.filter(r=>r.status!=="created_in_tally" && matches(r));
  const followups=dashboard.tabs.paymentFollowUps.filter(matches);
  const confirmed=followups.filter(r=>r.followUpStatus!=="needs_review");
  const reasons={};
  for(const row of evidence){const key=row.analysis.deterministicStatus;reasons[key]=(reasons[key]||0)+1;}
  const common={source:"Fresh Tally scan",company:job.dataset.company_name,financialYear:job.dataset.financial_year,
    checkedAt:new Date().toISOString(),scopedCustomers:customers.length,openBills:Object.values(buckets).reduce((n,b)=>n+(b.openBills?.length||0),0),
    customer:customer||null,invoice:invoice||null,analyzedInvoices:evidence.length};
  if(job.operation==="followups")return {...common,confirmedInvoices:confirmed.length,needsReview:followups.length-confirmed.length,
    confirmedOutstanding:confirmed.reduce((n,r)=>n+r.outstandingAmount,0),overdue1to30:confirmed.filter(r=>r.ageDays>0&&r.ageDays<=30).length,
    overdue31plus:confirmed.filter(r=>r.ageDays>30).length,rows:followups.slice(0,30).map(r=>({customer:r.partyLedgerName,invoice:r.linkedInvoiceNumber,
      outstanding:r.outstandingAmount,ageDays:r.ageDays,status:r.followUpStatus})),totalFollowups:followups.length};
  return {...common,invoicesWithTerms:evidence.filter(r=>r.analysis.terms.length).length,recoveryCandidates:recoveries.length,
    recoverable:recoveries.reduce((n,r)=>n+r.recoverableAmount,0),reasons,
    createdDebitNotes:dashboard.tabs.debitNoteQueue.filter(r=>r.status==="created_in_tally"&&matches(r)).length,
    evidence:evidence.slice(0,20).map(r=>({customer:r.partyLedgerName,invoice:r.linkedInvoiceNumber,invoiceDate:r.linkedInvoiceDate,
      original:r.originalInvoiceAmount,outstanding:r.pendingAmount,terms:r.analysis.termsLabel,deadline:r.analysis.discountDeadline,
      receiptDate:r.analysis.receiptDate,paid:r.analysis.matchedReceiptAmount,reason:r.analysis.deterministicReason,
      recovery:recoveries.find(c=>equalText(c.partyLedgerName,r.partyLedgerName)&&equalText(c.linkedInvoiceNumber,r.linkedInvoiceNumber))?.recoverableAmount??0}))};
}

export function startOperatorWorker(config,{run,afterUpdate,log}) {
  let stopped=false,busy=false;
  const lifecycle=new AbortController();
  const request=async(body)=>{
    const response=await fetch(config.apiBase+"/api/connector-operator-worker",{method:"POST",
      headers:{"Content-Type":"application/json",Authorization:"Bearer "+config.bridgeToken},
      body:JSON.stringify({connectionId:config.connectionId,generation:config.sessionGeneration,...body}),
      signal:AbortSignal.any([lifecycle.signal,AbortSignal.timeout(25000)])});
    if(!response.ok)throw Error("Support service returned HTTP "+response.status);
    return response.json();
  };
  const tick=async()=>{
    if(stopped||busy)return;
    busy=true;
    try{
      const {job}=await request({action:"poll"});
      if(!job)return;
      const key={id:job.id,claim:job.claim};
      const abort=new AbortController();
      const signal=AbortSignal.any([lifecycle.signal,abort.signal,AbortSignal.timeout(13*60_000)]);
      let phase="Waiting for current Tally work",reporting=false;
      const timer=setInterval(async()=>{
        if(reporting)return;
        reporting=true;
        try{await request({...key,action:"progress",progress:phase});}catch{abort.abort();}
        finally{reporting=false;}
      },12000);
      let result;
      try{
        result=await run(job,signal,value=>{phase=value;});
        signal.throwIfAborted();
      }catch(e){
        await request({...key,action:"finish",error:String(e.message||"Support operation failed").replace(/https?:\/\/\S+/gi,"[address]").slice(0,300)});
        return;
      }finally{clearInterval(timer);}
      const receipt=await request({...key,action:"finish",result});
      if(job.operation==="update" && receipt.accepted){
        try {
          await afterUpdate(job.parameters.version, async () => {
            const authorization = await request({...key,action:"authorize_restart"});
            if (!authorization.accepted) throw Error("Release request expired.");
          });
        } catch (error) {
          await request({...key, action:"restart_failed"});
          throw error;
        }
      }
    }catch(e){if(!stopped)log(e.message);}
    finally{busy=false;}
  };
  const timer=setInterval(()=>void tick(),15000);
  timer.unref?.();
  return ()=>{stopped=true;lifecycle.abort();clearInterval(timer);};
}
