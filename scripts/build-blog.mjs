// scripts/build-blog.mjs
//
// Renders content/blog/*.md into static HTML under the directory Vercel
// actually serves for withumair.com.
//
// Why a generator instead of a framework: withumair.com is a static HTTrack
// mirror of a GoHighLevel funnel with no build step, and Vercel's Root
// Directory for the project is `withumair/withumair.com`. The Soch SEO
// pipeline (n8n gkNsOpDjnRF1SNGe) commits markdown to content/blog/ exactly as
// it does for the Next.js sites; this script turns that into real, crawlable
// HTML so the SEO posts are indexable. It runs in CI on every push that
// touches content/blog/ - see .github/workflows/build-blog.yml.
//
// Posts are listed newest first. Undated posts sort last.

import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { marked } from "marked";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC_POSTS = path.join(ROOT, "content/blog");
const SRC_MEDIA = path.join(ROOT, "public/blog");
const SERVE_DIR = path.join(ROOT, "withumair/withumair.com");
const OUT_BLOG = path.join(SERVE_DIR, "blog");
const OUT_MEDIA = path.join(OUT_BLOG, "media");

const SITE = {
  name: "Umair Shahzad",
  home: "https://www.withumair.com/",
  blog: "https://www.withumair.com/blog/",
  tagline: "LinkedIn positioning for founders and operators.",
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Frontmatter date as ISO YYYY-MM-DD.
 *  `date: 2026-05-25` is unquoted, so js-yaml hands us a real Date and
 *  String() on that yields "Mon May 25 2026 ..." - sorting those as strings
 *  orders posts by weekday name. Normalise before comparing. */
function isoDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  }
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString().slice(0, 10);
}

function humanDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Rewrite a repo-relative featured-image path to where the copy lands.
 *  The pipeline writes `image: /blog/<slug>.<ext>` (a public/ path on the
 *  Next.js sites). Here those bytes are copied into /blog/media/. */
function resolveImage(src) {
  const s = String(src ?? "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  const m = s.match(/^\/?blog\/(.+)$/);
  if (m) return "/blog/media/" + m[1];
  return s;
}

/** A post's FAQ as questions and answers: the "## FAQ" / "## Frequently Asked
 *  Questions" section, "### question" then its answer, up to the next "##". */
function faqFromMarkdown(body) {
  const lines = String(body).replace(/\r/g, "").split("\n");
  const start = lines.findIndex((l) => /^##\s+(faq\b|frequently asked questions)/i.test(l.trim()));
  if (start < 0) return [];
  const plain = (md) =>
    md
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const items = [];
  let cur = null;
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (/^##\s/.test(line) || line.startsWith("<!--")) break;
    const q = line.match(/^###\s+(.+)$/);
    if (q) {
      if (cur) items.push({ question: cur.q, answer: plain(cur.a.join(" ")) });
      cur = { q: plain(q[1]), a: [] };
    } else if (cur && line) cur.a.push(line);
  }
  if (cur) items.push({ question: cur.q, answer: plain(cur.a.join(" ")) });
  return items.filter((i) => i.question && i.answer);
}

function slugifyHeading(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Section headings for the "In this article" rail, in document order.
 *  The post's `##` headings, falling back to the shallowest level it uses. */
function getHeadings(body) {
  const found = [];
  let inFence = false;
  for (const line of body.replace(/\r/g, "").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{2,4})[ \t]+(.+?)[ \t]*#*[ \t]*$/);
    if (!m) continue;
    const text = m[2]
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, "")
      .trim();
    if (text) found.push({ level: m[1].length, text });
  }
  if (!found.length) return [];
  const top = Math.min(...found.map((h) => h.level));
  return found
    .filter((h) => h.level === top)
    .map((h) => ({ id: slugifyHeading(h.text), text: h.text }));
}

// marked renderer: give h2/h3/h4 the same anchor ids the TOC links to, and
// route body images through resolveImage.
function renderMarkdown(body) {
  const renderer = new marked.Renderer();
  renderer.heading = ({ tokens, depth }) => {
    const text = marked.parser
      ? marked.parseInline(tokens.map((t) => t.raw).join(""))
      : "";
    const plain = tokens
      .map((t) => t.raw)
      .join("")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, "")
      .trim();
    const id = slugifyHeading(plain);
    return `<h${depth} id="${id}">${text}</h${depth}>\n`;
  };
  renderer.image = ({ href, title, text }) => {
    const src = resolveImage(href);
    const t = title ? ` title="${esc(title)}"` : "";
    return `<img src="${esc(src)}" alt="${esc(text)}"${t} loading="lazy">`;
  };
  return marked.parse(body, { renderer, gfm: true, breaks: false });
}

// ---------------------------------------------------------------------------
// page chrome
// ---------------------------------------------------------------------------

const STYLES = `
:root{
  --purple:#7c3aed; --purple-dark:#6d28d9; --purple-soft:#e9d5ff;
  --ink:#111111; --body:#444444; --muted:#7d7d7d;
  --line:#e6e6e6; --wash:#f7f6fb;
  --font:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:#fff;color:var(--body);font-family:var(--font);font-size:17px;line-height:1.75;-webkit-font-smoothing:antialiased}
img{max-width:100%;height:auto}
a{color:var(--purple-dark)}
.wrap{width:100%;max-width:1120px;margin:0 auto;padding:0 24px}
.site-head{border-bottom:1px solid var(--line);background:#fff;position:sticky;top:0;z-index:20}
.site-head .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-block:18px}
.brand{font-weight:800;font-size:18px;color:var(--ink);text-decoration:none;letter-spacing:-.01em}
.brand span{color:var(--purple)}
.head-nav{display:flex;gap:22px;align-items:center;font-size:15px;font-weight:600}
.head-nav a{color:var(--ink);text-decoration:none}
.head-nav a:hover{color:var(--purple)}
.hero{background:var(--wash);border-bottom:1px solid var(--line)}
.hero .wrap{padding-block:56px 48px}
.hero h1{margin:0;color:var(--ink);font-size:clamp(2rem,1.4rem+2.4vw,3rem);line-height:1.1;font-weight:800;letter-spacing:-.02em;max-width:34ch}
.hero p{margin:16px 0 0;font-size:19px;color:var(--muted);max-width:60ch}
.meta{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:center;margin-top:18px;font-size:14px;color:var(--muted)}
.pill{display:inline-block;background:var(--purple-soft);color:var(--purple-dark);font-size:12px;font-weight:700;letter-spacing:.02em;padding:5px 11px;border-radius:999px;text-transform:uppercase}
main{padding-block:56px}
.cards{display:grid;gap:26px;grid-template-columns:1fr}
@media(min-width:700px){.cards{grid-template-columns:1fr 1fr}}
@media(min-width:1000px){.cards{grid-template-columns:repeat(3,1fr)}}
.cards.lead{grid-template-columns:1fr}
@media(min-width:820px){.cards.lead{grid-template-columns:1fr 1fr}}
.card{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:#fff;text-decoration:none;transition:border-color .2s,transform .2s,box-shadow .2s}
.card:hover{border-color:var(--purple);transform:translateY(-2px);box-shadow:0 14px 30px -20px rgba(17,17,17,.35)}
.card .thumb{aspect-ratio:16/10;background:var(--wash);overflow:hidden}
.card .thumb img{width:100%;height:100%;object-fit:cover;display:block}
.card .cbody{padding:20px 22px 24px;display:flex;flex-direction:column;gap:10px}
.card h2,.card h3{margin:0;color:var(--ink);font-weight:750;letter-spacing:-.01em;line-height:1.28}
.card h2{font-size:23px}
.card h3{font-size:19px}
.card p{margin:0;font-size:15px;color:var(--body);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.article-layout{display:grid;gap:44px;grid-template-columns:1fr}
@media(min-width:1024px){.article-layout{grid-template-columns:15rem minmax(0,1fr);gap:56px}}
.toc{align-self:start}
@media(min-width:1024px){.toc{position:sticky;top:96px;max-height:calc(100vh - 8rem);overflow-y:auto}}
.toc h2{margin:0;font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
.toc ul{list-style:none;margin:16px 0 0;padding:0}
.toc li+li{border-top:1px solid var(--line)}
.toc a{display:block;padding:11px 0;font-size:14.5px;line-height:1.4;color:var(--body);text-decoration:none}
.toc a:hover{color:var(--purple-dark)}
.post-figure{border:1px solid var(--line);border-radius:14px;overflow:hidden;margin:0 0 40px;background:var(--wash)}
.post-figure img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover}
.prose{max-width:none}
.prose>*{margin:0 0 22px}
.prose h1,.prose h2,.prose h3,.prose h4{color:var(--ink);font-weight:750;letter-spacing:-.012em;line-height:1.22;margin:38px 0 14px;scroll-margin-top:96px}
.prose h1{font-size:clamp(1.6rem,1.4rem+.8vw,2.05rem)}
.prose h2{font-size:clamp(1.4rem,1.25rem+.6vw,1.75rem)}
.prose h3,.prose h4{font-size:clamp(1.18rem,1.1rem+.4vw,1.36rem)}
.prose strong{color:var(--ink);font-weight:650}
.prose a{color:var(--purple-dark);text-decoration:underline;text-underline-offset:2px}
.prose ul,.prose ol{padding-left:24px;margin:0 0 22px}
.prose li+li{margin-top:8px}
.prose blockquote{margin:0 0 22px;padding:4px 0 4px 22px;border-left:3px solid var(--purple);color:var(--ink);font-style:italic;font-size:19px}
.prose blockquote p:last-child{margin-bottom:0}
.prose code{background:var(--wash);border:1px solid var(--line);border-radius:4px;padding:1px 6px;font-size:.9em}
.prose pre{background:var(--wash);border:1px solid var(--line);border-radius:10px;padding:16px 20px;overflow-x:auto}
.prose pre code{background:none;border:none;padding:0}
.prose hr{border:none;border-top:1px solid var(--line)}
.prose img{border-radius:10px}
.prose figure{margin:0 0 22px}
.prose figcaption{font-size:14px;color:var(--muted);font-style:italic;margin-top:8px}
.prose table{width:100%;border-collapse:collapse;font-size:15.5px;display:block;overflow-x:auto}
.prose th,.prose td{border-bottom:1px solid var(--line);padding:11px 14px;text-align:left}
.prose th{color:var(--ink);font-weight:650}
.cta{background:var(--ink);color:#fff;margin-top:8px}
.cta .wrap{padding-block:60px;text-align:center}
.cta h2{margin:0;color:#fff;font-size:clamp(1.6rem,1.3rem+1.4vw,2.4rem);font-weight:800;letter-spacing:-.02em}
.cta p{margin:14px auto 26px;max-width:52ch;color:rgba(255,255,255,.72)}
.btn{display:inline-block;background:var(--purple);color:#fff;font-weight:700;font-size:16px;padding:15px 30px;border-radius:9px;text-decoration:none}
.btn:hover{background:var(--purple-dark)}
.back{display:inline-block;margin-bottom:26px;font-size:15px;font-weight:600;color:var(--purple-dark);text-decoration:none}
.site-foot{border-top:1px solid var(--line);font-size:14px;color:var(--muted)}
.site-foot .wrap{padding-block:28px;display:flex;flex-wrap:wrap;gap:10px 20px;justify-content:space-between}
.site-foot a{color:var(--muted)}
.empty{color:var(--muted);font-size:18px}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.card{transition:none}}
`.trim();

const FONT_LINK =
  '<link rel="preconnect" href="https://fonts.gstatic.com/" crossorigin>' +
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap">';

function shell({ title, description, canonical, image, body, jsonLd }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="${jsonLd ? "article" : "website"}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
${image ? `<meta property="og:image" content="${esc(image)}">\n<meta name="twitter:card" content="summary_large_image">` : '<meta name="twitter:card" content="summary">'}
${FONT_LINK}
<style>${STYLES}</style>
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>` : ""}
</head>
<body>
<header class="site-head"><div class="wrap">
  <a class="brand" href="${SITE.home}">with<span>umair</span></a>
  <nav class="head-nav">
    <a href="${SITE.home}">Home</a>
    <a href="/blog/">Blog</a>
    <a href="${SITE.home}#book">Book a call</a>
  </nav>
</div></header>
${body}
<section class="cta"><div class="wrap">
  <h2>Is your LinkedIn telling the right story?</h2>
  <p>Get a written audit of your profile and positioning, with the specific changes worth making.</p>
  <a class="btn" href="${SITE.home}">Get your audit</a>
</div></section>
<footer class="site-foot"><div class="wrap">
  <span>&copy; ${new Date().getUTCFullYear()} ${esc(SITE.name)}</span>
  <span><a href="${SITE.home}">withumair.com</a></span>
</div></footer>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

function readPosts() {
  if (!fs.existsSync(SRC_POSTS)) return [];
  return fs
    .readdirSync(SRC_POSTS)
    .filter((f) => f.endsWith(".md"))
    .map((file) => {
      const raw = fs.readFileSync(path.join(SRC_POSTS, file), "utf8");
      const { data, content } = matter(raw);
      const slug = String(data.slug || file.replace(/\.md$/, ""))
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "");
      return {
        slug,
        title: data.title || slug,
        date: isoDate(data.date),
        category: data.category || "",
        excerpt: data.excerpt || "",
        image: resolveImage(data.image),
        body: content,
      };
    })
    .filter((p) => {
      // /blog/media/ holds the copied featured images - a post slug of "media"
      // would collide with it.
      if (!p.slug || p.slug === "media") {
        console.warn(`build-blog: skipping post with unusable slug "${p.slug}"`);
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (a.date !== b.date) {
        if (!a.date) return 1;
        if (!b.date) return -1;
        return a.date < b.date ? 1 : -1;
      }
      return a.slug.localeCompare(b.slug);
    });
}

function card(post, level) {
  const tag = level === "lead" ? "h2" : "h3";
  return `<a class="card" href="/blog/${esc(post.slug)}/">
  <div class="thumb">${post.image ? `<img src="${esc(post.image)}" alt="${esc(post.title)}" loading="lazy">` : ""}</div>
  <div class="cbody">
    <div class="meta">${post.category ? `<span class="pill">${esc(post.category)}</span>` : ""}${post.date ? `<span>${esc(humanDate(post.date))}</span>` : ""}</div>
    <${tag}>${esc(post.title)}</${tag}>
    ${level === "lead" && post.excerpt ? `<p>${esc(post.excerpt)}</p>` : ""}
  </div>
</a>`;
}

function buildIndex(posts) {
  const lead = posts.slice(0, 2);
  const rest = posts.slice(2);
  const body = `<section class="hero"><div class="wrap">
  <h1>Blog</h1>
  <p>Notes on LinkedIn positioning, founder visibility and the work behind it. Newest first.</p>
</div></section>
<main><div class="wrap">
${
  posts.length === 0
    ? `<p class="empty">No posts yet. Check back shortly.</p>`
    : `<div class="cards lead">${lead.map((p) => card(p, "lead")).join("\n")}</div>` +
      (rest.length
        ? `\n<div class="cards" style="margin-top:26px">${rest.map((p) => card(p, "small")).join("\n")}</div>`
        : "")
}
</div></main>`;

  return shell({
    title: `Blog | ${SITE.name}`,
    description: SITE.tagline,
    canonical: SITE.blog,
    image: posts[0]?.image || "",
    body,
  });
}

function buildPost(post) {
  const headings = getHeadings(post.body);
  const hasToc = headings.length > 1;
  const html = renderMarkdown(post.body);
  const canonical = `${SITE.blog}${post.slug}/`;
  const absImage = post.image
    ? /^https?:\/\//i.test(post.image)
      ? post.image
      : `https://www.withumair.com${post.image}`
    : "";

  const body = `<section class="hero"><div class="wrap">
  <h1>${esc(post.title)}</h1>
  <div class="meta">${post.category ? `<span class="pill">${esc(post.category)}</span>` : ""}${post.date ? `<span>${esc(humanDate(post.date))}</span>` : ""}</div>
</div></section>
<main><div class="wrap">
  <a class="back" href="/blog/">&larr; All posts</a>
  ${post.image ? `<figure class="post-figure"><img src="${esc(post.image)}" alt="${esc(post.title)}"></figure>` : ""}
  <div class="article-layout">
    ${
      hasToc
        ? `<aside class="toc"><h2>In this article</h2><ul>${headings
            .map((h) => `<li><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`)
            .join("")}</ul></aside>`
        : ""
    }
    <article class="prose">${html}</article>
  </div>
</div></main>`;

  return shell({
    title: `${post.title} | ${SITE.name}`,
    description: post.excerpt || SITE.tagline,
    canonical,
    image: absImage,
    body,
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        headline: post.title,
        description: post.excerpt || undefined,
        datePublished: post.date || undefined,
        dateModified: post.date || undefined,
        image: absImage || undefined,
        mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
        author: { "@type": "Person", name: SITE.name, url: SITE.home },
        publisher: { "@type": "Person", name: SITE.name, url: SITE.home },
      },
      ...faqJsonLd(post.body),
    ],
  });
}

/** FAQPage structured data for a post, or nothing when it has no FAQ. */
function faqJsonLd(body) {
  const faq = faqFromMarkdown(body);
  if (!faq.length) return [];
  return [
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faq.map((i) => ({
        "@type": "Question",
        name: i.question,
        acceptedAnswer: { "@type": "Answer", text: i.answer },
      })),
    },
  ];
}

/** sitemap.xml at the site root: home, the blog index and every post. */
function buildSitemap(posts) {
  const urls = [
    { loc: SITE.home },
    { loc: SITE.blog },
    ...posts.map((p) => ({ loc: `${SITE.blog}${p.slug}/`, lastmod: p.date || "" })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map((u) => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${esc(u.lastmod)}</lastmod>` : ""}</url>`)
  .join("\n")}
</urlset>
`;
}

/** llms.txt at the site root: who this is, and every post with its summary (llmstxt.org). */
function buildLlmsTxt(posts) {
  const list = posts
    .map((p) => `- [${p.title}](${SITE.blog}${p.slug}/)${p.excerpt ? `: ${p.excerpt}` : ""}`)
    .join("\n");
  return `# ${SITE.name}

> ${SITE.tagline} Umair Shahzad helps founders and operators build the LinkedIn presence that wins clients and investor conversations.

## Pages

- [Home](${SITE.home})
- [Blog](${SITE.blog})

## Posts

${list || "(none yet)"}
`;
}

function copyMedia() {
  if (!fs.existsSync(SRC_MEDIA)) return 0;
  fs.mkdirSync(OUT_MEDIA, { recursive: true });
  let n = 0;
  for (const file of fs.readdirSync(SRC_MEDIA)) {
    const from = path.join(SRC_MEDIA, file);
    if (!fs.statSync(from).isFile() || file.startsWith(".")) continue;
    fs.copyFileSync(from, path.join(OUT_MEDIA, file));
    n++;
  }
  return n;
}

function main() {
  if (!fs.existsSync(SERVE_DIR)) {
    throw new Error(
      `build-blog: ${SERVE_DIR} is missing - that is the directory Vercel serves, cannot write the blog`,
    );
  }

  const posts = readPosts();

  // Drop stale post directories so a renamed or deleted .md does not leave an
  // orphaned page live. Only <slug>/ dirs are touched; media/ is preserved.
  if (fs.existsSync(OUT_BLOG)) {
    const keep = new Set(posts.map((p) => p.slug));
    for (const entry of fs.readdirSync(OUT_BLOG, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "media") continue;
      if (!keep.has(entry.name)) {
        fs.rmSync(path.join(OUT_BLOG, entry.name), { recursive: true, force: true });
        console.log(`removed stale post /blog/${entry.name}/`);
      }
    }
  }

  fs.mkdirSync(OUT_BLOG, { recursive: true });
  fs.writeFileSync(path.join(OUT_BLOG, "index.html"), buildIndex(posts), "utf8");

  for (const post of posts) {
    const dir = path.join(OUT_BLOG, post.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), buildPost(post), "utf8");
  }

  const media = copyMedia();

  fs.writeFileSync(path.join(SERVE_DIR, "sitemap.xml"), buildSitemap(posts), "utf8");
  fs.writeFileSync(path.join(SERVE_DIR, "llms.txt"), buildLlmsTxt(posts), "utf8");

  console.log(
    `build-blog: ${posts.length} post(s), ${media} image(s) -> ${path.relative(ROOT, OUT_BLOG)}`,
  );
  if (posts.length) {
    console.log("order (newest first):");
    for (const p of posts) console.log(`  ${p.date || "(undated)"}  ${p.slug}`);
  }
}

main();
