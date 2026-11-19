// Renders site/og.png (1200x630) from the live home page hero. Needs the site server running on :5210.
const {chromium}=require(process.env.PLAYWRIGHT_PATH||"playwright"); // set PLAYWRIGHT_PATH if playwright is installed elsewhere
(async()=>{const b=await chromium.launch({channel:"chrome"});const p=await b.newPage({viewport:{width:1600,height:840},deviceScaleFactor:0.75});
await p.goto("http://127.0.0.1:5210/",{waitUntil:"load"});await p.waitForTimeout(4500);
await p.addStyleTag({content:".site-head,.hero .boxes,.hero .actions,.hero .fine,.badge{display:none!important}.hero{min-height:840px!important;max-height:none!important;padding:0!important}.hero p{max-width:28em}"});
await p.waitForTimeout(800);await p.screenshot({path:require("path").join(__dirname,"..","site","og.png")});
await b.close();console.log("site/og.png")})()
