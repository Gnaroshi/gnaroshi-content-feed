import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import matter from "gray-matter";
import { imageSize } from "image-size";

const { values } = parseArgs({ options: {
  "feed-root": { type: "string" },
  "contract-root": { type: "string" },
  json: { type: "boolean", default: false }
} });
const feedRoot = resolve(values["feed-root"] ?? process.cwd());
const contractRoot = resolve(values["contract-root"] ?? feedRoot);
const issues = [];
const addIssue = (code, path, message) => issues.push({ code, path, message });
const toPosix = (path) => path.split(sep).join("/");

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function filesUnder(root, current = root) {
  if (!await exists(current)) return [];
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, path));
    else if (entry.isFile()) files.push(toPosix(relative(root, path)));
  }
  return files.sort();
}

async function readJson(path, fallback) {
  const absolute = join(feedRoot, path);
  if (!await exists(absolute)) {
    if (arguments.length > 1) return fallback;
    addIssue("missing-file", path, "Required JSON file is missing.");
    return null;
  }
  try { return JSON.parse(await readFile(absolute, "utf8")); }
  catch (error) { addIssue("invalid-json", path, error.message); return null; }
}

function normalizeFrontmatter(value, key = "") {
  if (value instanceof Date) {
    return ["publishDate", "updatedDate", "nextReviewAt", "date"].includes(key)
      ? value.toISOString().slice(0, 10)
      : value.toISOString();
  }
  if (Array.isArray(value)) return value.map((item) => normalizeFrontmatter(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, normalizeFrontmatter(child, childKey)]));
  return value;
}

async function loadSchemas() {
  const index = JSON.parse(await readFile(join(contractRoot, "schemas/index.json"), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  addFormats(ajv);
  ajv.addSchema(index);
  const validators = {};
  for (const [name, path] of Object.entries(index.schemas)) {
    const schema = JSON.parse(await readFile(join(contractRoot, "schemas", path), "utf8"));
    ajv.addSchema(schema);
    validators[name] = ajv.getSchema(schema.$id);
  }
  return { index, validators };
}

function validateRecord(validator, value, path) {
  if (!validator(value)) {
    for (const error of validator.errors ?? []) addIssue("schema", path, `${error.instancePath || "/"} ${error.message}`);
    return false;
  }
  return true;
}

async function loadMdx(kind, validators) {
  const records = [];
  for (const locale of ["en", "ko"]) {
    const root = join(feedRoot, kind, locale);
    for (const path of (await filesUnder(root)).filter((item) => /\.(md|mdx)$/.test(item))) {
      const relativePath = `${kind}/${locale}/${path}`;
      try {
        const parsed = matter(await readFile(join(root, path), "utf8"));
        const data = normalizeFrontmatter(parsed.data);
        validateRecord(validators[kind === "blog" ? "blogPost" : "paper"], data, relativePath);
        if (data.locale !== locale) addIssue("locale-path", relativePath, `Frontmatter locale ${data.locale} does not match ${locale}.`);
        records.push({ kind, locale, path: relativePath, data, body: parsed.content });
      } catch (error) { addIssue("invalid-mdx", relativePath, error.message); }
    }
  }
  return records;
}

function validateArray(records, validator, path) {
  if (!Array.isArray(records)) { addIssue("schema", path, "Expected an array."); return []; }
  records.forEach((record, index) => validateRecord(validator, record, `${path}[${index}]`));
  return records;
}

function unique(values, code, path, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) addIssue(code, path, `Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stableValue(child)]));
  return value;
}

function hashManagedFiles(files) {
  const hash = createHash("sha256");
  for (const [path, content] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(path, "utf8"); hash.update("\0", "utf8"); hash.update(content); hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function weekId(date = new Date()) {
  const cursor = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = cursor.getUTCDay() || 7;
  cursor.setUTCDate(cursor.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(cursor.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((cursor - yearStart) / 86400000) + 1) / 7);
  return `${cursor.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function scanPrivacy(value, path, allowlist) {
  const hiddenKeys = new Set(["privateNotes", "privateReflections", "selfReflection", "sourceExcerpt", "transcript", "fullTranscript", "response", "localPdfPath", "privateAttachments", "apiPrompt", "apiPrompts", "hidden", "hiddenFields", "hiddenReviewDetails"]);
  if (Array.isArray(value)) return value.forEach((item, index) => scanPrivacy(item, `${path}[${index}]`, allowlist));
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (hiddenKeys.has(key)) addIssue("private-field", path, `Forbidden public field: ${key}`);
      scanPrivacy(child, `${path}.${key}`, allowlist);
    }
    return;
  }
  if (typeof value !== "string" || allowlist.approvedExactValues.includes(value)) return;
  const patterns = [
    ["local-user-path", /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/], ["private-repository", /gnaroshi-(?:paper-lab|writing)(?:\/|\\|$)/i],
    ["local-pdf", /(?:file:\/\/|\/[^\s]+\.pdf\b|[A-Za-z]:\\[^\s]+\.pdf\b)/i], ["dataset-mount", /(?:\/mnt\/|\/datasets?\/|\/Volumes\/[^\s]+\/datasets?\/)/i],
    ["localhost-url", /(?:https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)|file:\/\/)/i], ["internal-host", /(?:https?:\/\/[^\s/]+\.(?:internal|local)\b|https?:\/\/(?:10\.|192\.168\.))/i],
    ["api-key", /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/],
    ["api-key-assignment", /\b(?:api[_-]?key|cloudflare[_-]?token|secret[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9._-]{16,}/i],
    ["bearer-token", /\bbearer\s+[A-Za-z0-9._-]{16,}\b/i], ["ssh-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/]
  ];
  for (const [code, pattern] of patterns) if (pattern.test(value)) addIssue(code, path, `Privacy pattern ${code} is present.`);
  for (const email of value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []) {
    if (!allowlist.approvedEmails.includes(email.toLowerCase())) addIssue("unapproved-email", path, `Email address is not approved: ${email}`);
  }
}

async function main() {
  const { validators } = await loadSchemas();
  const manifest = await readJson("manifest.json");
  if (!manifest) throw new Error("manifest.json is required");
  validateRecord(validators.manifest, manifest, "manifest.json");
  if (manifest.state === "invalid") addIssue("invalid-state", "manifest.json", "A feed in invalid state cannot be consumed.");

  const [blogs, papers] = await Promise.all([loadMdx("blog", validators), loadMdx("papers", validators)]);
  const reviews = validateArray(await readJson("data/reviews/index.json"), validators.paperReview, "data/reviews/index.json");
  const oralExams = validateArray(await readJson("data/oral-exams/index.json"), validators.oralExam, "data/oral-exams/index.json");
  const formulaRecalls = validateArray(await readJson("data/formula-recall/index.json"), validators.formulaRecall, "data/formula-recall/index.json");
  const implementations = validateArray(await readJson("data/implementations/index.json"), validators.implementation, "data/implementations/index.json");
  const activity = await readJson("data/activity-calendar.json");
  validateRecord(validators.activityCalendar, activity, "data/activity-calendar.json");
  const growth = await readJson("data/growth-snapshot.json");
  validateRecord(validators.growthSnapshot, growth, "data/growth-snapshot.json");
  const weekly = validateArray(await readJson("data/weekly-reviews/index.json"), validators.weeklyReview, "data/weekly-reviews/index.json");
  const graph = await readJson("data/research-graph.json");
  if (graph !== null) validateRecord(validators.researchGraph, graph, "data/research-graph.json");
  const assets = validateArray(await readJson("assets/index.json"), validators.asset, "assets/index.json");

  const paperIdList = papers.map((record) => record.data.id);
  unique(paperIdList, "duplicate-id", "papers", "paper ID");
  const paperIds = new Set(paperIdList);

  const expectedActivity = new Map();
  for (const paper of papers) {
    for (const session of paper.data.readingSessions ?? []) {
      const day = expectedActivity.get(session.date) ?? { date: session.date, readingSessions: 0, distinctPapersTouched: 0, readingMinutes: 0, activeDay: false, completedPasses: 0, revisits: 0, implementations: 0, deepSessions: 0, paperIds: [] };
      day.readingSessions += 1;
      day.readingMinutes += session.minutes;
      day.activeDay = true;
      day.completedPasses += session.completedPasses ?? (session.outcome === "completed" && String(session.pass).startsWith("pass") ? 1 : 0);
      day.revisits += session.pass === "revisit" ? 1 : 0;
      day.implementations += session.pass === "implementation" ? 1 : 0;
      day.deepSessions += session.deep ? 1 : 0;
      day.paperIds = [...new Set([...day.paperIds, paper.data.id])].sort();
      day.distinctPapersTouched = day.paperIds.length;
      expectedActivity.set(session.date, day);
    }
  }
  const expectedActivityList = [...expectedActivity.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (JSON.stringify(stableValue(activity)) !== JSON.stringify(stableValue(expectedActivityList))) addIssue("activity-mismatch", "data/activity-calendar.json", "Activity calendar does not exactly match public reading sessions.");
  unique(blogs.map((record) => record.data.id), "duplicate-id", "blog", "blog ID");
  for (const [records, label] of [[reviews, "review"], [oralExams, "oral exam"], [formulaRecalls, "formula recall"]]) {
    for (const record of records) if (!paperIds.has(record.paperId)) addIssue("dangling-paper", label, `${record.id} references missing paper ${record.paperId}.`);
  }

  const graphNodeIds = new Set((graph?.nodes ?? []).map((node) => node.id));
  unique([...graphNodeIds], "duplicate-graph-node", "data/research-graph.json", "graph node ID");
  unique((graph?.edges ?? []).map((edge) => edge.id), "duplicate-graph-edge", "data/research-graph.json", "graph edge ID");
  for (const edge of graph?.edges ?? []) {
    if (!graphNodeIds.has(edge.sourceId) || !graphNodeIds.has(edge.targetId)) addIssue("dangling-graph-edge", edge.id, `${edge.sourceId} -> ${edge.targetId} references a missing node.`);
    if (edge.sourceId === edge.targetId) addIssue("self-graph-edge", edge.id, "Graph self-edges are not public evidence.");
  }
  if (graph) {
    if (Boolean(graph.eligible) !== Boolean(manifest.graphEligible)) addIssue("graph-eligibility", "data/research-graph.json", "Graph eligibility disagrees with manifest.");
    const meaningfulEdges = graph.edges.filter((edge) => !["tagged", "relates-to"].includes(edge.relation)).length;
    if (graph.eligible && meaningfulEdges < graph.eligibilityThreshold) addIssue("graph-threshold", "data/research-graph.json", "Eligible graph does not meet its meaningful edge threshold.");
  } else if (manifest.graphEligible) addIssue("graph-missing", "manifest.json", "Manifest marks a missing graph eligible.");

  const projectNodeIds = new Set((graph?.nodes ?? []).filter((node) => node.nodeType === "project").map((node) => node.id.replace(/^project:/, "")));
  for (const item of implementations) {
    for (const paperId of item.paperIds) if (!paperIds.has(paperId)) addIssue("dangling-implementation-paper", item.id, `Missing paper ${paperId}.`);
    for (const projectId of item.projectIds) if (!projectNodeIds.has(projectId)) addIssue("dangling-implementation-project", item.id, `Missing public project graph node ${projectId}.`);
  }

  const translations = [...blogs, ...papers];
  unique(translations.map((record) => `${record.kind}:${record.locale}:${record.data.translationKey}`), "duplicate-translation-key", "content", "translation key per locale");
  const groups = new Map();
  for (const record of translations) {
    const key = `${record.kind}:${record.data.translationKey}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  for (const [key, records] of groups) {
    const locales = new Set(records.map((record) => record.locale));
    for (const record of records) {
      if (record.data.translationStatus === "complete" && locales.size !== 2) addIssue("translation-status", record.path, `${key} is complete without a public pair.`);
      if (record.data.translationStatus === "partial" && locales.size !== 2) addIssue("translation-status", record.path, `${key} is partial without a public pair.`);
      if (record.data.translationStatus === "source-only" && locales.size !== 1) addIssue("translation-status", record.path, `${key} is source-only but has a public pair.`);
    }
  }

  const reserved = new Set(["archive", "tags", "assets", "404", "rss", "index"]);
  const routes = [];
  for (const record of translations) {
    for (const slug of [record.data.canonicalSlug, ...(record.data.aliases ?? [])]) {
      const route = `${record.kind}:${record.locale}:${slug}`;
      routes.push(route);
      if (reserved.has(slug)) addIssue("reserved-route", record.path, `Slug ${slug} collides with a reserved route.`);
    }
  }
  unique(routes, "duplicate-route", "content", "public route or alias");

  const declaredAssets = new Map(assets.map((asset) => [asset.publicPath.replace(/^\//, ""), asset]));
  unique(assets.map((asset) => asset.id), "duplicate-asset", "assets/index.json", "asset ID");
  unique(assets.map((asset) => asset.publicPath), "duplicate-asset", "assets/index.json", "asset path");
  const assetFiles = (await filesUnder(join(feedRoot, "assets"))).filter((path) => ![".gitkeep", "index.json"].includes(path));
  for (const path of assetFiles) {
    const declared = declaredAssets.get(`assets/${path}`);
    if (!declared) { addIssue("undeclared-asset", `assets/${path}`, "Binary asset is not declared."); continue; }
    const content = await readFile(join(feedRoot, "assets", path));
    const hash = createHash("sha256").update(content).digest("hex");
    if (hash !== declared.contentHash || !path.startsWith(`${hash}/`)) addIssue("asset-hash", `assets/${path}`, "Asset bytes, declaration, and hashed path disagree.");
    if (content.byteLength !== declared.byteSize) addIssue("asset-size", `assets/${path}`, "Declared byte size does not match file.");
    if (declared.mediaType === "image/svg+xml") {
      const svg = content.toString("utf8");
      if (/<(?:script|foreignObject)\b|\son\w+=|(?:href|xlink:href)=["'](?:https?:|\/\/)/i.test(svg)) addIssue("unsafe-svg", `assets/${path}`, "SVG contains executable or external content.");
    } else {
      try {
        const dimensions = imageSize(content);
        if (dimensions.width !== declared.width || dimensions.height !== declared.height) addIssue("asset-dimensions", `assets/${path}`, "Declared dimensions do not match image bytes.");
      } catch (error) { addIssue("invalid-asset", `assets/${path}`, error.message); }
    }
  }
  for (const [path] of declaredAssets) if (!assetFiles.includes(path.replace(/^assets\//, ""))) addIssue("missing-asset", path, "Declared asset file is missing.");
  const referencedAssets = translations.flatMap((record) => [
    record.data.heroImage, record.data.ogImage, ...(record.data.assets ?? []),
    ...[...record.body.matchAll(/(?:\(|["'])((?:\/assets\/)[a-f0-9]{64}\/[^)"'\s]+)/g)].map((match) => match[1])
  ].filter(Boolean));
  for (const record of translations) {
    for (const match of record.body.matchAll(/\/assets\/[^)"'\s]+/g)) {
      if (!/^\/assets\/[a-f0-9]{64}\/[^/]+$/.test(match[0])) addIssue("unhashed-asset-reference", record.path, `Content references a non-content-addressed asset: ${match[0]}`);
    }
  }
  for (const path of referencedAssets) if (!declaredAssets.has(path.replace(/^\//, ""))) addIssue("undeclared-asset-reference", path, "Content references an undeclared asset.");

  for (const review of weekly) {
    if (review.weekId === weekId() && review.state === "complete" && !review.closedAt) addIssue("weekly-current-state", review.id, "Current week cannot be complete without closedAt.");
    if (review.meaningfulEventCount < 3 && (review.strongestDimension || review.weakestDimension)) addIssue("weekly-evidence", review.id, "Strongest/weakest dimensions require at least three meaningful events.");
  }

  const actualCounts = {
    papers: papers.length, blogPosts: blogs.length,
    readingSessions: papers.reduce((sum, record) => sum + (record.data.readingSessions?.length ?? 0), 0),
    reviews: reviews.length, oralExams: oralExams.length, formulaRecalls: formulaRecalls.length, implementations: implementations.length,
    activityDays: Array.isArray(activity) ? activity.length : 0, weeklyReviews: weekly.length,
    graphNodes: graph?.nodes?.length ?? 0, graphEdges: graph?.edges?.length ?? 0, assets: assets.length
  };
  for (const [key, value] of Object.entries(actualCounts)) if (manifest.counts?.[key] !== value) addIssue("manifest-count", "manifest.json", `${key}: manifest ${manifest.counts?.[key]}, actual ${value}.`);

  if (manifest.state === "bootstrap-empty") {
    if (Object.values(actualCounts).some((count) => count !== 0)) addIssue("bootstrap-content", "manifest.json", "bootstrap-empty contains public records.");
    if (growth !== null || graph !== null || weekly.length || (Array.isArray(activity) && activity.length)) addIssue("bootstrap-claim", "data", "bootstrap-empty contains generated research claims.");
  }
  if (manifest.state === "generated" && !manifest.generatedAt) addIssue("generated-at", "manifest.json", "Generated feed needs generatedAt.");

  const managed = new Map();
  for (const root of ["blog", "papers", "data", "assets"]) {
    for (const path of await filesUnder(join(feedRoot, root))) managed.set(`${root}/${path}`, await readFile(join(feedRoot, root, path)));
  }
  const reproducibleHash = hashManagedFiles(managed);
  if (manifest.contentHash !== reproducibleHash) addIssue("content-hash", "manifest.json", `Expected ${reproducibleHash}, found ${manifest.contentHash}.`);

  const allowlist = await readJson("config/privacy-allowlist.json", { approvedEmails: [], approvedExactValues: [] });
  const privacyValues = [manifest, ...translations.flatMap((record) => [record.data, record.body]), reviews, oralExams, formulaRecalls, implementations, activity, growth, weekly, graph, assets];
  privacyValues.forEach((value, index) => scanPrivacy(value, `public[${index}]`, allowlist));
  for (const asset of assets.filter((item) => item.mediaType === "image/svg+xml")) {
    const path = asset.publicPath.replace(/^\//, "");
    if (await exists(join(feedRoot, path))) scanPrivacy(await readFile(join(feedRoot, path), "utf8"), path, allowlist);
  }

  const result = { valid: issues.length === 0, feedRoot, schemaVersion: manifest.schemaVersion, state: manifest.state, counts: actualCounts, contentHash: reproducibleHash, issues };
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else if (result.valid) console.log(`[feed] valid schema v${result.schemaVersion} ${result.state} at ${feedRoot} (${reproducibleHash})`);
  else issues.forEach((issue) => console.error(`[${issue.code}] ${issue.path}: ${issue.message}`));
  if (!result.valid) process.exitCode = 1;
}

main().catch((error) => { console.error(`[feed-validator] ${error.stack ?? error.message}`); process.exitCode = 1; });
