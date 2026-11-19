// Wraps tools/pages/*.html in the shared shell (template head, styles, sprite, header, footer) and writes
// site/<page>/index.html. Run after build-site.cjs: node tools/build-pages.cjs
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const CFG = require("./site-config.cjs");
require("./build-engine.cjs"); // /try imports the real engine from site/try/engine/
const shell = JSON.parse(fs.readFileSync(path.join(__dirname, ".shell.json"), "utf8"));
const DATE = new Date().toISOString().slice(0, 10);

const PAGE_CSS = `<style>
  body.sub{background:#000}
  .doc{padding:150px 0 110px}
  .wrap.narrow{max-width:860px}
  .doc h1.display{font-size:clamp(44px,6vw,84px);line-height:.95;margin-bottom:22px}
  .doc .lede{font-size:18px;color:var(--mercury);max-width:40em;margin-bottom:34px}
  .doc h2{font-family:var(--display);font-style:italic;font-weight:800;font-stretch:110%;font-size:clamp(24px,2.4vw,32px);color:var(--hi);margin:52px 0 14px;letter-spacing:-.01em;scroll-margin-top:100px}
  .doc h3{font-family:var(--display);font-style:italic;font-weight:700;font-size:19px;color:var(--hi);margin:30px 0 10px;scroll-margin-top:100px}
  .doc p,.doc li{font-size:16px;line-height:1.7;color:var(--mercury)}
  .doc p{margin-bottom:14px}
  .doc ul,.doc ol{padding-left:22px;margin-bottom:16px}
  .doc li{margin-bottom:6px}
  .doc a{color:var(--hi);text-decoration:underline;text-underline-offset:3px}
  .doc code{font:500 .88em var(--mono);color:var(--hi)}
  .doc pre{background:#060607;border:1px solid #1d1f22;padding:16px 18px;overflow-x:auto;margin:0 0 18px;font:500 13.5px/1.65 var(--mono);color:var(--hi)}
  .doc pre code{font-size:inherit}
  .doc table{width:100%;border-collapse:collapse;margin:0 0 20px;font-size:14.5px}
  .doc th,.doc td{text-align:left;padding:10px 12px 10px 0;border-top:1px solid var(--steel);color:var(--mercury);vertical-align:top}
  .doc th{color:var(--hi);font-weight:600}
  .docs-grid > *{min-width:0}
  .docs-grid article{max-width:780px}
  .doc h1.display{font-size:clamp(44px,5vw,72px)}
  .doc code{font-weight:400}
  .doc pre{font-weight:400;font-size:13px}
  .toc a{position:relative;transition:color .25s,padding-left .3s var(--ease)}
  .toc a.on{color:var(--hi);padding-left:14px}
  .toc a.on::before{content:"";position:absolute;left:0;top:50%;width:7px;height:7px;margin-top:-3.5px;background:var(--hi);clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%)}
  .rv{opacity:0;transform:translateY(14px);transition:opacity .7s ease,transform .7s var(--ease)}
  .rv.in{opacity:1;transform:none}
  @media (max-width:700px){.doc table{display:block;overflow-x:auto}.doc td,.doc th{min-width:110px}}
  .doc .updated{margin-top:40px;font-size:13px;color:var(--mute)}
  .docs-grid{display:grid;grid-template-columns:220px minmax(0,1fr);gap:56px}
  .toc{position:sticky;top:110px;align-self:start;font-size:14px}
  .toc a{display:block;color:var(--mute);text-decoration:none;padding:5px 0}
  .toc a:hover{color:var(--hi)}
  .toc b{display:block;color:var(--hi);margin:16px 0 4px;font-size:12px;letter-spacing:.12em;text-transform:uppercase}
  @media (max-width:900px){.docs-grid{grid-template-columns:1fr}.toc{position:static;display:none}.doc{padding-top:120px}}
</style>`;

const SCRIPT = `<script>
(function(){
  var b=document.body, btn=document.querySelector('.menu-btn'), menu=document.getElementById('menu');
  if(btn&&menu){ btn.addEventListener('click',function(){ var o=b.classList.toggle('menu-open'); btn.setAttribute('aria-expanded',o?'true':'false'); });
    menu.addEventListener('click',function(e){ if(e.target.closest('a')){ b.classList.remove('menu-open'); btn.setAttribute('aria-expanded','false'); } }); }
  var head=document.getElementById('siteHead'); if(head){ var on=function(){ head.classList.toggle('scrolled', scrollY>20); }; on(); addEventListener('scroll',on,{passive:true}); }
  document.querySelectorAll('.copy-btn').forEach(function(x){ x.addEventListener('click',function(){ if(!x.dataset.copy) return; navigator.clipboard&&navigator.clipboard.writeText(x.dataset.copy).then(function(){ x.textContent='Copied'; setTimeout(function(){ x.textContent='Copy'; },1600); }); }); });
  var top=document.querySelector('.to-top'); if(top) top.addEventListener('click',function(e){ e.preventDefault(); scrollTo({top:0,behavior:'smooth'}); });
  // docs: highlight the section in view, fade sections in as they arrive
  var toc=document.querySelector('.toc');
  if(toc&&'IntersectionObserver' in window){
    var links={}; toc.querySelectorAll('a[href^="#"]').forEach(function(a){ links[a.getAttribute('href').slice(1)]=a; });
    var io=new IntersectionObserver(function(es){ es.forEach(function(e){ if(e.isIntersecting&&links[e.target.id]){ toc.querySelectorAll('a.on').forEach(function(x){x.classList.remove('on');}); links[e.target.id].classList.add('on'); } }); },{rootMargin:'-20% 0px -70% 0px'});
    Object.keys(links).forEach(function(id){ var el=document.getElementById(id); if(el) io.observe(el); });
  }
  if('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches){
    var rv=new IntersectionObserver(function(es){ es.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add('in'); rv.unobserve(e.target); } }); },{rootMargin:'0px 0px -8% 0px'});
    document.querySelectorAll('.doc h2, .doc pre, .doc table').forEach(function(el){ el.classList.add('rv'); rv.observe(el); });
  }
})();
</script>`;

function wrap(file) {
  let body = fs.readFileSync(path.join(__dirname, "pages", file), "utf8");
  const m = /<!--meta title="([^"]*)" desc="([^"]*)"-->/.exec(body);
  if (!m) throw new Error(`${file}: missing meta comment`);
  body = body.replace(m[0], "").replaceAll("{{GITHUB}}", CFG.github).replaceAll("{{X}}", CFG.x).replaceAll("{{NPM}}", CFG.npm).replaceAll("{{DATE}}", DATE).replaceAll("{{CA}}", CFG.ca || "Posted here at launch");
  const head = shell.head.replaceAll("{{TITLE}}", m[1]).replaceAll("{{DESC}}", m[2]);
  return `${head}${shell.style}\n${PAGE_CSS}\n</head>\n<body class="sub ready">\n${shell.sprite}\n<a class="skip" href="#main">Skip to content</a>\n${shell.header}\n${body}\n${shell.footer}\n${SCRIPT}\n</body>\n</html>\n`;
}

const pages = fs.readdirSync(path.join(__dirname, "pages")).filter((f) => f.endsWith(".html"));
for (const f of pages) {
  const name = f.replace(/\.html$/, "");
  if (name === "404") { fs.writeFileSync(path.join(ROOT, "site", "404.html"), wrap(f)); console.log("site/404.html"); continue; }
  const dir = path.join(ROOT, "site", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), wrap(f));
  console.log(`site/${name}/index.html`);
}

// sitemap + robots (same shape as the reference: public pages listed, /api/ disallowed)
const SITE = CFG.site.replace(/\/$/, "");
const urls = ["/", "/docs/", "/try/", "/privacy/", "/terms/"];
fs.writeFileSync(path.join(ROOT, "site", "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${SITE}${u}</loc></url>`).join("\n")}\n</urlset>\n`);
fs.writeFileSync(path.join(ROOT, "site", "robots.txt"), `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE}/sitemap.xml\n`);
console.log("site/sitemap.xml, site/robots.txt");
