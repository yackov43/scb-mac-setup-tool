// One queue per native identity, shared by onboarding and folder verifiers in this process.
export function createNativeReportGate({now=Date.now,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 const states=new Map();
 return (key,operation,send)=>{
  let state=states.get(key);if(!state){state={tail:Promise.resolve(),last:null,minute:[]};states.set(key,state);}
  const run=state.tail.catch(()=>{}).then(async()=>{
   let time=now();state.minute=state.minute.filter(at=>time-at<60000);
   const wait=Math.max(!operation&&state.last!==null?state.last+15100-time:0,state.minute.length>=12?state.minute[0]+60100-time:0,0);
   if(wait)await pause(wait);
   time=now();state.last=time;state.minute=state.minute.filter(at=>time-at<60000);state.minute.push(time);
   try{return await send();}
   finally{state.last=now();state.minute[state.minute.length-1]=state.last;}
  });
  state.tail=run;return run;
 };
}
export const gateNativeReport=createNativeReportGate();
