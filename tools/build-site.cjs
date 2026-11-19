// Builds the Nexorum home page from the user's template (ref/template.html), keeping its design 1:1
// (chrome N, liquid background, ribbons, 3D coin, pinned gallery, FAQ, wordmark) and mapping the
// sections onto the Archivum-style product page. Also writes tools/.shell.json, the shared shell that
// build-pages.cjs uses for /docs, /try, /privacy and /terms. Run: node tools/build-site.cjs
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const CFG = require("./site-config.cjs");
let h = fs.readFileSync(path.join(ROOT, "ref/template.html"), "utf8");
const rep = (a, b) => { const n = h.split(a).length - 1; if (n !== 1) throw new Error(`expected 1 match, got ${n}: ${a.slice(0, 90)}`); h = h.replace(a, () => b); };
const repAll = (a, b) => { if (!h.includes(a)) throw new Error("no match: " + a.slice(0, 90)); h = h.split(a).join(b); };
const sub = (re, b) => { if (!re.test(h)) throw new Error("no match: " + re); h = h.replace(re, () => b); };
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const caText = CFG.ca || "Posted here at launch";
const copyBtn = (v) => `<button class="copy-btn" type="button" data-copy="${esc(v)}"${v ? "" : " disabled"}>Copy</button>`;

// ---------- head ----------
rep("<title>NEXORUM — Design That Defines Your Brand</title>", "<title>Nexorum: linked memory for AI agents</title>");
rep('content="A professional graphic designer creating logos, packaging, UI/UX, and branding that help businesses stand out and grow."', `content="${esc(CFG.description)}"`);
rep('<meta property="og:title" content="NEXORUM — Design That Defines Your Brand">', '<meta property="og:title" content="Nexorum: linked memory for AI agents">');
rep('content="Logos, packaging, UI/UX, and branding that help businesses stand out and grow."', `content="${esc(CFG.description)}"`);
sub(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, `<script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","name":"Nexorum","url":"${CFG.site}","applicationCategory":"DeveloperApplication","operatingSystem":"macOS, Linux, Windows","description":"Local-first linked memory for AI agents: notes, transcripts and a small wiki, reviewed by dreams and approved by you.","offers":{"@type":"Offer","price":"0","priceCurrency":"USD"}}</script>`);

repAll("family=Archivo:ital,wdth,wght@0,62..125,100..900;1,62..125,100..900&display=swap", "family=Archivo:ital,wdth,wght@0,62..125,100..900;1,62..125,100..900&family=JetBrains+Mono:wght@400;500;600&display=swap");

{
  const OG = CFG.site.replace(/\/$/, "") + "/og.png";
  rep('<meta name="twitter:card" content="summary_large_image">', `<meta name="twitter:card" content="summary_large_image">\n<meta property="og:image" content="${OG}">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n<meta name="twitter:image" content="${OG}">`);
}

// ---------- nav ----------
rep('<li><a href="#services">Services</a></li>\n          <li><a href="#about">About</a></li>\n          <li><a href="#work">Work</a></li>\n          <li><a href="#process">Process</a></li>\n          <li><a href="#contact">Contact</a></li>',
  '<li><a href="#services">Features</a></li>\n          <li><a href="#about">Free</a></li>\n          <li><a href="#work">Install</a></li>\n          <li><a href="#process">How it works</a></li>\n          <li><a href="/docs/">Docs</a></li>');
rep('<li class="menu-extra"><a href="mailto:hello@nexorum.io">hello@nexorum.io</a><span>Available for new projects</span></li>',
  `<li class="menu-extra"><a href="/try/">Try the simulation</a><span>$NEXR · free and open source</span></li>`);
rep('<a class="status" href="#contact"><i></i>Available for projects</a>', '<a class="status" href="/try/"><i></i>Try the simulation</a>');

// ---------- hero ----------
rep('<h1 class="display"><span><i>Design that</i></span><span><i>defines your</i></span><span><i>brand.</i></span></h1>',
  '<span class="eyebrow"><b>MCP</b>Open source · MIT · zero dependencies</span><h1 class="display"><span><i>Give your agent</i></span><span><i>a memory</i></span><span><i>it keeps.</i></span></h1>');
rep("<p>I'm a graphic designer with over a decade of experience. I create logos, packaging, UI/UX, and branding that help businesses stand out and grow.</p>",
  `<p>Nexorum keeps what your agent learns as plain files on your machine: short notes, session transcripts and a small linked wiki. A background dream reviews them, corrects stale facts and proposes better memory. You read the diff and approve it.</p>
        <div class="actions boxes">
          <div class="cmd"><code><span>$</span> npx nexorum init<i class="caret" aria-hidden="true"></i></code>${copyBtn("npx nexorum init")}</div>
          <div class="cmd"><span class="lbl">CA</span><code class="ca">${esc(caText)}</code>${copyBtn(CFG.ca)}</div>
        </div>`);
rep('<a href="#contact" class="btn">Let\'s work together</a>', '<a href="/try/" class="btn">Try the simulation</a>');
rep('<a href="#work" class="text-link">See selected work</a>\n        </div>', '<a href="/docs/" class="text-link">Read the docs</a>\n        </div>\n        <p class="fine">Free and open source. No account. Nothing leaves your machine until you dream.</p>');
rep('aria-label="Available for new projects, start a project"', 'aria-label="Try the simulation"');
rep('<a class="badge" href="#contact"', '<a class="badge" href="/try/"');
rep('lengthAdjust="spacing">AVAILABLE FOR NEW PROJECTS ✦ 2026 ✦ </textPath>', 'lengthAdjust="spacing">MEMORY YOU APPROVE ✦ $NEXR ✦ </textPath>');

// ---------- ribbons ----------
for (const [a, b] of [["Branding", "Notes"], ["3D product design", "Transcripts"], ["Social media graphics", "Linked wiki"], ["UI/UX design", "Dreams"], ["Packaging design", "17 MCP tools"], ["Logo design", "You approve"]]) repAll(`<span class="item">${a}<svg`, `<span class="item">${b}<svg`);
rep('aria-label="Services overview"', 'aria-label="What Nexorum keeps"');

// ---------- features: what your agent gets (the 17 tools) ----------
rep('data-shine>What I do</h2>', 'data-shine>What your agent gets</h2>');
rep("Everything your brand needs to look consistent wherever it shows up, from the first sketch to the final file.",
  "17 MCP tools and a context resource. Notes are searchable right away; dreams turn them into a wiki you review.");
const T = (names) => `<p class="tools">${names.map((n) => `<code>${n}</code>`).join(" ")}</p>`;
rep("<h3>Logo design</h3><p>Timeless logos that build strong brand identities.</p>", `<h3>Notes</h3><p>Short memories the agent saves itself.</p>${T(["remember", "update_note", "forget", "list_notes"])}`);
rep("<h3>Packaging design</h3><p>Creative packaging and labels that make products stand out.</p>", `<h3>Recall</h3><p>BM25 search over notes and wiki pages.</p>${T(["recall", "search_documents"])}`);
rep("<h3>UI/UX design</h3><p>User-centered designs that deliver seamless digital experiences.</p>", `<h3>Context</h3><p>A short digest of the wiki, loaded at session start.</p>${T(["context", "nexorum://context"])}`);
rep("<h3>Social media graphics</h3><p>Scroll-stopping visuals that engage and grow your audience.</p>", `<h3>Wiki</h3><p>Plain markdown pages, linked from an index.</p>${T(["read_document", "list_documents", "related_documents", "document_history"])}`);
rep("<h3>3D product design</h3><p>Realistic 3D models and renders for modern brands.</p>", `<h3>Sessions</h3><p>Transcripts for later dreams, and the state of memory.</p>${T(["save_transcript", "memory_status"])}`);
rep("<h3>Branding</h3><p>Complete branding solutions that leave a lasting impression.</p>", `<h3>Dreams</h3><p>Review proposals, or dream through your agent with no key.</p>${T(["list_proposals", "show_proposal", "dream_prepare", "dream_submit"])}`);

{
  const ICONS = [
    '<path d="M7 3.5h10.5L22 8v16.5H7z"/><path d="M17.5 3.5V8H22"/><path d="M10.5 13h8M10.5 17h8M10.5 21h5"/>',
    '<circle cx="12.5" cy="12.5" r="7.5"/><path d="M18 18l6.5 6.5"/><path d="M9.5 12.5h6"/>',
    '<path d="M14 3.5 25 9l-11 5.5L3 9z"/><path d="M3 14l11 5.5L25 14"/><path d="M3 19l11 5.5L25 19"/>',
    '<circle cx="7" cy="8" r="3"/><circle cx="21" cy="8" r="3"/><circle cx="14" cy="21" r="3"/><path d="M10 8h8M8.6 10.6l3.8 7.8M19.4 10.6l-3.8 7.8"/>',
    '<rect x="3" y="5" width="22" height="18" rx="1.5"/><path d="M7.5 11l3.5 3-3.5 3M13.5 17.5h6"/>',
    '<path d="M19.5 18.8A9 9 0 0 1 10.2 5.5a9 9 0 1 0 9.3 13.3z"/><path d="M20.5 4.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>',
  ];
  const a = h.indexOf('<section class="block" id="services">'), b = h.indexOf("</section>", a);
  let i = 0;
  const block = h.slice(a, b).replace(/<svg viewBox="0 0 28 28"[\s\S]*?<\/svg>/g, () => `<svg viewBox="0 0 28 28" fill="none" stroke="url(#iconChrome)" stroke-linejoin="round" stroke-linecap="round">${ICONS[i++]}</svg>`);
  if (i !== 6) throw new Error("expected 6 service icons, got " + i);
  h = h.slice(0, a) + block + h.slice(b);
}

// ---------- about: free, and your data stays yours ----------
rep('data-shine>One designer, every detail.</h2>', 'data-shine>Free, and your data stays yours.</h2>');
rep("<p>Nexorum is my independent design practice. For over a decade I've helped businesses turn what they stand for into identities, packaging and interfaces people remember.</p>",
  "<p>Nexorum is open source software that runs on your machine. There is nothing to sign up for. Notes, transcripts, the wiki and its history are files under <code>~/.nexorum</code>; delete the folder and the memory is gone.</p>");
rep("<p>You work with me directly, from the first call to the final files, so nothing gets lost between a strategist, a designer and a developer.</p>",
  `<p>The only thing that costs money is the model you choose to dream with, and you pay that provider directly. A dream sends transcripts, notes and wiki pages to the LLM you configure, and nowhere else.</p>
          <table class="pay"><tr><td>The CLI and MCP server</td><td>MIT licence, runs on your machine</td><td>Free</td></tr><tr><td>Dreaming</td><td>your key, your budget</td><td>Your provider</td></tr><tr><td>Accounts, servers, telemetry</td><td>there are none</td><td>None</td></tr></table>`);
rep('<figcaption><span class="drag-hint">Drag to spin</span> The Nexorum coin</figcaption>', '<figcaption><span class="drag-hint">Drag to spin</span> The $NEXR coin</figcaption>');
rep('aria-label="The Nexorum coin in 3D.', 'aria-label="The $NEXR coin in 3D.');
rep('data-count="10" data-suffix="+">10+</strong><span>Years experience</span>', 'data-count="0" data-suffix="">0</strong><span>Accounts or servers</span>');
rep('data-count="500" data-suffix="+">500+</strong><span>Projects completed</span>', 'data-count="4" data-suffix="">4</strong><span>Memory layers</span>');
rep('data-count="300" data-suffix="+">300+</strong><span>Happy clients</span>', 'data-count="17" data-suffix="">17</strong><span>MCP tools</span>');
rep('data-count="100" data-suffix="%">100%</strong><span>Client satisfaction</span>', `data-count="${CFG.commands}" data-suffix="">${CFG.commands}</strong><span>CLI commands</span>`);

// ---------- install (was the work gallery): one card per client ----------
rep('data-shine>Selected work</h2>', 'data-shine>Install in one command</h2>');
rep("Recent projects across identity, packaging and digital. Select a project to see the details.",
  "<code>nexorum init</code> sets up the hooks and MCP server for the clients it finds. Or wire things by hand, as shown here. Select a card for what it changes.");
const card = (key, title, subt, lines) => `<figure class="work-item" data-reveal>
        <a class="card" href="/docs/#quickstart" data-case="${key}" aria-label="Install details: ${title}">
          <div class="term"><div class="term-bar"><i></i><i></i><i></i><span>${title}</span></div><pre>${lines.map((l) => l.startsWith("#") ? `<span class="c">${esc(l)}</span>` : esc(l)).join("\n")}</pre></div>
        </a>
        <figcaption><h3>${title}</h3><span>${subt}</span></figcaption>
      </figure>`;
sub(/<div class="hs"><div class="htrack">[\s\S]*?<a class="end-card" href="#contact">/, `<div class="hs"><div class="htrack">
      ${card("terminal", "Terminal", "every client it finds", ["# one command, every client it finds:", "# Claude Code, Codex, Hermes,", "# Cursor, Claude Desktop", "npx nexorum init", "", "# optional: install the command", "npm install -g nexorum", "", "# later: review what your", "# sessions taught the agent", "nexorum dream", "nexorum apply"])}
      ${card("claude", "Claude Code", "MCP + hooks", ["# the MCP server only", "claude mcp add nexorum -- \\", "  npx -y nexorum mcp", "", "# plus the hooks", "npm install -g nexorum", "nexorum init --claude-code \\", "  --prompt-recall"])}
      ${card("codex", "Codex", "MCP + AGENTS.md", ["codex mcp add nexorum -- \\", "  npx -y nexorum mcp", "", "# so Codex actually uses it:", "# a short block in this", "# project's AGENTS.md", "nexorum init --codex"])}
      ${card("hermes", "Hermes", "MCP", ["# init does this for you", "# when it finds Hermes; by hand:", "hermes mcp add nexorum \\", "  --command npx \\", "  --args -y nexorum mcp"])}
      ${card("mcp", "Any MCP client", "stdio JSON", ['{ "mcpServers": {', '  "nexorum": {', '    "command": "npx",', '    "args": ["-y", "nexorum", "mcp"]', "  }", "} }"])}
          <a class="end-card" href="/docs/#quickstart">`);
rep('<h3 class="display">Your brand could be next.</h3><span class="text-link">Start a project</span>', '<h3 class="display">Read the quickstart.</h3><span class="text-link">Open the docs</span>');
sub(/var data=\{\n      identity:[\s\S]*?\n    \};/, `var data={
      terminal:{cat:'Every client it finds',title:'npx nexorum init',desc:'Finds Claude Code, Codex, Hermes, Cursor and Claude Desktop and sets up the MCP server and hooks for each. Add --dry-run first to see what it would change; every file it edits is backed up.',list:['MCP server for each client','Claude Code hooks','AGENTS.md block for Codex','Backups: *.nexorum-bak']},
      claude:{cat:'Claude Code',title:'Hooks written by init',desc:'Written to ~/.claude/settings.json next to the MCP server.',list:['SessionStart: loads your context digest into the session','UserPromptSubmit: looks up memory before each prompt, only when it matches (optional)','Stop: saves the transcript for a later dream']},
      codex:{cat:'Codex',title:'What init --codex adds',desc:'Without the AGENTS.md block, Codex saves and recalls only when told to. With it, Codex recalls on its own. Your own text in the file is kept; a backup is written first.',list:['MCP server','A short AGENTS.md block','Backup of AGENTS.md']},
      hermes:{cat:'Hermes',title:'Hermes',desc:'Connects and lists all 17 tools. A pre_llm_call shell hook can run the same prompt recall.',list:['MCP server over stdio','Optional prompt recall hook']},
      mcp:{cat:'Standard MCP over stdio',title:'Any MCP client',desc:'Any client that speaks MCP over stdio gets the 17 tools and the nexorum://context resource. Not yet tested in every MCP client.',list:['17 tools','nexorum://context resource','One space per project']}
    };`);
rep('<a class="btn" href="#contact" id="caseCta">Start a similar project</a>', '<a class="btn" href="/docs/#quickstart" id="caseCta">Open the docs</a>');

// ---------- how it works ----------
rep('data-shine>How I work</h2>', 'data-shine>How it works</h2>');
rep("A clear process, so you always know what happens next and what I need from you.",
  "Your agent writes notes and its sessions are saved as transcripts. A dream looks back over them with hindsight and proposes updates to a small wiki. The next session starts from the approved version.");
rep("<h3>Discover</h3><p>We talk through your business, your audience and your goals, and I review everything you already have.</p>",
  "<h3>Your agent works</h3><p>Claude Code hooks or the MCP server save short notes and session transcripts to <code>~/.nexorum</code>. Known secret patterns are redacted before anything is written.</p>");
rep("<h3>Define</h3><p>I turn what we learned into a short creative direction that you approve before any design starts.</p>",
  "<h3>Memory is searchable</h3><p>Notes and wiki pages are ranked with BM25 keyword search, and the agent can follow links between pages from the index. No embeddings, no vector database.</p>");
rep("<h3>Design</h3><p>Concepts first, then focused refinement rounds until every detail is right.</p>",
  "<h3>A dream corrects it</h3><p><code>nexorum dream</code> checks the wiki against your transcripts, fixes stale or wrong facts, merges duplicates and links pages. It writes a proposal; nothing changes until you apply it.</p>");
rep("<h3>Deliver</h3><p>Final files, simple guidelines and support so your team can use the work with confidence.</p>",
  "<h3>The next session knows</h3><p>A short index of the wiki is loaded at session start, so your agent does not have to rediscover what earlier sessions already learned.</p>");

// ---------- FAQ ----------
rep(`Can't find what you need? Email <a href="mailto:hello@nexorum.io">hello@nexorum.io</a>.`, `More in the <a href="/docs/#faq">docs</a>, or ask us on <a href="${CFG.x}" target="_blank" rel="noopener">X</a>.`);
sub(/<div class="qa" data-reveal>[\s\S]*?\n    <\/div>\n  <\/section>/, `<div class="qa" data-reveal>
      <details open><summary>What does a dream change?<i aria-hidden="true"></i></summary>
        <div>Nothing, until you apply it. A dream writes a proposal: line diffs of every page it wants to add, change or delete. A page that changed since the dream started is skipped, not overwritten.</div></details>
      <details><summary>Do I need an API key?<i aria-hidden="true"></i></summary>
        <div>No. Use your own key (Anthropic by default, or any OpenAI-compatible endpoint, including a local router), or let the agent you already run do it through two MCP tools. Key runs are estimated first and stop at the token budget you set.</div></details>
      <details><summary>Where is my memory kept?<i aria-hidden="true"></i></summary>
        <div>In <code>~/.nexorum</code>, one space per project, as plain files. Open them in any editor, commit them to git, or delete the folder.</div></details>
      <details><summary>Are secrets safe?<i aria-hidden="true"></i></summary>
        <div>Known patterns such as API keys and tokens are replaced with [REDACTED] markers in transcripts, notes and anything a dream writes, before they reach disk. This catches known patterns, not everything.</div></details>
      <details><summary>What is $NEXR?<i aria-hidden="true"></i></summary>
        <div>The community token for Nexorum. You never need it to use the software.</div></details>
    </div>
  </section>`);

// ---------- get started ----------
rep('data-shine>Ready for a logo or design that truly represents your brand?</h2>', 'data-shine>Start in one command.</h2>');
rep("Tell me a little about your project and I'll reply within two working days.", "Or watch it work first: the simulation takes about a minute and runs in your browser.");
rep(`<a href="mailto:hello@nexorum.io"><span>hello@nexorum.io</span></a>
            <button class="copy-btn" type="button" data-copy="hello@nexorum.io">Copy</button>`, `<a href="/try/"><span>Try the simulation</span></a>`);
rep(`<a class="contact-line" href="https://nexorum.io" target="_blank" rel="noopener">`, `<a class="contact-line" href="${CFG.github}" target="_blank" rel="noopener">`);
rep("<span>nexorum.io</span>\n          </a>", "<span>GitHub</span>\n          </a>");
rep('<div class="contact-lines">', '<ul class="facts"><li>Free and open source, MIT</li><li>No account, no server, no telemetry</li><li>Plain files on your machine</li></ul>\n        <div class="contact-lines">');
sub(/<form class="inquiry" id="inquiry"[\s\S]*?<\/form>/, `<div class="inquiry start" data-reveal>
        <div class="field"><label>Install</label>
          <div class="cmd"><code><span>$</span> npx nexorum init</code>${copyBtn("npx nexorum init")}</div></div>
        <div class="field"><label>$NEXR contract address</label>
          <div class="cmd"><code class="ca">${esc(caText)}</code>${copyBtn(CFG.ca)}</div></div>
        <fieldset class="chips works"><legend>Works with</legend><div>
          <span>Claude Code</span><span>Codex</span><span>Hermes</span><span>Cursor</span><span>Claude Desktop</span><span>Any MCP client</span>
        </div></fieldset>
        <div class="form-foot">
          <a class="btn" href="/docs/">Read the docs</a>
          <p class="form-note">Local: notes, transcripts, wiki and history are files under ~/.nexorum. Dreaming sends them to the LLM you configure, and nowhere else.</p>
        </div>
      </div>`);
rep("var f=document.getElementById('inquiry'), note=document.getElementById('formNote');", "var f=document.getElementById('inquiry'), note=document.getElementById('formNote'); if(!f) return;");

// ---------- footer ----------
const FOOTER_SOCIAL = `<div class="social">
          <a href="${CFG.x}" target="_blank" rel="noopener" aria-label="X"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.8 3h3.1l-6.8 7.8L22 21h-6.2l-4.9-6.4L5.3 21H2.2l7.3-8.3L2 3h6.4l4.4 5.8L17.8 3zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5z"/></svg></a>
          <a href="${CFG.github}" target="_blank" rel="noopener" aria-label="GitHub"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.4-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.2-.4-1.3.1-2.7 0 0 .8-.3 2.8 1a9.6 9.6 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .6 1.4.2 2.5.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.3 4.7-4.6 5 .4.3.7.9.7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2z"/></svg></a>
          <a href="${CFG.npm}" target="_blank" rel="noopener" aria-label="npm">npm</a>
        </div>`;
rep("<p>Helping brands grow through meaningful design and creative solutions.</p>", "<p>Local-first memory for AI agents. Memory you approve.</p>");
sub(/<div class="social">[\s\S]*?<\/div>\n      <\/div>\n      <div><h4>Navigate<\/h4>/, `${FOOTER_SOCIAL}\n      </div>\n      <div><h4>Navigate</h4>`);
rep('<li><a href="#services">Services</a></li><li><a href="#about">About</a></li><li><a href="#work">Work</a></li><li><a href="#process">Process</a></li><li><a href="#faq">FAQ</a></li>',
  '<li><a href="/#process">How it works</a></li><li><a href="/#work">Install</a></li><li><a href="/#services">Features</a></li><li><a href="/#about">Free</a></li><li><a href="/#faq">FAQ</a></li>');
rep('<div><h4>Services</h4><ul><li><a href="#services">Logo design</a></li><li><a href="#services">Packaging design</a></li><li><a href="#services">UI/UX design</a></li><li><a href="#services">Social media graphics</a></li><li><a href="#services">3D product design</a></li><li><a href="#services">Branding</a></li></ul></div>',
  '<div><h4>Product</h4><ul><li><a href="/docs/">Docs</a></li><li><a href="/try/">Simulation</a></li><li><a href="/docs/#cli">CLI reference</a></li><li><a href="/docs/#mcp">MCP server</a></li><li><a href="/docs/#security">Security model</a></li></ul></div>');
sub(/<div><h4>Contact<\/h4><ul>[\s\S]*?<\/ul><\/div>/, `<div><h4>Community</h4><ul><li><a href="${CFG.x}" target="_blank" rel="noopener">X</a></li><li><a href="${CFG.github}" target="_blank" rel="noopener">GitHub</a></li><li><a href="${CFG.npm}" target="_blank" rel="noopener">npm</a></li><li><a href="/#contact">$NEXR</a></li></ul></div>`);
rep("<span>© 2026 Nexorum. All rights reserved.</span>", "<span>© 2026 Nexorum. Open source, MIT.</span>");
rep('<a href="#">Privacy policy</a><a href="#">Terms &amp; conditions</a>', '<a href="/privacy/">Privacy</a><a href="/terms/">Terms</a>');

// contact-line icons: mail -> play (simulation), globe -> GitHub
rep('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2.5" y="5" width="19" height="14" rx="1.5"/><path d="M3 6l9 7 9-7"/></svg>',
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="12" cy="12" r="9.5"/><path d="M10 8.5v7l6-3.5z" fill="currentColor"/></svg>');
rep('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5c2.8 2.8 4 6 4 9.5s-1.2 6.7-4 9.5c-2.8-2.8-4-6-4-9.5s1.2-6.7 4-9.5z"/></svg>',
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.4-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.2-.4-1.3.1-2.7 0 0 .8-.3 2.8 1a9.6 9.6 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .6 1.4.2 2.5.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.3 4.7-4.6 5 .4.3.7.9.7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2z"/></svg>');

// ---------- professional pass ----------
// no intro loader (go straight to the page) and the system cursor instead of the custom one
rep("var seen=false; try{ seen=sessionStorage.getItem('nx-intro')==='1'; sessionStorage.setItem('nx-intro','1'); }catch(e){}", "var seen=true;");
rep("if(finePointer && !reduce){\n    body.classList.add('has-cursor');", "if(false){\n    body.classList.add('has-cursor');");
// crossed ribbons -> a quiet "works with" strip
sub(/<!-- crossed ribbons -->\s*<div class="ribbons"[\s\S]*?<\/div><\/div>\s*<\/div>/,`<section class="clients" aria-label="Works with">
  <div class="wrap"><span class="kicker">Works with</span><ul><li>Claude Code</li><li>Codex</li><li>Cursor</li><li>Hermes</li><li>Claude Desktop</li><li>Any MCP client</li></ul></div>
</section>`);
// section kickers
for (const [title, kick] of [["What your agent gets", "Features"], ["Free, and your data stays yours.", "Pricing"], ["Install in one command", "Install"], ["How it works", "Workflow"], ["Questions, answered", "FAQ"], ["Start in one command.", "Get started"]]) {
  rep(`<h2 class="display split" data-shine>${title}</h2>`, `<span class="kicker">${kick}</span><h2 class="display split" data-shine>${title}</h2>`);
}
// an example terminal session under "How it works"
rep("  <!-- FAQ -->", `  <figure class="demo" data-reveal>
    <div class="demo-bar"><i></i><i></i><i></i><span>~/projects/orbit-api</span><em>example session</em></div>
<pre><span class="p">$</span> nexorum remember "Run tests with pnpm test:unit, not npm test"
<span class="o">Saved note note_7Qm2xK9vTq.</span>
<span class="p">$</span> nexorum dream
<span class="o">Pending transcripts: 3
Unconsolidated notes: 4
Rough estimate: ~180,000 tokens (budget 3,000,000). This is billed by your LLM provider.
Proceed? [y/N]</span> y
<span class="o">Proposal prop_8f2c41 (review): 2 added, 2 modified, 0 removed
  added    /ci.md
  added    /config.md
  modified /testing.md
  modified /_index.md</span>
<span class="p">$</span> nexorum diff
<span class="o">~ /testing.md</span>
<span class="d">- Tests: \`npm test\` (jest)</span>
<span class="a">+ Tests: \`pnpm test:unit\` (vitest), since 2026-11-19</span>
<span class="p">$</span> nexorum apply
<span class="o">Applied: 4 path(s) written.</span></pre>
    <figcaption>Notes are searchable right away. The wiki only changes when you run <code>nexorum apply</code>.</figcaption>
  </figure>

  <!-- FAQ -->`);

// ---------- safety principles (the reference's "memory that gets reviewed" feature block) ----------
{
  const P = (icon, title, body) => `<article class="svc" data-reveal><div class="svc-in"><svg viewBox="0 0 28 28" fill="none" stroke="url(#iconChrome)" stroke-linejoin="round" stroke-linecap="round">${icon}</svg><h3>${title}</h3><p>${body}</p></div></article>`;
  rep("  <!-- FAQ -->", `  <section class="block principles" id="principles">
    <div class="head"><div><span class="kicker">Safety</span><h2 class="display split" data-shine>Memory that gets reviewed, not just stored</h2>
      <p class="lede">Notes are searchable right away. Dreams turn notes and transcripts into a small wiki and propose fixes. You decide what is applied, and everything stays in files you own.</p></div></div>
    <div class="svc-grid">
      ${P('<circle cx="7" cy="8" r="3"/><circle cx="21" cy="8" r="3"/><circle cx="14" cy="21" r="3"/><path d="M10 8h8M8.6 10.6l3.8 7.8M19.4 10.6l-3.8 7.8"/>', "A wiki your agent can navigate", "Plain markdown files in <code>~/.nexorum</code>, linked to each other, with an <code>_index.md</code> that lists them. Open them in any editor, or let the agent follow the links.")}
      ${P('<path d="M14 4v6M14 18v6"/><circle cx="14" cy="14" r="4"/><path d="M5 14h5M18 14h5"/>', "Every change is a version", "Each write to the live wiki, from a dream you applied or from you, is recorded. See the history of a page and restore an earlier version.")}
      ${P('<rect x="4" y="5" width="20" height="18" rx="1.5"/><path d="M9 11l3 3 7-7"/><path d="M9 18h10"/>', "0 changes without you", "A dream only writes a proposal. Nothing reaches the live wiki until you run <code>nexorum apply</code>, and a page changed since the dream started is skipped.")}
      ${P('<circle cx="10" cy="14" r="4.5"/><path d="M14.5 14H25M21 14v4M24.5 14v3"/>', "Dream with a key, or without one", "Use your own key (Anthropic by default, or any OpenAI-compatible endpoint), or let the agent you already run dream through two MCP tools. Key runs are estimated first and stop at your budget.")}
      ${P('<path d="M14 3.5 23 7v6.5c0 5.2-3.8 9.3-9 11-5.2-1.7-9-5.8-9-11V7z"/><path d="M10 14l3 3 5-6"/>', "Secrets are scrubbed", "API keys, tokens and private keys are replaced with <code>[REDACTED]</code> markers in transcripts, notes and anything a dream writes, before they reach disk.")}
      ${P('<path d="M6 4h11l5 5v15H6z"/><path d="M10 13h8M10 17h4"/><path d="M17 4v5h5"/>', "Review, diff, apply or reject", "Read the line diff against your live wiki, then apply or reject it. The agent can read proposals but never apply them.")}
    </div>
  </section>

  <!-- FAQ -->`);
}

// ---------- extra styles ----------
h = h.replace("</style>", () => fs.readFileSync(path.join(__dirname, "site-extra.css"), "utf8") + "\n</style>");

// ---------- write ----------
const out = path.join(ROOT, "site");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "index.html"), h);

// shared shell for the other pages
const style = h.slice(h.indexOf("<style>"), h.indexOf("</style>") + 8);
const spriteStart = h.indexOf('<svg width="0" height="0" style="position:absolute" aria-hidden="true">');
const sprite = h.slice(spriteStart, h.indexOf("</svg>", h.indexOf("</defs>", spriteStart)) + 6);
const head = h.slice(0, h.indexOf("<style>"))
  .replace(/<title>[\s\S]*?<\/title>/, "<title>{{TITLE}}</title>")
  .replace(/<meta name="description" content="[^"]*">/, '<meta name="description" content="{{DESC}}">')
  .replace(/<meta property="og:title" content="[^"]*">/, '<meta property="og:title" content="{{TITLE}}">')
  .replace(/<meta property="og:description" content="[^"]*">/, '<meta property="og:description" content="{{DESC}}">')
  .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, "");
const header = h.slice(h.indexOf('<header class="site-head"'), h.indexOf("</header>") + 9).replace(/href="#(process|work|services|about)"/g, 'href="/#$1"').replace('href="#top" class="logo"', 'href="/" class="logo"');
const footer = h.slice(h.indexOf('<footer class="site-foot">'), h.indexOf("</footer>") + 9).replace('href="#top" class="logo"', 'href="/" class="logo"').replace('href="#top" class="to-top"', 'href="#" class="to-top"');
fs.writeFileSync(path.join(__dirname, ".shell.json"), JSON.stringify({ head, style, sprite, header, footer }));
console.log("site/index.html", Math.round(h.length / 1024) + " KB, shell written");
