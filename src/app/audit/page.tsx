"use client";
import React, { useMemo, useState } from "react";

/**
 * SEO Auditor – Multi-URL UI (up to 10)
 * - Paste 1–10 URLs (newline/comma/whitespace separated)
 * - Optional enrichment flag
 * - Calls POST /api/audit with either a single URL or an array of URLs
 * - Renders one collapsible result card per audited site
 */

/* Types (match the API route shape) */
type IssueStatus = "pass" | "warn" | "fail";
type Issue = {
  id: string;
  status: IssueStatus;
  details?: any;
  fix?: string;
  page?: string;
  category?: string;
};
type CategoryScore = { id: string; score: number; weighted: number };
type AuditPayload = {
  target: string;
  summary: { overall: number; grade: string };
  categories: CategoryScore[];
  issues: Issue[];
  files?: {
    robots?: { exists: boolean; url?: string; lastModified?: string };
    sitemap?: { exists: boolean; url?: string; lastModified?: string };
    llm?: { exists: boolean; url?: string; lastModified?: string };
  };
  schema?: { detectedTypes: string[]; suggestions: string[] };
  pagespeed?: { mobileScore?: number; desktopScore?: number; topActions?: string[] };
  contacts?: {
    best?: { label: string; value: string; sourceUrl?: string } | null;
    ownerCandidates?: Array<{ name?: string; title?: string; source?: string; sourceUrl?: string; confidence?: number }>;
  };
  // TEMP: debug field surfaced by API to explain PSI failures
  pagespeedDebug?: { mobileError?: string | null; desktopError?: string | null };
};

/* UI helpers */
const chip = {
  pass: "bg-green-100 text-green-800 border-green-300",
  warn: "bg-yellow-100 text-yellow-800 border-yellow-300",
  fail: "bg-red-100 text-red-800 border-red-300",
};
function StatusBadge({ status }: { status: IssueStatus }) {
  const cls = status === "pass" ? chip.pass : status === "warn" ? chip.warn : chip.fail;
  const label = status === "pass" ? "Pass" : status === "warn" ? "Warn" : "Fail";
  return <span className={`inline-flex items-center px-2 py-1 text-xs font-medium rounded-full border ${cls}`}>{label}</span>;
}
function ScoreRing({ value, size = 84 }: { value: number; size?: number }) {
  const circumference = 2 * Math.PI * 36;
  const clamped = Math.max(0, Math.min(100, value));
  const dash = (clamped / 100) * circumference;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className="overflow-visible">
      <circle cx="50" cy="50" r="36" className="stroke-gray-200" strokeWidth="10" fill="none" />
      <circle
        cx="50" cy="50" r="36"
        className="stroke-current text-blue-600"
        strokeDasharray={`${dash} ${circumference - dash}`}
        strokeLinecap="round"
        strokeWidth="10" fill="none"
        transform="rotate(-90 50 50)"
      />
      <text x="50" y="54" textAnchor="middle" className="fill-gray-900 font-semibold text-xl">
        {Math.round(value)}
      </text>
    </svg>
  );
}

/* Utils */
function normalizeOrigin(input: string): string | null {
  try {
    const u = new URL(input.startsWith("http") ? input : `https://${input}`);
    return new URL(u.origin).toString();
  } catch { return null; }
}
function parseMulti(input: string): string[] {
  const raw = input.split(/\r?\n|,|\s/).map((s) => s.trim()).filter(Boolean);
  const norms = raw.map(normalizeOrigin).filter((x): x is string => !!x);
  return Array.from(new Set(norms)).slice(0, 10);
}
function severityRank(s: IssueStatus) {
  return s === "fail" ? 0 : s === "warn" ? 1 : 2; // fail → warn → pass
}

/* Components */
function IssuesTable({ items }: { items: Issue[] }) {
  if (!items || !items.length) return null;
  const sorted = [...items].sort((a, b) => severityRank(a.status) - severityRank(b.status));
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="bg-gray-50 text-gray-600">
            <th className="px-4 py-3 text-left">Status</th>
            <th className="px-4 py-3 text-left">Check</th>
            <th className="px-4 py-3 text-left">Page</th>
            <th className="px-4 py-3 text-left">Details</th>
            <th className="px-4 py-3 text-left">Suggested Fix</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {sorted.map((i, idx) => (
            <tr key={idx} className="hover:bg-gray-50">
              <td className="px-4 py-3 whitespace-nowrap"><StatusBadge status={i.status} /></td>
              <td className="px-4 py-3 font-mono text-[11px]">{i.id}</td>
              <td className="px-4 py-3">{i.page ?? "—"}</td>
              <td className="px-4 py-3 text-gray-600">{i.details ? JSON.stringify(i.details) : "—"}</td>
              <td className="px-4 py-3">{i.fix ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Disclosure({ title, children, defaultOpen = false }: { title: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border rounded-xl">
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between px-4 py-3 text-left">
        <span className="font-medium">{title}</span>
        <span className="text-gray-500">{open ? "–" : "+"}</span>
      </button>
      {open && <div className="border-t px-4 py-4">{children}</div>}
    </div>
  );
}

/* Page */
export default function AuditPage() {
  const [urlsInput, setUrlsInput] = useState("");
  const [includeEnrichment, setIncludeEnrichment] = useState(true);
  const [useSample, setUseSample] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<AuditPayload[] | null>(null);

  const parsed = useMemo(() => parseMulti(urlsInput), [urlsInput]);
  const canSubmit = parsed.length > 0 && parsed.length <= 10 && !loading;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setProgress(null);
    setResults(null);

    const list = parsed;
    if (!list.length) { setError("Please add at least one valid URL"); return; }

    if (useSample) {
      const sample: AuditPayload = {
        target: "https://example.com",
        summary: { overall: 86, grade: "B" },
        categories: [
          { id: "technical_seo", score: 90, weighted: 32 },
          { id: "onpage_seo", score: 78, weighted: 27 },
          { id: "entity_trust", score: 74, weighted: 15 },
          { id: "hygiene", score: 92, weighted: 9 },
        ],
        issues: [
          { id: "heading_hierarchy", status: "warn", details: { order: ["H1", "H3", "H2"] }, fix: "Use logical H2/H3 order", page: "https://example.com" },
          { id: "image_lazy", status: "fail", details: { lazyRatio: 0.2 }, fix: "Add loading=\"lazy\" to non-critical images", page: "https://example.com" },
          { id: "title_tag", status: "pass" },
        ],
        files: { robots: { exists: true, url: "/robots.txt" }, sitemap: { exists: true, url: "/sitemap.xml" } },
        schema: { detectedTypes: ["Organization", "LocalBusiness"], suggestions: ["Service", "BreadcrumbList", "FAQPage"] },
        pagespeed: { mobileScore: 92, desktopScore: 99, topActions: ["Preload hero image", "Defer third-parties"] },
        contacts: { best: { label: "hello@example.com", value: "hello@example.com" }, ownerCandidates: [] },
      };
      setResults(list.map((t, i) => ({ ...sample, target: t, summary: { overall: 86 - i, grade: "B" } })));
      return;
    }

    setLoading(true);
    setProgress(`Auditing ${list.length === 1 ? list[0] : `${list.length} sites`}…`);

    try {
      const res = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: list.length === 1 ? list[0] : list, options: { enrichment: includeEnrichment } }),
      });
      if (!res.ok) throw new Error(`Audit failed (${res.status})`);
      const data = await res.json();
      const arr: AuditPayload[] = Array.isArray(data) ? data : [data];
      setResults(arr);
      setProgress(null);
    } catch (err: any) {
      setError(err.message || "Something went wrong running the audit.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 flex flex-col">
      <div className="mx-auto max-w-6xl px-4 py-10 w-full">
        <header className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-gray-900">SEO Auditor</h1>
          <p className="mt-2 text-gray-600">
            Batch-audit up to 10 sites. Expanded on-page checks like heading hierarchy, lazy-loading, filenames, internal links, and publish date.
          </p>
        </header>

        <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow p-5 md:p-6 border border-gray-100">
          <div className="grid gap-4 md:grid-cols-12 items-start">
            <div className="md:col-span-8">
              <label className="block text-sm font-medium text-gray-700">Enter up to 10 URLs (one per line)</label>
              <textarea
                value={urlsInput}
                onChange={(e) => setUrlsInput(e.target.value)}
                placeholder={"https://example.com\nexample.org\nhttps://sub.domain.tld"}
                className="mt-1 w-full rounded-xl border-gray-300 focus:border-blue-500 focus:ring-blue-500 min-h-[120px]"
              />
              <p className="mt-1 text-xs text-gray-500">Detected: {parsed.length}/10</p>
            </div>

            <div className="md:col-span-2 flex items-center gap-2">
              <input id="enrich" type="checkbox" checked={includeEnrichment} onChange={(e) => setIncludeEnrichment(e.target.checked)} />
              <label htmlFor="enrich" className="text-sm text-gray-700">Use enrichment</label>
            </div>

            <div className="md:col-span-2 flex gap-2 md:justify-end">
              <button
                type="button"
                onClick={() => setUseSample((v) => !v)}
                className={`px-4 py-2 rounded-xl border ${useSample ? "border-blue-600 text-blue-700 bg-blue-50" : "border-gray-300 text-gray-700"}`}
              >
                {useSample ? "Sample: ON" : "Use sample"}
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                className="px-5 py-2.5 rounded-xl bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {loading ? "Running…" : "Run Audit"}
              </button>
            </div>
          </div>

          {(error || progress) && (
            <div className="mt-3 text-sm">
              {error ? <p className="text-red-600">{error}</p> : <p className="text-gray-600">{progress}</p>}
            </div>
          )}
        </form>

        {/* Results */}
        {results && (
          <section className="mt-8 space-y-6">
            {results.map((res, idx) => (
              <div key={idx} className="bg-white rounded-2xl shadow border border-gray-100">
                <div className="p-6 flex items-center justify-between flex-wrap gap-4">
                  <div className="flex items-center gap-4">
                    <ScoreRing value={res.summary.overall} />
                    <div>
                      <div className="text-sm text-gray-500">{res.target}</div>
                      <div className="text-2xl font-bold">
                        {res.summary.overall}/100 <span className="text-gray-500 text-base">(Grade {res.summary.grade})</span>
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {res.categories.map((c) => (
                      <div key={c.id} className="rounded-xl border p-3">
                        <div className="text-xs text-gray-500">{c.id.replace(/_/g, " ")}</div>
                        <div className="text-xl font-semibold">{Math.round(c.score)}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="px-6 pb-6 space-y-4">
                  <Disclosure title="PageSpeed & Opportunities" defaultOpen>
                    <div className="grid md:grid-cols-3 gap-4">
                      <div className="rounded-xl border p-4">
                        <div className="text-sm text-gray-500">Scores</div>
                        <div className="mt-2 flex gap-6">
                          <div className="text-center">
                            <div className="text-xs text-gray-500">Mobile</div>
                            <div className="text-2xl font-semibold">{res.pagespeed?.mobileScore ?? "—"}</div>
                          </div>
                          <div className="text-center">
                            <div className="text-xs text-gray-500">Desktop</div>
                            <div className="text-2xl font-semibold">{res.pagespeed?.desktopScore ?? "—"}</div>
                          </div>
                        </div>
                        {(res as any).pagespeedDebug?.mobileError || (res as any).pagespeedDebug?.desktopError ? (
                          <p className="mt-2 text-xs text-red-600">
                            {(res as any).pagespeedDebug?.mobileError || (res as any).pagespeedDebug?.desktopError}
                          </p>
                        ) : null}
                      </div>
                      <div className="md:col-span-2 rounded-xl border p-4">
                        <div className="text-sm text-gray-500 mb-2">Top Actions</div>
                        {res.pagespeed?.topActions?.length ? (
                          <ul className="list-disc list-inside text-sm text-gray-700 space-y-1">
                            {res.pagespeed.topActions.map((a, i) => <li key={i}>{a}</li>)}
                          </ul>
                        ) : <p className="text-sm text-gray-500">No actions returned.</p>}
                      </div>
                    </div>
                  </Disclosure>

                  <Disclosure title="Core Files (robots / sitemap / LLM)">
                    <ul className="text-sm space-y-2">
                      <li>
                        <span className="font-medium">robots.txt:</span>{" "}
                        {res.files?.robots?.exists ? <a className="text-blue-600 hover:underline" href={res.files?.robots?.url} target="_blank">Present</a> : <span className="text-gray-600">Missing</span>}
                        {res.files?.robots?.lastModified && <span className="text-gray-500"> (last modified {res.files.robots.lastModified})</span>}
                      </li>
                      <li>
                        <span className="font-medium">sitemap.xml:</span>{" "}
                        {res.files?.sitemap?.exists ? <a className="text-blue-600 hover:underline" href={res.files?.sitemap?.url} target="_blank">Present</a> : <span className="text-gray-600">Missing</span>}
                        {res.files?.sitemap?.lastModified && <span className="text-gray-500"> (last modified {res.files.sitemap.lastModified})</span>}
                      </li>
                      <li>
                        <span className="font-medium">LLM file:</span>{" "}
                        {res.files?.llm?.exists ? <a className="text-blue-600 hover:underline" href={res.files?.llm?.url} target="_blank">Present</a> : <span className="text-gray-600">Missing</span>}
                        {res.files?.llm?.lastModified && <span className="text-gray-500"> (last modified {res.files.llm.lastModified})</span>}
                      </li>
                    </ul>
                  </Disclosure>

                  {(res.schema?.detectedTypes?.length || res.schema?.suggestions?.length) && (
                    <Disclosure title="Schema">
                      <div className="grid md:grid-cols-2 gap-4">
                        <div>
                          <div className="text-sm text-gray-500 mb-2">Detected</div>
                          {res.schema?.detectedTypes?.length ? (
                            <div className="flex flex-wrap gap-2">
                              {res.schema.detectedTypes.map((t) => (
                                <span key={t} className="px-2 py-1 rounded-full bg-gray-100 text-gray-800 text-xs border">
                                  {t}
                                </span>
                              ))}
                            </div>
                          ) : <p className="text-sm text-gray-500">None detected.</p>}
                        </div>
                        <div>
                          <div className="text-sm text-gray-500 mb-2">Suggestions</div>
                          {res.schema?.suggestions?.length ? (
                            <div className="flex flex-wrap gap-2">
                              {res.schema.suggestions.map((t) => (
                                <span key={t} className="px-2 py-1 rounded-full bg-blue-50 text-blue-800 text-xs border border-blue-200">
                                  {t}
                                </span>
                              ))}
                            </div>
                          ) : <p className="text-sm text-gray-500">No suggestions.</p>}
                        </div>
                      </div>
                    </Disclosure>
                  )}

                  <Disclosure title="Issues (expanded on-page checks)" defaultOpen>
                    <IssuesTable items={res.issues} />
                  </Disclosure>

                  {(res.contacts?.best || (res.contacts?.ownerCandidates && res.contacts.ownerCandidates.length)) && (
                    <Disclosure title="Outreach targets">
                      <div className="space-y-3 text-sm">
                        {res.contacts?.best && (
                          <div>
                            <div className="text-gray-500">Best</div>
                            <div>
                              <a className="text-blue-600 hover:underline" href={res.contacts.best.sourceUrl || "#"} target="_blank" rel="noreferrer">
                                {res.contacts.best.label}
                              </a>
                            </div>
                          </div>
                        )}
                        {res.contacts?.ownerCandidates?.length ? (
                          <div>
                            <div className="text-gray-500 mb-1">Owner candidates (Companies House)</div>
                            <ul className="list-disc list-inside space-y-1">
                              {res.contacts.ownerCandidates.map((c, i) => (
                                <li key={i}>
                                  <span className="font-medium">{c.name}</span>
                                  {c.title ? <span className="text-gray-600"> — {c.title}</span> : null}
                                  {c.sourceUrl ? (
                                    <> <a className="text-blue-600 hover:underline" href={c.sourceUrl} target="_blank" rel="noreferrer">source</a> </>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </div>
                    </Disclosure>
                </div>
              </div>
            ))}
          </section>
        )}

        {!results && (
          <div className="mt-8 rounded-2xl border border-dashed border-gray-300 p-8 text-center text-gray-500">
            Enter up to 10 URLs to run a batch audit with expanded on-page checks.
          </div>
        )}
      </div>

      {/* Footer with backlink */}
      <footer className="mt-auto border-t bg-white">
        <div className="mx-auto max-w-6xl px-4 py-6 text-sm text-gray-600">
          Delivered by{" "}
          <a href="https://postino.cc" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
            Postino — Growth, AI &amp; Automation Solution Experts
          </a>.
        </div>
      </footer>
    </main>
  );
}
