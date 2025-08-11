/// app/api/audit/route.ts
// Batch SEO audit (up to 10 URLs): PageSpeed + core files + schema + contacts
// + expanded on-page checks + concrete Entity Trust & Hygiene scoring.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// ————————————————————————————————————————————
// Utils
// ————————————————————————————————————————————
function unique<T>(arr: T[]): T[] { return [...new Set(arr)]; }
function normaliseOrigin(input: string): string {
  const u = new URL(input.startsWith("http") ? input : `https://${input}`);
  return new URL(u.origin).toString();
}
async function fetchText(url: string, init?: RequestInit) {
  const res = await fetch(url, { redirect: "follow", ...init });
  if (!res.ok) return { ok: false as const, status: res.status, text: "", headers: res.headers };
  const text = await res.text();
  return { ok: true as const, status: res.status, text, headers: res.headers };
}
const THIS_YEAR = new Date().getFullYear();

// ————————————————————————————————————————————
// JSON-LD extraction
// ————————————————————————————————————————————
function extractJsonLd(html: string): any[] {
  const out: any[] = [];
  const regex = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html))) {
    try {
      const json = JSON.parse(m[1].trim());
      Array.isArray(json) ? out.push(...json) : out.push(json);
    } catch {}
  }
  return out;
}
function extractSchemaTypes(jsonld: any[]): string[] {
  const types: string[] = [];
  const walk = (obj: any) => {
    if (!obj || typeof obj !== "object") return;
    if (obj["@type"]) {
      const t = Array.isArray(obj["@type"]) ? obj["@type"] : [obj["@type"]];
      for (const x of t) types.push(String(x));
    }
    for (const k of Object.keys(obj)) walk(obj[k]);
  };
  for (const item of jsonld) walk(item);
  return unique(types);
}
const RECOMMENDED_SCHEMA = [
  "Organization","LocalBusiness","Service","Product","FAQPage","HowTo","VideoObject",
  "Review","BreadcrumbList","Article","BlogPosting","WebSite","WebPage"
];

// ————————————————————————————————————————————
// PageSpeed Insights
// ————————————————————————————————————————————
const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
async function runPSI(target: string, strategy: "mobile"|"desktop", key?: string) {
  if (!key) throw new Error("Missing PSI_API_KEY");
  const url = new URL(PSI_ENDPOINT);
  url.searchParams.set("url", target);
  url.searchParams.set("strategy", strategy);
  url.searchParams.set("key", key);
  const res = await fetch(url.toString(), { next: { revalidate: 0 } });
  if (!res.ok) throw new Error(`PSI ${strategy} failed: ${res.status}`);
  return res.json();
}
function pickTopActions(lh: any, limit = 10): string[] {
  try {
    const audits = lh?.lighthouseResult?.audits || {};
    const arr = Object.values(audits) as any[];
    const opps = arr
      .filter((a: any) => a?.details?.type === "opportunity" || (typeof a?.score === "number" && a.score < 1))
      .map((a: any) => a.title)
      .filter(Boolean);
    return unique(opps).slice(0, limit);
  } catch { return []; }
}

// ————————————————————————————————————————————
// Small crawl for contact discovery
// ————————————————————————————————————————————
const HIGH_SIGNAL_PATHS = ["/","/contact","/about","/team","/company","/leadership","/press","/privacy","/careers"];
async function crawlSmall(origin: string, limit = 6) {
  const pages: { url: string; html: string; headers: Headers }[] = [];
  for (const p of HIGH_SIGNAL_PATHS.slice(0, limit)) {
    const u = origin + p;
    const res = await fetch(u, { redirect: "follow" });
    if (res.ok) {
      const html = await res.text();
      pages.push({ url: res.url, html, headers: res.headers });
    }
  }
  return pages;
}

const EMAIL_RE = /([a-z0-9._%+-]+)\s?(?:\[at\]|@)\s?([a-z0-9.-]+\.[a-z]{2,})/ig;
const PHONE_RE = /(?:(?:\+?\d{1,3}[\s-]?)?(?:\(?0?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{3,4})/g;
function deobfuscateEmail(str: string) { return str.replace(/\s?\[at\]\s?/i, "@").replace(/\s?\[dot\]\s?/ig, "."); }
function discoverContacts(pages: { url: string; html: string }[]) {
  type Contact = { type: string; value: string; sourceUrl: string; context?: string; confidence: number };
  const out: Contact[] = [];
  for (const { url, html } of pages) {
    const linkRe = /<a[^>]+href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi; let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html))) {
      const href = m[1]; const text = m[2]?.replace(/<[^>]*>/g,'').trim();
      if (href.startsWith('mailto:')) out.push({ type:'email', value: href.slice(7), sourceUrl: url, context: text, confidence: 0.9 });
      if (href.startsWith('tel:')) out.push({ type:'phone', value: href.slice(4), sourceUrl: url, context: text, confidence: 0.8 });
      if (href.includes('linkedin.com')) out.push({ type:'linkedin', value: href, sourceUrl: url, context: text, confidence: 0.7 });
      if (href.includes('calendly.com')) out.push({ type:'calendly', value: href, sourceUrl: url, context: text, confidence: 0.85 });
      if (href.endsWith('.vcf')) out.push({ type:'vcard', value: href, sourceUrl: url, context: text, confidence: 0.85 });
    }
    const body = html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ');
    for (const e of body.matchAll(EMAIL_RE)) out.push({ type:'email', value: deobfuscateEmail(`${e[1]}@${e[2]}`).toLowerCase(), sourceUrl:url, confidence:0.6 });
    for (const ph of body.matchAll(PHONE_RE)) out.push({ type:'phone', value: ph[0].replace(/\s+/g,' ').trim(), sourceUrl:url, confidence:0.5 });
    const jsonld = extractJsonLd(html);
    for (const item of jsonld) {
      if (item && item['@type'] === 'Organization' && item.contactPoint) {
        const arr = Array.isArray(item.contactPoint) ? item.contactPoint : [item.contactPoint];
        for (const c of arr) {
          if (c?.email) out.push({ type:'email', value:String(c.email), sourceUrl:url, context:c.contactType, confidence:0.85 });
          if (c?.telephone) out.push({ type:'phone', value:String(c.telephone), sourceUrl:url, context:c.contactType, confidence:0.8 });
        }
      }
    }
  }
  const best = out.filter(c => c.type==='email' || c.type==='calendly').sort((a,b)=>b.confidence-a.confidence)[0] || null;
  return { contacts: out, best };
}

// ————————————————————————————————————————————
// On-page checks (incl. Entity Trust & Hygiene signals)
// ————————————————————————————————————————————
type Issue = { id: string; status: "pass"|"warn"|"fail"; details?: any; fix?: string; page?: string; category?: string };

function evaluateHome(html: string, headers: Headers, url: string): Issue[] {
  const issues: Issue[] = [];
  const textNoTags = html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'');

  // Title
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() || "";
  const tl = title.length;
  const titleStatus = tl>=15&&tl<=60? 'pass' : (tl>=8&&tl<=70? 'warn':'fail');
  issues.push({ id:'title_tag', status:titleStatus, details:{ length:tl, title }, fix:'Craft unique, descriptive titles (≤60 chars).', page:url, category:'onpage_seo' });

  // Meta description
  const md = /<meta[^>]+name=['"]description['"][^>]+content=['"]([^'"]*)['"][^>]*>/i.exec(html)?.[1] || '';
  const mdl = md.trim().length; const mdStatus = mdl===0? 'fail' : (mdl<70||mdl>160? 'warn':'pass');
  issues.push({ id:'meta_description', status: mdStatus, details:{ length:mdl }, fix:'Write ~150-char descriptions matching intent.', page:url, category:'onpage_seo' });

  // Viewport
  const hasViewport = /<meta[^>]+name=['"]viewport['"][^>]+>/i.test(html);
  issues.push({ id:'viewport_meta', status: hasViewport?'pass':'fail', fix:'Add responsive viewport meta tag.', page:url, category:'technical_seo' });

  // Headings
  const hMatches = [...html.matchAll(/<(h[1-6])\b[^>]*>/gi)].map(m=>m[1].toUpperCase());
  const h1Count = hMatches.filter(h=>h==='H1').length;
  const hierarchyOk = hMatches.every((h,i,arr)=> i===0 || parseInt(arr[i].slice(1)) - parseInt(arr[i-1].slice(1)) <= 1 );
  issues.push({ id:'h1_tag', status: h1Count===1?'pass':h1Count===0?'fail':'warn', details:{ h1Count }, fix:'Use exactly one H1.', page:url, category:'onpage_seo' });
  issues.push({ id:'heading_hierarchy', status: hierarchyOk? 'pass':'warn', details:{ order:hMatches }, fix:'Follow logical H2/H3 progression.', page:url, category:'onpage_seo' });

  // Canonical & robots
  const canonical = /<link[^>]+rel=['"]canonical['"][^>]+href=['"]([^'"]+)['"][^>]*>/i.exec(html)?.[1] || '';
  issues.push({ id:'canonical_tag', status: !canonical? 'warn' : canonical.startsWith(url)? 'pass':'warn', details:{ canonical }, fix:'Add self-referencing canonical.', page:url, category:'technical_seo' });
  const robotsMeta = /<meta[^>]+name=['"]robots['"][^>]+content=['"]([^'"]*)['"][^>]*>/i.exec(html)?.[1] || '';
  const robotsHeader = headers.get('x-robots-tag') || '';
  const forbids = /(noindex|nofollow)/i;
  issues.push({ id:'meta_robots', status: forbids.test(robotsMeta)||forbids.test(robotsHeader)? 'fail':'pass', details:{ meta:robotsMeta, header:robotsHeader }, fix:'Remove accidental noindex/nofollow.', page:url, category:'technical_seo' });

  // OpenGraph (Entity trust)
  const ogRequired = ["og:title","og:description","og:image"];
  const missingOg = ogRequired.filter(p=>!new RegExp(`<meta[^>]+property=['"]${p}['"]`,'i').test(html));
  issues.push({ id:'open_graph', status: missingOg.length? (missingOg.length===ogRequired.length? 'fail' : 'warn') : 'pass', details:{ missing: missingOg }, fix:'Complete OG tags.', page:url, category:'entity_trust' });

  // Mixed content
  const httpAssets = (html.match(/src=['"]http:\/\//gi)||[]).length + (html.match(/href=['"]http:\/\//gi)||[]).length;
  issues.push({ id:'https_mixed_content', status: httpAssets===0? 'pass' : (httpAssets<3? 'warn':'fail'), details:{ httpAssets }, fix:'Serve assets over HTTPS.', page:url, category:'technical_seo' });

  // Images: alt, lazy, filenames
  const imgTags = [...html.matchAll(/<img\b[^>]*>/gi)].map(m=>m[0]);
  const imgCount = imgTags.length; const imgNoAlt = imgTags.filter(t=>!/\balt=/.test(t)).length; const missingRatio = imgCount? imgNoAlt/imgCount : 0;
  issues.push({ id:'image_alt', status: missingRatio<=0.1?'pass':(missingRatio<=0.3?'warn':'fail'), details:{ missingRatio }, fix:'Add alt text to important images.', page:url, category:'onpage_seo' });
  const lazyCount = imgTags.filter(t=>/\bloading=['"]lazy['"]/.test(t)).length; const lazyRatio = imgCount? lazyCount/imgCount:0;
  issues.push({ id:'image_lazy', status: lazyRatio>=0.8? 'pass' : (lazyRatio>=0.5? 'warn':'fail'), details:{ lazyRatio }, fix:'Add loading="lazy" to non-critical images.', page:url, category:'onpage_seo' });
  const descriptive = imgTags.filter(t=>{ const src = /\bsrc=['"]([^'"]+)['"]/.exec(t)?.[1]||''; const fn = src.split('/').pop()||''; return /[a-zA-Z]/.test(fn) && !/^IMG[_-]?\d+/i.test(fn) && !/^image\d+/i.test(fn); }).length;
  const descRatio = imgCount? descriptive/imgCount:1;
  issues.push({ id:'image_filename', status: descRatio>=0.5? 'pass' : (descRatio>=0.3? 'warn':'fail'), details:{ descriptiveRatio: descRatio }, fix:'Use descriptive filenames (e.g., blue-widget.jpg).', page:url, category:'onpage_seo' });

  // Internal links & anchor diversity
  const links = [...html.matchAll(/<a\b[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi)].map(m=>({ href:m[1], text:m[2].replace(/<[^>]*>/g,'').trim() }));
  const origin = new URL(url).origin; const internal = links.filter(l=>{ try { const abs = new URL(l.href, url); return abs.origin===origin; } catch { return false; } });
  const minLinks = internal.length; const texts = internal.map(l=>l.text.toLowerCase()).filter(Boolean); const uniqueAnchors = new Set(texts).size; const anchorDiversity = texts.length? uniqueAnchors/texts.length : 1;
  issues.push({ id:'internal_links', status: (minLinks>=5 && anchorDiversity>=0.4)? 'pass' : (minLinks>=3? 'warn':'fail'), details:{ internalCount:minLinks, anchorDiversity }, fix:'Add contextual internal links and diversify anchors.', page:url, category:'onpage_seo' });

  // Publish/Last-modified presence
  const dateMeta = /<meta[^>]+(article:published_time|date|last-modified)[^>]+content=['"]([^'"]+)['"]/i.exec(html)?.[2] || '';
  const timeTag = /<time[^>]+datetime=['"]([^'"]+)['"][^>]*>/i.exec(html)?.[1] || '';
  const hasDate = !!(dateMeta || timeTag);
  issues.push({ id:'publish_date', status: hasDate? 'pass':'warn', details:{ dateMeta, timeTag }, fix:'Expose publish/updated dates on content pages.', page:url, category:'onpage_seo' });

  // Word count (rough)
  const bodyText = textNoTags.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  const words = bodyText.split(' ').filter(Boolean).length;
  issues.push({ id:'word_count', status: words>=300? 'pass' : (words>=200? 'warn':'fail'), details:{ words }, fix:'Increase content depth; cover user questions and subtopics.', page:url, category:'onpage_seo' });

  // ——— Entity Trust extras
  const hasOrgSchema = /"@type"\s*:\s*"(Organization|LocalBusiness)"/i.test(html);
  issues.push({ id:'entity_schema_org', status: hasOrgSchema ? 'pass' : 'warn', fix:'Add Organization/LocalBusiness JSON-LD.', page:url, category:'entity_trust' });

  const hasTel = /\btel:\s*/i.test(html) || /\btelephone["']\s*:\s*["'][+0-9(][^"']+["']/i.test(html);
  const hasAddress = /"address"\s*:\s*{[\s\S]*?"streetAddress"[\s\S]*?}/i.test(html);
  issues.push({ id:'entity_nap', status: (hasTel || hasAddress) ? 'pass' : 'warn', details:{ hasTel, hasAddress }, fix:'Expose business phone and postal address (JSON-LD or visible).', page:url, category:'entity_trust' });

  const hasSocial = /(sameAs|facebook\.com|twitter\.com|x\.com|instagram\.com|linkedin\.com|youtube\.com)/i.test(html);
  issues.push({ id:'entity_social_profiles', status: hasSocial ? 'pass' : 'warn', fix:'Add sameAs links to major social profiles.', page:url, category:'entity_trust' });

  // ——— Hygiene
  const hasFavicon = /<link[^>]+rel=['"](icon|shortcut icon)['"][^>]*>/i.test(html) || /\/favicon\.ico\b/i.test(html);
  issues.push({ id:'hygiene_favicon', status: hasFavicon ? 'pass' : 'warn', fix:'Add <link rel="icon"> or /favicon.ico.', page:url, category:'hygiene' });

  const hasManifest = /<link[^>]+rel=['"]manifest['"][^>]*>/i.test(html);
  issues.push({ id:'hygiene_manifest', status: hasManifest ? 'pass' : 'warn', fix:'Add a web app manifest (optional).', page:url, category:'hygiene' });

  const hasCharset = /<meta[^>]+charset=/i.test(html);
  issues.push({ id:'hygiene_charset', status: hasCharset ? 'pass' : 'warn', fix:'Add <meta charset="utf-8"> early in <head>.', page:url, category:'hygiene' });

  const hasHtmlLang = /<html[^>]+lang=("|')[a-z-]+/i.test(html);
  issues.push({ id:'hygiene_html_lang', status: hasHtmlLang ? 'pass' : 'warn', fix:'Set <html lang="en-GB"> (or appropriate).', page:url, category:'hygiene' });

  const hasCopyrightThisYear = new RegExp(String(THIS_YEAR)).test(html);
  issues.push({ id:'hygiene_copyright_year', status: hasCopyrightThisYear ? 'pass' : 'warn', fix:`Update footer copyright to ${THIS_YEAR}.`, page:url, category:'hygiene' });

  return issues;
}

// ————————————————————————————————————————————
// Scoring
// ————————————————————————————————————————————
const statusToScore: Record<string, number> = { pass: 1, warn: 0.5, fail: 0 };
function scoreCategories(issues: Issue[]) {
  const weights: Record<string, Record<string, number>> = {
    technical_seo: { viewport_meta:2, meta_robots:4, canonical_tag:4, https_mixed_content:3 },
    onpage_seo: { title_tag:6, meta_description:4, h1_tag:4, heading_hierarchy:2, image_alt:3, image_lazy:2, image_filename:1, internal_links:5, word_count:3, publish_date:2 },
    entity_trust: { open_graph:2, entity_schema_org:4, entity_nap:3, entity_social_profiles:1 },
    hygiene: { hygiene_favicon:1, hygiene_manifest:1, hygiene_charset:2, hygiene_html_lang:2, hygiene_copyright_year:1 },
  };
  const overallWeights = { technical_seo: 35, onpage_seo: 35, entity_trust: 20, hygiene: 10 } as const;
  const categories = Object.keys(overallWeights) as (keyof typeof overallWeights)[];
  const byId = new Map(issues.map(i => [i.id, i] as const));
  let overall = 0;
  const out: { id: string; score: number; weighted: number }[] = [];
  for (const cat of categories) {
    const map = weights[cat] || {};
    const entries = Object.entries(map);
    const sumW = entries.reduce((s,[,w])=>s+w,0)||1;
    const raw = entries.reduce((s,[id,w])=> s + (statusToScore[byId.get(id)?.status || 'fail'] * w), 0);
    const pct = (raw / sumW) * 100;
    const weighted = pct * (overallWeights[cat]/100);
    overall += weighted;
    out.push({ id: cat, score: Math.round(pct), weighted: Math.round(weighted) });
  }
  const grade = overall >= 90 ? 'A' : overall >= 80 ? 'B' : overall >= 70 ? 'C' : overall >= 60 ? 'D' : 'F';
  return { overall: Math.round(overall), grade, categories: out };
}

// ————————————————————————————————————————————
// Core files check
// ————————————————————————————————————————————
async function checkCoreFiles(origin: string) {
  const targets = [
    { key:'robots', path:'/robots.txt' },
    { key:'sitemap', path:'/sitemap.xml' },
    { key:'llm', path:'/llm.txt' },
    { key:'llm', path:'/ai.txt' },
    { key:'llm', path:'/ai.json' },
    { key:'llm', path:'/.well-known/ai-plugin.json' },
  ];
  const files: any = { robots: { exists: false }, sitemap: { exists: false }, llm: { exists: false } };
  for (const t of targets) {
    const u = origin + t.path;
    const res = await fetch(u, { redirect:'follow' });
    if (res.ok) {
      const lastModified = res.headers.get('last-modified') || undefined;
      if (t.key==='robots') files.robots = { exists:true, url:u, lastModified };
      if (t.key==='sitemap') files.sitemap = { exists:true, url:u, lastModified };
      if (t.key==='llm') files.llm = { exists:true, url:u, lastModified };
    }
  }
  return files;
}

// ————————————————————————————————————————————
// Optional Companies House enrichment (UK)
// ————————————————————————————————————————————
async function companiesHouseOwnerGuess(nameGuess: string) {
  const KEY = process.env.COMPANIES_HOUSE_KEY; if (!KEY || !nameGuess) return [] as any[];
  try {
    const s = await fetch(`https://api.company-information.service.gov.uk/advanced-search/companies?q=${encodeURIComponent(nameGuess)}`, {
      headers:{ Authorization:'Basic '+Buffer.from(KEY+':').toString('base64') }, cache:'no-store'
    });
    if (!s.ok) return [] as any[];
    const sj = await s.json() as any;
    const item = sj.items?.[0];
    if (!item?.company_number) return [] as any[];
    const off = await fetch(`https://api.company-information.service.gov.uk/company/${item.company_number}/officers`, {
      headers:{ Authorization:'Basic '+Buffer.from(KEY+':').toString('base64') }
    });
    if (!off.ok) return [] as any[];
    const oj = await off.json() as any;
    return (oj.items||[]).slice(0,5).map((o:any)=>({
      name:o.name, title:o.officer_role?.replace(/_/g,' '),
      source:'companies_house',
      sourceUrl:`https://find-and-update.company-information.service.gov.uk/company/${item.company_number}`,
      confidence:0.7
    }));
  } catch { return [] as any[]; }
}

// ————————————————————————————————————————————
// Single-site audit
// ————————————————————————————————————————————
async function auditOne(origin: string, options: any, PSI_KEY?: string) {
  const home = await fetchText(origin);
  if (!home.ok) throw new Error(`Failed to fetch ${origin}`);

  const jsonld = extractJsonLd(home.text);
  const detectedTypes = extractSchemaTypes(jsonld);
  const suggestions = RECOMMENDED_SCHEMA.filter(t=>!detectedTypes.includes(t)).slice(0,10);

  const files = await checkCoreFiles(origin);

  let mobileScore: number | undefined, desktopScore: number | undefined, topActions: string[] = [];
  try {
    const [m,d] = await Promise.all([runPSI(origin,'mobile',PSI_KEY), runPSI(origin,'desktop',PSI_KEY)]);
    const mScore = m?.lighthouseResult?.categories?.performance?.score;
    const dScore = d?.lighthouseResult?.categories?.performance?.score;
    mobileScore = typeof mScore==='number'? Math.round(mScore*100):undefined;
    desktopScore = typeof dScore==='number'? Math.round(dScore*100):undefined;
    topActions = unique([ ...pickTopActions(m), ...pickTopActions(d) ]).slice(0,10);
  } catch { /* PSI optional; leave undefined on failure */ }

  const baseIssues = evaluateHome(home.text, home.headers, origin);

  const brandGuess = (()=> {
    const t = /<title>([\s\S]*?)<\/title>/i.exec(home.text)?.[1] || '';
    const org = jsonld.find(x=>x?.['@type']==='Organization' && x.name)?.name as string | undefined;
    const first = org || t.split('|')[0]?.trim() || t.split('–')[0]?.trim();
    return first || '';
  })();
  const pages = await crawlSmall(origin);
  const { best } = discoverContacts(pages);
  const ownerCandidates = options?.enrichment ? await companiesHouseOwnerGuess(brandGuess) : [];

  const scored = scoreCategories(baseIssues);

  return {
    target: origin,
    summary: { overall: scored.overall, grade: scored.grade },
    categories: scored.categories,
    issues: baseIssues,
    files,
    schema: { detectedTypes, suggestions },
    pagespeed: { mobileScore, desktopScore, topActions },
    contacts: { best: best ? { label: best.value, value: best.value, sourceUrl: best.sourceUrl } : null, ownerCandidates }
  };
}

// ————————————————————————————————————————————
// Handler
// ————————————————————————————————————————————
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const input = body.url;
    const options = body.options || {};
    const PSI_KEY = process.env.PSI_API_KEY;
    const N8N = process.env.N8N_WEBHOOK_URL;

    const list: string[] = Array.isArray(input) ? input.map(normaliseOrigin) : [normaliseOrigin(input)];
    const dedup = Array.from(new Set(list.filter(Boolean))).slice(0, 10);

    const results = await Promise.all(dedup.map((origin) => auditOne(origin, options, PSI_KEY)));

    if (N8N) {
      try { await fetch(N8N, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ results }) }); } catch {}
    }

    return NextResponse.json(results.length === 1 ? results[0] : results, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Unexpected error' }, { status: 500 });
  }
}