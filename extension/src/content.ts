// #95: tell the worker this top-frame SDU document finished loading (content scripts run at
// document_idle). The worker trusts the URL only from the browser's sender data; the page's
// own `course-<id>` class is a hint the fetched page must match. Nothing is parsed, fetched or
// stored here; the worker reads the page through the live scan's rules (extension/src/page-visit.ts).
declare const chrome:{runtime:{sendMessage:(message:unknown,reply:()=>void)=>void;lastError?:unknown}};
if(window.top===window&&location.origin==='https://moodle.sdu.edu.kz'){
  const course=/(?:^|\s)course-([1-9][0-9]{0,18})(?:\s|$)/.exec(document.body?.className??'')?.[1];
  try {chrome.runtime.sendMessage({source:'moodle-helper-page-visit',version:'1',...(course?{sourceCourseId:course}:{})},()=>void chrome.runtime.lastError);}
  catch {/* extension reloaded: nothing to do */}
}
