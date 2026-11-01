// Planning assumptions only. No SDK, credentials, network or billed-usage claims.
export const assumptions = Object.freeze({businesses:5,tradingDaysPerYear:365,
  readsPerSync:18,readsPerOperationAttempt:20,writesPerAcceptedOperation:7,
  writesPerSync:4,logicalChangesPerOperation:1.3,storedBytesPerOperation:6144,
  prospectiveRetainedBytesPerOperation:2048,archiveBytesPerOperation:2048,
  unrelatedStoredGiB:0,unrelatedReadsPerDay:0,unrelatedWritesPerDay:0,
  liveHeadroomFraction:0.30,archiveReadBudgetPerDay:2500,archiveWriteBudgetPerDay:500,
  archiveDeleteBudgetPerDay:0,chunkBytes:65536,archiveCopies:2});
export const scenarios = [
  {name:'low',employeesPerBusiness:1,operationsPerBusinessPerDay:50,syncsPerDevicePerDay:12,retryFraction:0.05,archiveDownloadsPerMonth:2},
  {name:'typical',employeesPerBusiness:3,operationsPerBusinessPerDay:200,syncsPerDevicePerDay:96,retryFraction:0.10,archiveDownloadsPerMonth:10},
  {name:'peak',employeesPerBusiness:8,operationsPerBusinessPerDay:1000,syncsPerDevicePerDay:720,retryFraction:0.30,archiveDownloadsPerMonth:50},
];
export function estimate(s,a=assumptions) {
 const devices=a.businesses*(1+s.employeesPerBusiness),dailyOps=a.businesses*s.operationsPerBusinessPerDay;
 const syncs=devices*s.syncsPerDevicePerDay,annualOps=dailyOps*a.tradingDaysPerYear;
 const feedReads=Math.ceil(dailyOps*a.logicalChangesPerOperation*(1+s.employeesPerBusiness));
 const reads=Math.ceil(syncs*a.readsPerSync+dailyOps*(1+s.retryFraction)*a.readsPerOperationAttempt+feedReads+a.unrelatedReadsPerDay);
 const writes=syncs*a.writesPerSync+dailyOps*a.writesPerAcceptedOperation+a.unrelatedWritesPerDay;
 const archiveBytes=annualOps*a.archiveBytesPerOperation;
 const chunks=Math.ceil(archiveBytes/a.chunkBytes)+a.businesses;
 return {...s,devices,dailyOps,syncs,annualOps,estimatedReadsPerDay:reads,estimatedWritesPerDay:writes,
   estimatedWorkerAndDORequestsPerDay:Math.ceil(syncs*3+dailyOps*(1+s.retryFraction)),
   activeGiBGrowthPerYear:annualOps*a.storedBytesPerOperation/2**30,
   currentPostCleanupGiBGrowthPerYear:annualOps*a.storedBytesPerOperation/2**30,
   hypotheticalRetainedOnlyGiBGrowthPerYear:annualOps*a.prospectiveRetainedBytesPerOperation/2**30,
   estimatedDaysUntil1GiB:(1-a.unrelatedStoredGiB)*2**30/(dailyOps*a.storedBytesPerOperation),
   archiveGBPerYearWithCopies:archiveBytes*a.archiveCopies/1e9,
   archiveClassAPutsPerYear:chunks*a.archiveCopies,
   archiveClassBGetsPerYear:chunks*(a.archiveCopies*2+12*s.archiveDownloadsPerMonth),
   exportSourceReadDaysAtBudget:Math.ceil(annualOps*a.logicalChangesPerOperation/a.archiveReadBudgetPerDay),
   withinReadHeadroom:reads<=50000*(1-a.liveHeadroomFraction),
   withinWriteHeadroom:writes<=20000*(1-a.liveHeadroomFraction)};
}
if(import.meta.url===new URL(process.argv[1],'file:').href) console.log(JSON.stringify({status:'UNMEASURED_PLANNING_ESTIMATE',assumptions,scenarios:scenarios.map(s=>estimate(s))},null,2));
