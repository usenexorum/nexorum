// Site QA: every page x viewport -> console errors, failed requests, overflow, links/anchors, a11y basics.
// Needs the site server on :5210. Run: node tools/qa.cjs
const {chromium}=require(process.env.PLAYWRIGHT_PATH||"playwright"); // set PLAYWRIGHT_PATH if playwright is installed elsewhere
const BASE="http://127.0.0.1:5210", PAGES=["/","/docs/","/try/","/privacy/","/terms/","/404-check/"], VPS=[360,768,1024,1440,1920];
(async()=>{const b=await chromium.launch({channel:"chrome"});const issues=[];const seenLinks=new Set();
for(const pg of PAGES)for(const w of VPS){const p=await b.newPage({viewport:{width:w,height:900}});const errs=[];
 p.on("pageerror",e=>errs.push("js: "+e.message));p.on("console",m=>{if(m.type()==="error"&&!/404 \(Not Found\)/.test(m.text()))errs.push("console: "+m.text().slice(0,140))});
 p.on("requestfailed",q=>{if(!/fonts\.g|unpkg/.test(q.url()))errs.push("failed: "+q.url())});
 p.on("response",res=>{if(res.status()>=400&&!res.url().includes("404-check"))errs.push(res.status()+" "+res.url())});
 await p.goto(BASE+pg,{waitUntil:"load"});await p.waitForTimeout(1500);
 const H=await p.evaluate(()=>document.documentElement.scrollHeight);for(let y=0;y<H;y+=700){await p.evaluate(y=>scrollTo(0,y),y);await p.waitForTimeout(40)}
 const res=await p.evaluate(()=>{const out={};const vw=innerWidth;
  out.overflow=document.documentElement.scrollWidth>vw+1?[...document.querySelectorAll("body *")].filter(e=>{const r=e.getBoundingClientRect();return r.right>vw+1&&getComputedStyle(e).position!=="fixed"}).slice(0,3).map(e=>e.tagName+"."+(e.className+"").slice(0,30)):[];
  out.h1=document.querySelectorAll("h1").length;
  const ids=[...document.querySelectorAll("[id]")].map(e=>e.id);out.dupIds=[...new Set(ids.filter((x,i)=>ids.indexOf(x)!==i))];
  out.imgNoAlt=[...document.querySelectorAll("img:not([alt])")].length;
  out.btnNoName=[...document.querySelectorAll("button,a[href]")].filter(e=>{const s=getComputedStyle(e);if(s.display==="none"||s.visibility==="hidden")return false;return !(e.innerText.trim()||e.getAttribute("aria-label")||e.title||e.querySelector("img[alt]"))}).map(e=>e.outerHTML.slice(0,80)).slice(0,3);
  out.badAnchors=[...document.querySelectorAll('a[href^="#"]')].map(a=>a.getAttribute("href")).filter(h=>h.length>1&&!document.getElementById(h.slice(1)));
  out.deadHash=[...document.querySelectorAll('a[href="#"]')].filter(a=>!a.classList.contains("to-top")).length;
  out.extNoRel=[...document.querySelectorAll('a[target="_blank"]')].filter(a=>!/noopener/.test(a.rel)).length;
  out.links=[...document.querySelectorAll("a[href]")].map(a=>a.getAttribute("href")).filter(h=>h.startsWith("/"));
  out.tinyText=[...document.querySelectorAll("p,li,span,a,td,small")].filter(e=>e.offsetParent&&e.innerText.trim()&&parseFloat(getComputedStyle(e).fontSize)<11).length;
  return out;});
 res.links.forEach(l=>seenLinks.add(l.split("#")[0]||"/"));
 const tag=pg+"@"+w;
 if(errs.length)issues.push(tag+" errors: "+[...new Set(errs)].join(" ; "));
 if(res.overflow.length)issues.push(tag+" overflow: "+res.overflow.join(", "));
 if(w===1440){ if(res.h1!==1)issues.push(tag+" h1 count "+res.h1); if(res.dupIds.length)issues.push(tag+" duplicate ids "+res.dupIds.join(",")); if(res.imgNoAlt)issues.push(tag+" img without alt "+res.imgNoAlt);
  if(res.btnNoName.length)issues.push(tag+" unnamed controls "+res.btnNoName.join(" | ")); if(res.badAnchors.length)issues.push(tag+" missing anchors "+[...new Set(res.badAnchors)].join(","));
  if(res.deadHash)issues.push(tag+" href=# links "+res.deadHash); if(res.extNoRel)issues.push(tag+" target=_blank without noopener "+res.extNoRel); if(res.tinyText)issues.push(tag+" text under 11px: "+res.tinyText);}
 await p.close();}
for(const l of seenLinks){const s=(await fetch(BASE+l)).status;if(s!==200)issues.push("internal link "+l+" -> "+s)}
console.log(issues.length?issues.join("\n"):"no issues");console.log("checked",PAGES.length,"pages x",VPS.length,"viewports,",seenLinks.size,"internal links");await b.close()})()
