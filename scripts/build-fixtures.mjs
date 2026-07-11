import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import matter from "gray-matter";

const root = resolve("fixtures");
const timestamp = "2026-07-11T00:00:00.000Z";
const sourceCommits = { paperLab: "1".repeat(40), writing: "2".repeat(40) };

const base = (id) => ({
  id, schemaVersion: 1, createdAt: timestamp, updatedAt: timestamp, visibility: "public",
  contentStage: "substantive", metricEligible: false, graphEligible: false, weeklyReviewEligible: false
});

const blog = (id, locale = "en", translationKey = id, translationStatus = "source-only", canonicalSlug = id) => ({
  ...base(id), category: "research-note", locale, translationKey, translationStatus, canonicalSlug, aliases: [], title: `Post ${id}`,
  description: `Public description for ${id}.`, publishDate: "2026-07-11", tags: ["research"], featured: false, assets: []
});

const paper = (id = "paper-one", locale = "en", translationKey = id, translationStatus = "source-only", canonicalSlug = id) => ({
  ...base(id), locale, translationKey, translationStatus, canonicalSlug, aliases: [locale === "ko" ? "old-korean-paper-slug" : "old-paper-slug"],
  title: "A Public Paper", authors: ["Author One"], venue: "Conference", year: 2026, status: "pass2", depth: "understand",
  priority: "medium", difficulty: 3, tags: ["ai"], relatedTopics: ["systems"], featured: false, assets: []
});

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeMdx(path, frontmatter, body = "Public fixture body.\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, matter.stringify(body, frontmatter));
}

async function listManaged(feed, current = feed) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const relativePath = relative(feed, path).split(sep).join("/");
    if (!/^(?:blog|papers|data|assets)(?:\/|$)/.test(relativePath)) continue;
    if (entry.isDirectory()) files.push(...await listManaged(feed, path));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files.sort();
}

async function hashFeed(feed) {
  const hash = createHash("sha256");
  for (const path of await listManaged(feed)) {
    hash.update(path); hash.update("\0"); hash.update(await readFile(join(feed, path))); hash.update("\0");
  }
  return hash.digest("hex");
}

async function createFeed(name, configure = async () => {}, state = "generated") {
  const feed = join(root, name);
  await mkdir(feed, { recursive: true });
  for (const directory of ["blog/en", "blog/ko", "papers/en", "papers/ko", "data/reviews", "data/oral-exams", "data/formula-recall", "data/implementations", "data/weekly-reviews", "assets", "config"]) await mkdir(join(feed, directory), { recursive: true });
  const model = { blogs: [], papers: [], reviews: [], oralExams: [], formulaRecalls: [], implementations: [], activity: [], growth: null, weekly: [], graph: null, assets: [] };
  await configure(model, feed);
  for (const record of model.blogs) await writeMdx(join(feed, "blog", record.locale, `${record.canonicalSlug}.mdx`), record);
  for (const record of model.papers) await writeMdx(join(feed, "papers", record.locale, `${record.canonicalSlug}.mdx`), record);
  await writeJson(join(feed, "data/reviews/index.json"), model.reviews);
  await writeJson(join(feed, "data/oral-exams/index.json"), model.oralExams);
  await writeJson(join(feed, "data/formula-recall/index.json"), model.formulaRecalls);
  await writeJson(join(feed, "data/implementations/index.json"), model.implementations);
  await writeJson(join(feed, "data/activity-calendar.json"), model.activity);
  await writeJson(join(feed, "data/growth-snapshot.json"), model.growth);
  await writeJson(join(feed, "data/weekly-reviews/index.json"), model.weekly);
  await writeJson(join(feed, "data/research-graph.json"), model.graph);
  await writeJson(join(feed, "data/paper-index.json"), model.papers.map(({ id, locale, canonicalSlug, title }) => ({ id, locale, canonicalSlug, title })));
  await writeJson(join(feed, "assets/index.json"), model.assets);
  await writeJson(join(feed, "config/privacy-allowlist.json"), { approvedEmails: [], approvedExactValues: [] });
  for (const directory of ["blog/en", "blog/ko", "papers/en", "papers/ko", "assets"]) {
    const entries = await readdir(join(feed, directory));
    if (entries.length === 0) await writeFile(join(feed, directory, ".gitkeep"), "");
  }
  const counts = {
    papers: model.papers.length, blogPosts: model.blogs.length,
    readingSessions: model.papers.reduce((sum, item) => sum + (item.readingSessions?.length ?? 0), 0),
    reviews: model.reviews.length, oralExams: model.oralExams.length, formulaRecalls: model.formulaRecalls.length,
    implementations: model.implementations.length, activityDays: model.activity.length, weeklyReviews: model.weekly.length,
    graphNodes: model.graph?.nodes.length ?? 0, graphEdges: model.graph?.edges.length ?? 0, assets: model.assets.length
  };
  const manifest = {
    schemaVersion: 1, state, contentStage: state === "bootstrap-empty" ? "seed" : "substantive",
    metricEligible: false, graphEligible: Boolean(model.graph?.eligible), weeklyReviewEligible: false,
    generatedAt: state === "bootstrap-empty" ? null : timestamp, sourceCommits, counts,
    contentHash: await hashFeed(feed), generator: "fixture@1"
  };
  await writeJson(join(feed, "manifest.json"), manifest);
  return { feed, model, manifest };
}

await mkdir(root, { recursive: true });
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (entry.name !== "README.md") await rm(join(root, entry.name), { recursive: true, force: true });
}
await createFeed("bootstrap-empty", async () => {}, "bootstrap-empty");
await createFeed("one-english-blog", async (model) => { model.blogs.push(blog("english-only")); });
await createFeed("one-korean-blog", async (model) => { model.blogs.push(blog("korean-only", "ko")); });
await createFeed("translated-blog-pair", async (model) => {
  model.blogs.push({ ...blog("paired-en", "en", "paired", "complete", "renamed-english"), aliases: ["old-english-slug"] });
  model.blogs.push(blog("paired-ko", "ko", "paired", "complete", "renamed-korean"));
});
await createFeed("partial-blog-pair", async (model) => {
  model.blogs.push(blog("partial-en", "en", "partial-pair", "partial"));
  model.blogs.push(blog("partial-ko", "ko", "partial-pair", "partial"));
});
await createFeed("translated-paper-pair", async (model) => {
  model.papers.push(paper("paper-pair-en", "en", "paper-pair", "complete", "paper-pair-english"));
  model.papers.push({ ...paper("paper-pair-ko", "ko", "paper-pair", "complete", "paper-pair-korean"), title: "공개 논문 노트" });
});
await createFeed("one-paper-multiple-sessions", async (model) => {
  model.papers.push({ ...paper(), readingSessions: [
    { id: "session-1", date: "2026-07-10", pass: "pass1", minutes: 20, outcome: "completed", completedPasses: 1, deep: false },
    { id: "session-2", date: "2026-07-11", pass: "pass2", minutes: 45, outcome: "completed", completedPasses: 1, deep: true }
  ] });
  model.activity.push({ date: "2026-07-10", readingSessions: 1, distinctPapersTouched: 1, readingMinutes: 20, activeDay: true, completedPasses: 1, revisits: 0, implementations: 0, deepSessions: 0, paperIds: ["paper-one"] });
  model.activity.push({ date: "2026-07-11", readingSessions: 1, distinctPapersTouched: 1, readingMinutes: 45, activeDay: true, completedPasses: 1, revisits: 0, implementations: 0, deepSessions: 1, paperIds: ["paper-one"] });
});
await createFeed("one-simple-public-review", async (model) => {
  model.papers.push(paper());
  model.reviews.push({ id: "review-simple", schemaVersion: 1, visibility: "public", contentStage: "substantive", metricEligible: true, graphEligible: false, weeklyReviewEligible: true, paperId: "paper-one", reviewedAt: timestamp, reviewer: "ai", overallScore: 72, confidence: "medium", summary: "The main idea is supported by the note.", strengths: ["Clear question"], gaps: ["Experiment detail"], nextActions: ["Add exact evidence"] });
});
await createFeed("one-rich-review", async (model) => {
  model.papers.push(paper());
  model.reviews.push({ id: "review-rich", schemaVersion: 1, visibility: "public", contentStage: "substantive", metricEligible: true, graphEligible: false, weeklyReviewEligible: true, paperId: "paper-one", reviewedAt: timestamp, reviewer: "ai", overallScore: 86, confidence: "high", summary: "Evidence supports a strong understanding.", strengths: ["Method"], gaps: ["Limitations"], nextActions: ["Revisit assumptions"], dimensions: { method: { score: 8, feedback: "Clear", evidence: "Explains the mechanism", nextStep: "Test an edge case" } }, history: [{ reviewedAt: timestamp, overallScore: 86, dimensionScores: { method: 8 } }] });
});
await createFeed("one-implementation", async (model) => {
  model.papers.push(paper());
  model.implementations.push({ id: "implementation-one", schemaVersion: 1, visibility: "public", contentStage: "substantive", metricEligible: true, graphEligible: true, weeklyReviewEligible: true, paperIds: ["paper-one"], projectIds: [], date: "2026-07-11", status: "partially-reproduced", title: "Public implementation", goal: "Test the core method", result: "Partial reproduction", lessons: ["Document assumptions"], tags: ["implementation"] });
});
await createFeed("valid-graph", async (model) => {
  model.papers.push(paper()); model.blogs.push(blog("graph-post"));
  model.graph = { id: "research-graph", schemaVersion: 1, generatedAt: timestamp, eligible: true, eligibilityThreshold: 1,
    nodes: [
      { id: "paper:paper-one", nodeType: "paper", locale: "en", label: "A Public Paper", href: "/papers/paper-one/", tags: ["ai"] },
      { id: "post:graph-post", nodeType: "post", locale: "en", label: "Graph Post", href: "/blog/graph-post/", tags: ["research"] }
    ], edges: [{ id: "edge:one", sourceId: "post:graph-post", targetId: "paper:paper-one", relation: "writes-about", inferred: false }] };
});
const dangling = await createFeed("invalid-dangling-graph-edge", async (model) => {
  model.papers.push(paper()); model.graph = { id: "research-graph", schemaVersion: 1, generatedAt: timestamp, eligible: false, eligibilityThreshold: 1,
    nodes: [{ id: "paper:paper-one", nodeType: "paper", locale: "en", label: "A Public Paper", href: "/papers/paper-one/", tags: [] }],
    edges: [{ id: "edge:bad", sourceId: "paper:paper-one", targetId: "paper:missing", relation: "cites", inferred: false }] };
});
dangling.manifest.contentHash = await hashFeed(dangling.feed); await writeJson(join(dangling.feed, "manifest.json"), dangling.manifest);
const badCount = await createFeed("invalid-manifest-count", async (model) => { model.blogs.push(blog("counted")); });
badCount.manifest.counts.blogPosts = 2; await writeJson(join(badCount.feed, "manifest.json"), badCount.manifest);
const badActivity = await createFeed("invalid-activity-mismatch", async (model) => {
  model.papers.push({ ...paper(), readingSessions: [{ id: "session-1", date: "2026-07-11", pass: "pass1", minutes: 20, outcome: "completed", completedPasses: 1, deep: false }] });
  model.activity.push({ date: "2026-07-11", readingSessions: 1, distinctPapersTouched: 1, readingMinutes: 99, activeDay: true, completedPasses: 1, revisits: 0, implementations: 0, deepSessions: 0, paperIds: ["paper-one"] });
});
badActivity.manifest.contentHash = await hashFeed(badActivity.feed); await writeJson(join(badActivity.feed, "manifest.json"), badActivity.manifest);
const leak = await createFeed("private-leak", async (model) => { model.blogs.push({ ...blog("leak"), description: "Local source /Users/private/paper.pdf" }); });
leak.manifest.contentHash = await hashFeed(leak.feed); await writeJson(join(leak.feed, "manifest.json"), leak.manifest);
const ineligibleBuildNote = await createFeed("invalid-build-note-metric", async (model) => {
  model.blogs.push({ ...blog("build-note"), category: "build-note", metricEligible: true });
});
ineligibleBuildNote.manifest.contentHash = await hashFeed(ineligibleBuildNote.feed); await writeJson(join(ineligibleBuildNote.feed, "manifest.json"), ineligibleBuildNote.manifest);
const unhashed = await createFeed("unhashed-asset", async (_model, feed) => {
  await mkdir(join(feed, "assets/not-hashed"), { recursive: true }); await writeFile(join(feed, "assets/not-hashed/image.png"), Buffer.from("not an image"));
});
unhashed.manifest.contentHash = await hashFeed(unhashed.feed); await writeJson(join(unhashed.feed, "manifest.json"), unhashed.manifest);
console.log(`Built contract fixtures in ${root}`);
