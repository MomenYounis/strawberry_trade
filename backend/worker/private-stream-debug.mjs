// workerd always enables util.debuglog, unlike Node's NODE_DEBUG opt-in.
// readable-stream sends Firestore response bodies to its "stream" logger.
// Install this before the SDK imports cache that logger; retain other logs.
import util from 'node:util';

const originalDebuglog=util.debuglog;
util.debuglog=function(section,callback) {
  if (typeof section !== 'string' || section.toLowerCase() !== 'stream') {
    return Reflect.apply(originalDebuglog,this,arguments);
  }
  const silent=()=>{};
  Object.defineProperty(silent,'enabled',{value:false});
  const lazySilent=()=>{
    // Match debuglog's deferred callback so a caller can safely replace its
    // own logger after the first call, without inspecting any payload args.
    if (typeof callback === 'function') {
      const notify=callback;
      callback=undefined;
      notify(silent);
    }
  };
  Object.defineProperty(lazySilent,'enabled',{value:false});
  return lazySilent;
};
