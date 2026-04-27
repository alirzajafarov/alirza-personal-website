const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── CONFIG ───
const PORT = 3001;
const DATA_DIR = path.join(__dirname, 'data', 'posts');
const USERS_FILE = path.join(__dirname, 'data', 'users.json');
const SESSIONS = {};
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(path.dirname(USERS_FILE))) fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });

// Create default admin user if not exists
if (!fs.existsSync(USERS_FILE)) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync('admin123', salt, 64).toString('hex');
  fs.writeFileSync(USERS_FILE, JSON.stringify([
    { username: 'alirza', passwordHash: hash, salt }
  ], null, 2));
  console.log('Default admin created: alirza / admin123 — CHANGE THIS PASSWORD!');
}

// ─── HELPERS ───
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve(body); }
    });
    req.on('error', reject);
  });
}

function respond(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  });
  res.end(JSON.stringify(data));
}

function authenticate(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const session = SESSIONS[token];
  if (!session) return null;
  if (Date.now() - session.created > SESSION_TTL) {
    delete SESSIONS[token];
    return null;
  }
  return session.username;
}

function generateSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 80);
}

function getAllPosts() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
    return data;
  }).sort((a, b) => new Date(b.date) - new Date(a.date));
}

function getPublishedPosts() {
  return getAllPosts().filter(p => p.status === 'published');
}

// ─── REBUILD STATIC FILES ───
function rebuildJournalIndex() {
  const posts = getPublishedPosts();
  const indexData = posts.map(p => ({
    slug: p.slug,
    title: p.title,
    subtitle: p.subtitle || '',
    date: p.date,
    tags: p.tags || [],
    readTime: Math.ceil((p.content || '').split(/\s+/).length / 200) + ' min read'
  }));
  
  // Write posts index JSON for the journal page to fetch
  fs.writeFileSync(
    path.join(__dirname, 'data', 'posts-index.json'),
    JSON.stringify(indexData, null, 2)
  );
  
  // Rebuild each post's HTML
  posts.forEach(post => {
    const html = generatePostHTML(post);
    const postDir = path.join(__dirname, 'journal');
    if (!fs.existsSync(postDir)) fs.mkdirSync(postDir, { recursive: true });
    fs.writeFileSync(path.join(postDir, `${post.slug}.html`), html);
  });
  
  console.log(`Rebuilt index: ${posts.length} published posts`);
  
  // Rebuild sitemap.xml
  const sitemapEntries = posts.map(p => `  <url>
    <loc>https://alirza.com/journal/${p.slug}.html</loc>
    <lastmod>${p.date}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>`).join('\n');
  
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://alirza.com/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://alirza.com/journal/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
${sitemapEntries}
</urlset>`;
  fs.writeFileSync(path.join(__dirname, 'sitemap.xml'), sitemap);
  
  // Rebuild RSS feed
  const rssItems = posts.slice(0, 20).map(p => {
    const dateObj = new Date(p.date + 'T12:00:00Z');
    return `    <item>
      <title>${escHTML(p.title)}</title>
      <link>https://alirza.com/journal/${p.slug}.html</link>
      <guid>https://alirza.com/journal/${p.slug}.html</guid>
      <pubDate>${dateObj.toUTCString()}</pubDate>
      <description>${escHTML(p.subtitle || '')}</description>
      ${(p.tags || []).map(t => `<category>${escHTML(t)}</category>`).join('\n      ')}
    </item>`;
  }).join('\n');
  
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Alirza Jafarov — Journal</title>
    <link>https://alirza.com/journal/</link>
    <description>Thoughts on geopolitics, markets, crypto, and visual storytelling.</description>
    <language>en</language>
    <atom:link href="https://alirza.com/feed.xml" rel="self" type="application/rss+xml"/>
${rssItems}
  </channel>
</rss>`;
  fs.writeFileSync(path.join(__dirname, 'feed.xml'), rss);
  console.log('Sitemap and RSS feed rebuilt');
}

function generatePostHTML(post) {
  const readTime = Math.ceil((post.content || '').split(/\s+/).length / 200);
  const dateStr = new Date(post.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const tagsHTML = (post.tags || []).map(t => `<span>${t}</span>`).join('\n    ');
  
  // Convert markdown to basic HTML
  let contentHTML = markdownToHTML(post.content || '');
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHTML(post.title)} — Alirza Jafarov</title>
<meta name="description" content="${escHTML(post.subtitle || '')}">
<meta property="og:title" content="${escHTML(post.title)}">
<meta property="og:description" content="${escHTML(post.subtitle || '')}">
<meta property="og:type" content="article">
<meta property="article:author" content="Alirza Jafarov">
<meta property="article:published_time" content="${post.date}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#033f26">
<meta name="color-scheme" content="dark light">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=DM+Sans:wght@300;400;500&family=Lora:ital,wght@0,400;0,500;1,400&display=swap" rel="stylesheet">
<style>.lang-switch{display:flex;align-items:center;gap:0;margin-left:1rem}.lang-switch a{padding:.3rem .6rem;font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;color:#5a5550;text-decoration:none;border:1px solid transparent}.lang-switch a.active{color:#ebebd9;border-color:#1e1e1e}.lang-switch span{color:#1e1e1e;font-size:.6rem;margin:0 .1rem}</style>
<link rel="stylesheet" href="/css/article.css">
<style>
nav{position:fixed;top:0;left:0;right:0;z-index:100;padding:1.5rem 3rem;padding-top:max(1.5rem,env(safe-area-inset-top));display:flex;justify-content:space-between;align-items:center;transition:all .5s cubic-bezier(.16,1,.3,1);background:rgba(10,10,10,.95);backdrop-filter:blur(24px);border-bottom:1px solid var(--border)}
nav.scrolled{background:rgba(10,10,10,.9);backdrop-filter:blur(24px);border-bottom:1px solid var(--border);padding:1rem 3rem}
.nav-logo{display:flex;align-items:center;gap:.6rem;text-decoration:none}
.nav-logo-img{height:26px;width:26px;transition:opacity .3s;border-radius:50%;object-fit:cover}
.nav-logo:hover .nav-logo-img{opacity:.8}
.nav-logo-text{font-family:var(--serif);font-size:1.1rem;font-weight:300;letter-spacing:.15em;color:var(--text-primary);text-transform:uppercase}
.nav-links{display:flex;gap:2.5rem;list-style:none;transition:none}
.nav-links a{color:var(--text-secondary);text-decoration:none;font-size:.75rem;letter-spacing:.14em;text-transform:uppercase;transition:color .3s;position:relative}
.nav-links a::after{content:'';position:absolute;bottom:-4px;left:0;width:0;height:1px;background:var(--accent-secondary);transition:width .4s cubic-bezier(.16,1,.3,1)}
.nav-links a:hover{color:var(--text-primary)}
.nav-links a:hover::after{width:100%}
.nav-menu-btn{display:none;background:none;border:none;color:var(--text-primary);font-size:1.5rem;cursor:none;position:relative;z-index:102}

.hero{height:100vh;display:flex;align-items:flex-end;justify-content:flex-start;position:relative;overflow:hidden}
.hero-bg{position:absolute;inset:0;background-image:url('hero-bg.jpg');background-size:cover;background-position:center;filter:brightness(.3) saturate(.7);will-change:transform;transform:scale(1.1)}
.hero-video{position:absolute;inset:0;object-fit:cover;width:100%;height:100%;filter:brightness(.3) saturate(.7);will-change:transform;transform:scale(1.1)}
.hero-bg-fallback{position:absolute;inset:0;background:linear-gradient(to bottom,transparent 0%,transparent 40%,var(--bg) 100%),linear-gradient(135deg,rgba(3,63,38,.18) 0%,transparent 50%),radial-gradient(ellipse at 65% 25%,rgba(6,90,56,.1) 0%,transparent 55%)}
.hero-gradient{position:absolute;inset:0;background:linear-gradient(to bottom,rgba(10,10,10,.15) 0%,transparent 30%,transparent 55%,var(--bg) 100%),linear-gradient(to right,rgba(10,10,10,.7) 0%,transparent 55%);z-index:1}
.hero-content{position:relative;z-index:3;padding:0 3rem 7rem;max-width:900px}
.hero-tag{font-size:.72rem;letter-spacing:.3em;text-transform:uppercase;color:var(--accent-light);margin-bottom:1.5rem;opacity:0;animation:fadeUp .9s cubic-bezier(.16,1,.3,1) forwards .4s}
.hero-name{font-family:var(--serif);font-size:clamp(3.2rem,8.5vw,7rem);font-weight:300;line-height:1.02;margin-bottom:1.5rem;opacity:0;animation:fadeUp .9s cubic-bezier(.16,1,.3,1) forwards .6s}
.hero-name em{font-style:italic;color:var(--accent-secondary)}
.hero-subtitle{font-size:1.05rem;color:var(--text-secondary);max-width:480px;line-height:1.7;opacity:0;animation:fadeUp .9s cubic-bezier(.16,1,.3,1) forwards .8s}
.hero-line-anim{position:absolute;bottom:0;left:0;right:0;height:3px;background:linear-gradient(to right,transparent,var(--accent-light),transparent);z-index:3;animation:heroLine 2s ease forwards;opacity:0}
@keyframes heroLine{0%{width:0;opacity:0;left:50%}50%{opacity:1}100%{width:100%;left:0;opacity:0}}
.hero-scroll{position:absolute;bottom:2.5rem;right:3rem;z-index:3;display:flex;flex-direction:column;align-items:center;gap:.5rem;color:var(--text-muted);font-size:.6rem;letter-spacing:.25em;text-transform:uppercase;opacity:0;animation:fadeUp .8s ease forwards 1.2s}
.hero-scroll .line{width:1px;height:50px;background:linear-gradient(to bottom,var(--accent-light),transparent);animation:scrollPulse 2.5s ease infinite}

.divider{width:100%;height:1px;background:linear-gradient(to right,transparent,var(--border) 20%,var(--border) 80%,transparent)}

section{padding:8rem 3rem}
.section-label{font-size:.68rem;letter-spacing:.35em;text-transform:uppercase;color:var(--accent-light);margin-bottom:1.2rem;display:flex;align-items:center;gap:1rem}
.section-label::before{content:'';width:28px;height:1px;background:var(--accent-dim)}
.section-title{font-family:var(--serif);font-size:clamp(2rem,5vw,3.5rem);font-weight:300;line-height:1.15;margin-bottom:3rem}

.about{max-width:1200px;margin:0 auto}
.about-grid{display:grid;grid-template-columns:1fr 1.3fr;gap:4rem;align-items:start}
.about-image{aspect-ratio:3/4;background:var(--bg-card);border:1px solid var(--border);position:relative;overflow:hidden}
.about-image::after{content:'YOUR PHOTO';position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:.8rem;letter-spacing:.2em}
.about-image-border{position:absolute;top:1rem;left:1rem;right:-1rem;bottom:-1rem;border:1px solid var(--accent-dim);pointer-events:none;opacity:.3;transition:opacity .5s}
.about-image:hover .about-image-border{opacity:.6}
.about-text p{color:var(--text-secondary);margin-bottom:1.5rem;font-size:.95rem;line-height:1.85}
.about-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:2rem;margin-top:3rem;padding-top:3rem;border-top:1px solid var(--border)}
.stat-number{font-family:var(--serif);font-size:2.5rem;color:var(--accent-secondary);font-weight:300}
.stat-label{font-size:.7rem;color:var(--text-muted);letter-spacing:.12em;text-transform:uppercase;margin-top:.3rem}

.gallery{max-width:1400px;margin:0 auto}
.gallery-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem}
.gallery-item{position:relative;overflow:hidden;cursor:none;background:var(--bg-card);border:1px solid var(--border);transition:border-color .4s}
.gallery-item:hover{border-color:var(--accent-dim)}
.gallery-item::before{content:'';display:block;padding-top:100%}
.gallery-item.tall::before{padding-top:210%}
.gallery-item.wide{grid-column:span 2}
.gallery-item.wide::before{padding-top:50%}
.gallery-placeholder{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:.65rem;letter-spacing:.15em;text-transform:uppercase;background:linear-gradient(145deg,var(--bg-card) 0%,var(--bg-elevated) 100%);transition:transform 1s cubic-bezier(.16,1,.3,1),filter .8s}
.gallery-item video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .5s}
.gallery-item:hover video{opacity:1}
.gallery-play-icon{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:40px;height:40px;border:2px solid rgba(237,237,198,.5);border-radius:50%;display:flex;align-items:center;justify-content:center;transition:opacity .3s;pointer-events:none}
.gallery-play-icon::after{content:'';width:0;height:0;border-left:12px solid rgba(237,237,198,.7);border-top:8px solid transparent;border-bottom:8px solid transparent;margin-left:3px}
.gallery-item:hover .gallery-play-icon{opacity:0}
.gallery-item:hover .gallery-placeholder{transform:scale(1.06);filter:brightness(1.15)}
.gallery-count{position:absolute;top:12px;right:12px;font-size:.5rem;letter-spacing:.15em;color:var(--accent-secondary);background:rgba(10,10,10,.6);padding:.2rem .5rem;border-radius:2px;z-index:2;opacity:0;transition:opacity .3s}
.gallery-item:hover .gallery-count{opacity:1}
.gallery-overlay{position:absolute;inset:0;background:linear-gradient(to top,rgba(3,63,38,.6) 0%,transparent 55%);opacity:0;transition:opacity .5s;display:flex;align-items:flex-end;padding:1.5rem}
.gallery-item:hover .gallery-count{position:absolute;top:12px;right:12px;font-size:.5rem;letter-spacing:.15em;color:var(--accent-secondary);background:rgba(10,10,10,.6);padding:.2rem .5rem;border-radius:2px;z-index:2;opacity:0;transition:opacity .3s}
.gallery-item:hover .gallery-count{opacity:1}
.gallery-overlay{opacity:1}
.gallery-overlay span{font-family:var(--serif);font-size:1.05rem;font-style:italic;color:var(--accent-secondary);transform:translateY(8px);transition:transform .5s cubic-bezier(.16,1,.3,1)}
.gallery-item:hover .gallery-overlay span{transform:translateY(0)}

.lightbox{position:fixed;inset:0;z-index:200;background:rgba(5,5,5,.96);display:flex;align-items:center;justify-content:center;opacity:0;visibility:hidden;transition:opacity .4s,visibility .4s;cursor:none}
.lightbox.active{opacity:1;visibility:visible}
.lightbox-content{max-width:85vw;max-height:85vh;background:var(--bg-card);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;padding:2rem;font-family:var(--serif);font-size:1.5rem;color:var(--text-muted);font-style:italic;min-width:400px;min-height:300px;transform:scale(.92);transition:transform .5s cubic-bezier(.16,1,.3,1)}
.lightbox.active .lightbox-content{transform:scale(1)}
.lightbox-close{position:absolute;top:2rem;right:2rem;background:none;border:1px solid var(--border);color:var(--text-secondary);width:44px;height:44px;display:flex;align-items:center;justify-content:center;font-size:1.2rem;cursor:none;transition:all .3s}
.lightbox-close:hover{color:var(--accent-secondary);border-color:var(--accent-secondary)}
.lightbox-nav{position:absolute;top:50%;transform:translateY(-50%);background:none;border:1px solid var(--border);color:var(--text-secondary);width:48px;height:48px;display:flex;align-items:center;justify-content:center;font-size:1.3rem;cursor:none;transition:all .3s}
.lightbox-nav:hover{color:var(--accent-secondary);border-color:var(--accent-secondary)}
.lightbox-prev{left:2rem}
.lightbox-next{right:2rem}
.lightbox-caption{position:absolute;bottom:2.5rem;left:50%;transform:translateX(-50%);font-family:var(--serif);font-size:1.1rem;font-style:italic;color:var(--accent-secondary-dim);letter-spacing:.03em}
.lightbox-counter{position:absolute;top:2.2rem;left:2rem;font-size:.7rem;color:var(--text-muted);letter-spacing:.15em}

.blog{max-width:1000px;margin:0 auto}
.blog-list{display:flex;flex-direction:column;gap:1px;background:var(--border);border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.blog-item{display:grid;grid-template-columns:80px 1fr auto auto;gap:1.5rem;align-items:center;padding:1.5rem;background:var(--bg);text-decoration:none;color:inherit;transition:background .4s,padding-left .4s cubic-bezier(.16,1,.3,1)}
.blog-item:hover{background:var(--bg-elevated);padding-left:2rem}
.blog-thumb{width:80px;height:56px;background:var(--bg-card);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:.5rem;color:var(--text-muted);letter-spacing:.1em;text-transform:uppercase;overflow:hidden;transition:border-color .4s}
.blog-item:hover .blog-thumb{border-color:var(--accent-dim)}
.blog-text{display:flex;flex-direction:column;gap:.25rem}
.blog-date{font-size:.68rem;color:var(--text-muted);letter-spacing:.06em}
.blog-title{font-family:var(--serif);font-size:1.25rem;font-weight:400;transition:color .3s}
.blog-item:hover .blog-title{color:var(--accent-secondary)}
.blog-tag{font-size:.6rem;letter-spacing:.18em;text-transform:uppercase;color:var(--accent-light);padding:.25rem .7rem;border:1px solid rgba(6,90,56,.5);border-radius:2px;white-space:nowrap;transition:border-color .3s}
.blog-item:hover .blog-tag{border-color:var(--accent-light)}
.blog-arrow{font-size:1.1rem;color:var(--text-muted);transition:color .3s,transform .4s cubic-bezier(.16,1,.3,1)}
.blog-item:hover .blog-arrow{color:var(--accent-secondary);transform:translateX(5px)}

.contact{max-width:800px;margin:0 auto;text-align:center}
.contact .section-label{justify-content:center}
.contact .section-label::before{display:none}
.contact-text{color:var(--text-secondary);font-size:1.05rem;max-width:460px;margin:0 auto 3rem;line-height:1.8}
.contact-links{display:flex;justify-content:center;gap:1rem;flex-wrap:wrap}
.contact-link{display:flex;align-items:center;gap:.6rem;padding:.85rem 1.6rem;border:1px solid var(--border);color:var(--text-secondary);text-decoration:none;font-size:.75rem;letter-spacing:.12em;text-transform:uppercase;transition:all .4s cubic-bezier(.16,1,.3,1);background:var(--bg)}
.contact-link:hover{border-color:var(--accent-dim);color:var(--accent-secondary);background:rgba(3,63,38,.08);transform:translateY(-2px)}
.contact-link svg{width:15px;height:15px}

.scroll-top{position:fixed;bottom:2rem;right:2rem;width:40px;height:40px;background:var(--accent);border:1px solid var(--accent-dim);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:none;z-index:50;opacity:0;transform:translateY(20px);transition:all .4s cubic-bezier(.16,1,.3,1);pointer-events:none}
.scroll-top.visible{opacity:1;transform:translateY(0);pointer-events:auto}
.scroll-top:hover{background:var(--accent-dim);border-color:var(--accent-light)}
.scroll-top svg{width:16px;height:16px;stroke:var(--accent-secondary);fill:none;stroke-width:2}
footer{padding:4rem 3rem 3rem;text-align:center;border-top:1px solid var(--border)}
.footer-inner{display:flex;flex-direction:column;align-items:center;gap:1rem}
.footer-logo-img{height:40px;width:40px;border-radius:50%;transition:opacity .3s;opacity:.7;object-fit:cover}
.footer-logo:hover .footer-logo-img{opacity:1}
.footer-text{font-size:.65rem;color:var(--text-muted);letter-spacing:.18em;text-transform:uppercase}

@keyframes fadeUp{from{opacity:0;transform:translateY(25px)}to{opacity:1;transform:translateY(0)}}
@keyframes scrollPulse{0%,100%{opacity:.3}50%{opacity:.8}}
.reveal{opacity:0;transform:translateY(35px);transition:opacity .9s cubic-bezier(.16,1,.3,1),transform .9s cubic-bezier(.16,1,.3,1)}
.reveal.visible{opacity:1;transform:translateY(0)}
.reveal-scale{opacity:0;transform:scale(.93);transition:opacity .7s cubic-bezier(.16,1,.3,1),transform .7s cubic-bezier(.16,1,.3,1)}
.reveal-scale.visible{opacity:1;transform:scale(1)}
.stagger:nth-child(1){transition-delay:0s}.stagger:nth-child(2){transition-delay:.07s}.stagger:nth-child(3){transition-delay:.14s}.stagger:nth-child(4){transition-delay:.21s}.stagger:nth-child(5){transition-delay:.28s}.stagger:nth-child(6){transition-delay:.35s}.stagger:nth-child(7){transition-delay:.42s}.stagger:nth-child(8){transition-delay:.49s}.stagger:nth-child(9){transition-delay:.56s}

@media(max-width:768px){
  body{cursor:auto}
  body::after{opacity:.02}
  .cursor,.cursor-ring,.cursor-view{display:none!important}
  nav{padding:1rem 1.5rem}nav.scrolled{padding:.8rem 1.5rem}
  .nav-logo-text{font-size:.9rem}.nav-links{display:none}.nav-menu-btn{display:block;cursor:auto}
  .nav-links.open{display:flex;flex-direction:column;position:fixed;top:0;left:0;right:0;bottom:0;width:100vw;height:100vh;height:100dvh;background:#0a0a0a;justify-content:center;align-items:center;gap:2rem;z-index:101;overflow:hidden;transition:none}
  .nav-links.open a{font-size:1.2rem}
  section{padding:5rem 1.5rem}
  .hero-content{padding:0 1.5rem 4rem}.hero-line-anim{position:absolute;bottom:0;left:0;right:0;height:3px;background:linear-gradient(to right,transparent,var(--accent-light),transparent);z-index:3;animation:heroLine 2s ease forwards;opacity:0}
</style>

</head>
<body>
<div class="progress-bar" id="progressBar"></div>
<nav id="nav">
  <a href="#" class="nav-logo">
    <img src="data:image/png;base64,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" alt="Alirza Jafarov Logo" class="nav-logo-img">
    <span class="nav-logo-text">Alirza Jafarov</span>
  </a>
  <ul class="nav-links" id="navLinks">
    <li><a href="/#about" >About</a></li>
    <li><a href="/#gallery" >Gallery</a></li>
    <li><a href="/journal/" >Journal</a></li>
    <li><a href="/#contact" >Contact</a></li>
  </ul>
  <div class="lang-switch"><a href="/" class="active">EN</a><span>/</span><a href="/az/">AZ</a></div>
  <button class="nav-menu-btn" id="menuBtn" aria-label="Menu">&#9776;</button>
</nav>

<header class="article-hero">
  <div class="article-meta">
    <span>${dateStr}</span>
    <span class="article-meta-dot"></span>
    <span>${readTime} min read</span>
    <span class="article-meta-dot"></span>
    <span>${escHTML((post.tags || [])[0] || 'Essay')}</span>
  </div>
  <h1 class="article-title">${escHTML(post.title)}</h1>
  ${post.subtitle ? `<p class="article-subtitle">${escHTML(post.subtitle)}</p>` : ''}
</header>

${post.coverImage && /^(https?:\/\/|\/)/i.test(post.coverImage) ? `<img class="article-cover" src="${escHTML(post.coverImage)}" alt="${escHTML(post.title)}" loading="lazy">` : ''}

<article>
${contentHTML}
</article>

<div class="article-footer">
  <div class="article-tags">
    ${tagsHTML}
  </div>
</div>

<div class="share-section">
  <div class="share-label">Share this article</div>
  <div class="share-buttons">
    <a class="share-btn" id="shareX" href="#" target="_blank"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>X</a>
    <a class="share-btn" id="shareTG" href="#" target="_blank"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>Telegram</a>
    <a class="share-btn" id="shareLI" href="#" target="_blank"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>LinkedIn</a>
    <button class="share-btn" id="copyLink" onclick="copyURL()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>Copy Link</button>
  </div>
</div>

<div class="article-footer" style="border-top:1px solid var(--border);padding-top:2rem">
  <div class="article-author">
    <div class="article-author-avatar">AJ</div>
    <div class="article-author-info">
      <span class="article-author-name">Alirza Jafarov</span>
      <span class="article-author-bio">Visual artist based in Baku. Frames, color, and the occasional essay.</span>
    </div>
  </div>
  <a href="/journal/" class="article-back">&#8592; Back to Journal</a>
</div>

<footer>
  <p class="footer-text">&copy; ${new Date().getFullYear()} Alirza Jafarov</p>
</footer>

<script>
const pb=document.getElementById('progressBar'),an=document.getElementById('articleNav');
window.addEventListener('scroll',()=>{const s=window.scrollY,h=document.documentElement.scrollHeight-window.innerHeight;pb.style.width=(s/h)*100+'%';an.classList.toggle('visible',s>300)});
const pageURL=encodeURIComponent(window.location.href),pageTitle=encodeURIComponent(document.title);
document.getElementById('shareX').href='https://x.com/intent/tweet?url='+pageURL+'&text='+pageTitle;
document.getElementById('shareTG').href='https://t.me/share/url?url='+pageURL+'&text='+pageTitle;
document.getElementById('shareLI').href='https://www.linkedin.com/sharing/share-offsite/?url='+pageURL;
function copyURL(){navigator.clipboard.writeText(window.location.href).then(()=>{const b=document.getElementById('copyLink');b.style.borderColor='var(--accent-light)';b.style.color='var(--accent-light)';setTimeout(()=>{b.style.borderColor='';b.style.color=''},2000)})}
</script>
<button id="scrollTop" onclick="window.scrollTo({top:0,behavior:'smooth'})" style="position:fixed;bottom:2rem;right:2rem;width:40px;height:40px;background:#033f26;border:1px solid #065a38;border-radius:50%;display:none;align-items:center;justify-content:center;cursor:pointer;z-index:50"><svg viewBox="0 0 24 24" fill="none" stroke="#ebebd9" stroke-width="2" width="16" height="16"><polyline points="18 15 12 9 6 15"></polyline></svg></button>
<script>var _st=document.getElementById('scrollTop');window.addEventListener('scroll',function(){_st.style.display=window.scrollY>400?'flex':'none'});</script>
<script>
const menuBtn=document.getElementById('menuBtn'),navLinks=document.getElementById('navLinks');
if(menuBtn&&navLinks){
  menuBtn.addEventListener('click',()=>{
    const isOpen=navLinks.classList.toggle('open');
    menuBtn.innerHTML=isOpen?'&#10005;':'&#9776;';
    document.documentElement.style.overflow=isOpen?'hidden':'';
  });
  document.querySelectorAll('.nav-links a').forEach(a=>a.addEventListener('click',function(){
    navLinks.classList.remove('open');
    menuBtn.innerHTML='&#9776;';
    document.documentElement.style.overflow='';
  }));
}
</script>
</body>
</html>`;
}

function escHTML(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function markdownToHTML(md) {
  // Step 1: Escape all HTML first — prevents XSS from user content
  let html = escHTML(md);

  // Step 2: Apply markdown transformations on escaped text
  html = html
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/^---$/gm, '<hr>')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, url) => {
      const safe = /^(https?:\/\/|\/|mailto:|#)/i.test(url) ? url : '#';
      return '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
    })
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, url) => {
      const safe = /^(https?:\/\/|\/)/i.test(url) ? url : '';
      return '<figure><img src="' + safe + '" alt="' + alt + '" loading="lazy"><figcaption>' + alt + '</figcaption></figure>';
    })
    .replace(/^&gt; (.+)$/gm, '<blockquote><p>$1</p></blockquote>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^&gt;&gt;&gt; (.+) &lt;&lt;&lt;$/gm, '<div class="article-pullquote">$1</div>');

  html = html.replace(/((?:<li>.+<\/li>\n?)+)/g, '<ul>\n$1</ul>');
  html = html.replace(/<\/blockquote>\n<blockquote>/g, '\n');

  const lines = html.split('\n\n');
  html = lines.map(block => {
    block = block.trim();
    if (!block) return '';
    if (block.startsWith('<h') || block.startsWith('<ul') || block.startsWith('<ol') ||
        block.startsWith('<blockquote') || block.startsWith('<hr') || block.startsWith('<figure') ||
        block.startsWith('<div class="article-pullquote"')) {
      return block;
    }
    if (block.startsWith('<p')) return block;
    return '<p>' + block + '</p>';
  }).join('\n\n');

  return html;
}

// ─── ROUTES ───
const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    respond(res, 200, {});
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    // ─── AUTH ───
    if (pathname === '/api/login' && req.method === 'POST') {
      const { username, password } = await readBody(req);
      const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      const user = users.find(u => u.username === username);
      
      if (!user) return respond(res, 401, { error: 'Invalid credentials' });
      
      const hash = crypto.scryptSync(password, user.salt, 64).toString('hex');
      if (hash !== user.passwordHash) return respond(res, 401, { error: 'Invalid credentials' });
      
      const token = crypto.randomBytes(32).toString('hex');
      SESSIONS[token] = { username, created: Date.now() };
      
      return respond(res, 200, { token, username });
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      const token = (req.headers.authorization || '').replace('Bearer ', '');
      delete SESSIONS[token];
      return respond(res, 200, { ok: true });
    }

    if (pathname === '/api/me' && req.method === 'GET') {
      const user = authenticate(req);
      if (!user) return respond(res, 401, { error: 'Not authenticated' });
      return respond(res, 200, { username: user });
    }

    // ─── CHANGE PASSWORD ───
    if (pathname === '/api/change-password' && req.method === 'POST') {
      const user = authenticate(req);
      if (!user) return respond(res, 401, { error: 'Not authenticated' });
      
      const { newPassword } = await readBody(req);
      if (!newPassword || newPassword.length < 6) {
        return respond(res, 400, { error: 'Password must be at least 6 characters' });
      }
      
      const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      const idx = users.findIndex(u => u.username === user);
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.scryptSync(newPassword, salt, 64).toString('hex');
      users[idx] = { ...users[idx], passwordHash: hash, salt };
      fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
      
      return respond(res, 200, { ok: true });
    }

    // ─── PUBLIC: Get published posts index ───
    if (pathname === '/api/posts' && req.method === 'GET') {
      const tag = url.searchParams.get('tag');
      const search = url.searchParams.get('q');
      const lang = url.searchParams.get('lang');
      let posts = getPublishedPosts().map(p => ({
        slug: p.slug,
        title: p.title,
        subtitle: p.subtitle || '',
        date: p.date,
        tags: p.tags || [],
        lang: p.lang || 'en',
        readTime: Math.ceil((p.content || '').split(/\s+/).length / 200) + ' min',
        coverImage: p.coverImage || ''
      }));
      
      if (lang) posts = posts.filter(p => (p.lang || 'en') === lang);
      if (tag) posts = posts.filter(p => p.tags.some(t => t.toLowerCase() === tag.toLowerCase()));
      if (search) {
        const q = search.toLowerCase();
        posts = posts.filter(p => 
          p.title.toLowerCase().includes(q) || 
          p.subtitle.toLowerCase().includes(q) ||
          p.tags.some(t => t.toLowerCase().includes(q))
        );
      }
      
      return respond(res, 200, { posts });
    }

    // ─── ADMIN: Get all posts (including drafts) ───
    if (pathname === '/api/admin/posts' && req.method === 'GET') {
      const user = authenticate(req);
      if (!user) return respond(res, 401, { error: 'Not authenticated' });
      
      const posts = getAllPosts().map(p => ({
        slug: p.slug, title: p.title, subtitle: p.subtitle,
        date: p.date, tags: p.tags, status: p.status, lang: p.lang || 'en',
        readTime: Math.ceil((p.content || '').split(/\s+/).length / 200) + ' min',
        coverImage: p.coverImage || ''
      }));
      return respond(res, 200, { posts });
    }

    // ─── ADMIN: Get single post ───
    if (pathname.startsWith('/api/admin/posts/') && req.method === 'GET') {
      const user = authenticate(req);
      if (!user) return respond(res, 401, { error: 'Not authenticated' });
      
      const slug = pathname.replace('/api/admin/posts/', '');
      if (!/^[a-z0-9-]+$/.test(slug)) {
        return respond(res, 400, { error: 'Invalid slug' });
      }
      const filePath = path.join(DATA_DIR, `${slug}.json`);
      if (!fs.existsSync(filePath)) return respond(res, 404, { error: 'Post not found' });
      
      const post = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return respond(res, 200, { post });
    }

    // ─── ADMIN: Create/Update post ───
    if (pathname === '/api/admin/posts' && req.method === 'POST') {
      const user = authenticate(req);
      if (!user) return respond(res, 401, { error: 'Not authenticated' });
      
      const body = await readBody(req);
      const rawSlug = body.slug || body.title || '';
      const slug = generateSlug(rawSlug);
      if (!slug) {
        return respond(res, 400, { error: 'Invalid title or slug' });
      }
      
      const post = {
        slug,
        title: body.title,
        subtitle: body.subtitle || '',
        content: body.content || '',
        tags: (body.tags || '').split(',').map(t => t.trim()).filter(Boolean),
        lang: body.lang || 'en',
        date: body.date || new Date().toISOString().split('T')[0],
        status: body.status || 'draft',
        coverImage: body.coverImage || '',
        createdAt: body.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        author: user
      };
      
      fs.writeFileSync(path.join(DATA_DIR, `${slug}.json`), JSON.stringify(post, null, 2));
      
      // Rebuild static files if published
      if (post.status === 'published') {
        rebuildJournalIndex();
      }
      
      return respond(res, 200, { post, message: post.status === 'published' ? 'Published!' : 'Draft saved' });
    }

    // ─── ADMIN: Delete post ───
    if (pathname.startsWith('/api/admin/posts/') && req.method === 'DELETE') {
      const user = authenticate(req);
      if (!user) return respond(res, 401, { error: 'Not authenticated' });
      
      const slug = pathname.replace('/api/admin/posts/', '');
      if (!/^[a-z0-9-]+$/.test(slug)) {
        return respond(res, 400, { error: 'Invalid slug' });
      }
      const filePath = path.join(DATA_DIR, `${slug}.json`);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      
      // Also remove generated HTML
      const htmlPath = path.join(__dirname, 'journal', `${slug}.html`);
      if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath);
      
      rebuildJournalIndex();
      return respond(res, 200, { ok: true });
    }

    respond(res, 404, { error: 'Not found' });

  } catch (err) {
    console.error(err);
    respond(res, 500, { error: 'Internal server error' });
  }
});

// Initial rebuild on startup
rebuildJournalIndex();

server.listen(PORT, () => {
  console.log(`Blog API running on http://localhost:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
