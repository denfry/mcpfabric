/** Reports of a test run: lines for the terminal, JUnit XML for CI, and a JSON file. */
import type { AttemptResult, TestError, TestResult } from "./runner.js";

export interface Summary {
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  durationMs: number;
}

export function summarize(results: TestResult[], durationMs: number): Summary {
  return {
    passed: results.filter((r) => r.status === "passed").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    flaky: results.filter((r) => r.flaky).length,
    durationMs,
  };
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function errorLines(e: TestError, indent: string): string[] {
  const where = e.phase === "test" ? "" : ` (in ${e.phase})`;
  const lines = [`${indent}${e.name}: ${e.message}${where}`];
  if (e.step) lines.push(`${indent}at step: ${e.step}`);
  // QuickJS frames point into the test file as script.js; the library's frames are noise.
  for (const frame of (e.stack ?? "").split("\n").filter((l) => l.includes("script.js")).slice(0, 4)) {
    lines.push(`${indent}${frame.trim().replace("script.js", "test file")}`);
  }
  return lines;
}

/** The lines printed for one finished test. */
export function formatResult(r: TestResult): string[] {
  if (r.status === "skipped") return [`  SKIP  ${r.name}  (${r.skipReason ?? "skipped"})`];
  const tries = r.attempts.length > 1 ? `, ${r.attempts.length} attempts` : "";
  if (r.status === "passed") return [`  PASS  ${r.name}  (${secs(r.durationMs)}${tries}${r.flaky ? ", flaky" : ""})`];
  const last = r.attempts[r.attempts.length - 1]!;
  const lines = [`  FAIL  ${r.name}  (${secs(r.durationMs)}${tries})`];
  if (last.error) lines.push(...errorLines(last.error, "        "));
  if (last.afterEachError) lines.push(...errorLines(last.afterEachError, "        "));
  for (const a of last.artifacts) lines.push(`        kept: ${a}`);
  return lines;
}

export function formatSummary(s: Summary): string {
  const parts = [`${s.passed} passed`, `${s.failed} failed`];
  if (s.skipped) parts.push(`${s.skipped} skipped`);
  if (s.flaky) parts.push(`${s.flaky} flaky`);
  return `${parts.join(", ")} (${secs(s.durationMs)})`;
}

/** XML 1.0 text: escapes markup and drops characters XML cannot carry. */
export function xml(s: string): string {
  return s
    .replace(/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function failureText(a: AttemptResult): string {
  const lines: string[] = [];
  for (const e of [a.error, a.afterEachError]) {
    if (!e) continue;
    lines.push(`${e.name}: ${e.message}${e.phase === "test" ? "" : ` (in ${e.phase})`}`);
    if (e.step) lines.push(`at step: ${e.step}`);
    if (e.stack) lines.push(e.stack);
  }
  return lines.join("\n");
}

/** JUnit XML, one testsuite per file; failure screenshots are linked as [[ATTACHMENT|path]]. */
export function junit(results: TestResult[], durationMs: number, timestamp = new Date()): string {
  const byFile = new Map<string, TestResult[]>();
  for (const r of results) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
  const total = summarize(results, durationMs);
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="mcpfabric" tests="${results.length}" failures="${total.failed}" errors="0" skipped="${total.skipped}" time="${(durationMs / 1000).toFixed(3)}">`,
  ];
  for (const [file, rs] of byFile) {
    const s = summarize(rs, rs.reduce((n, r) => n + r.durationMs, 0));
    out.push(
      `  <testsuite name="${xml(file)}" tests="${rs.length}" failures="${s.failed}" errors="0" skipped="${s.skipped}" time="${(s.durationMs / 1000).toFixed(3)}" timestamp="${timestamp.toISOString().slice(0, 19)}">`,
    );
    for (const r of rs) {
      out.push(`    <testcase classname="${xml(file)}" name="${xml(r.name)}" time="${(r.durationMs / 1000).toFixed(3)}">`);
      const last = r.attempts[r.attempts.length - 1];
      if (r.status === "skipped") out.push(`      <skipped message="${xml(r.skipReason ?? "skipped")}"/>`);
      if (r.status === "failed" && last) {
        const e = last.error ?? last.afterEachError;
        out.push(`      <failure message="${xml(e?.message ?? "failed")}" type="${xml(e?.name ?? "Error")}">${xml(failureText(last))}</failure>`);
      }
      if (r.flaky) {
        for (const a of r.attempts.filter((x) => !x.ok)) {
          const e = a.error ?? a.afterEachError;
          out.push(`      <flakyFailure message="${xml(e?.message ?? "failed")}" type="${xml(e?.name ?? "Error")}">${xml(failureText(a))}</flakyFailure>`);
        }
      }
      const logs = r.attempts.flatMap((a) => (r.attempts.length > 1 ? [`--- attempt ${a.attempt}`, ...a.logs] : a.logs));
      const attachments = r.attempts.flatMap((a) => a.artifacts).map((p) => `[[ATTACHMENT|${p}]]`);
      if (logs.length > 0 || attachments.length > 0) out.push(`      <system-out>${xml([...logs, ...attachments].join("\n"))}</system-out>`);
      out.push("    </testcase>");
    }
    out.push("  </testsuite>");
  }
  out.push("</testsuites>");
  return out.join("\n") + "\n";
}

export function jsonReport(results: TestResult[], durationMs: number): string {
  return JSON.stringify({ summary: summarize(results, durationMs), results }, null, 2) + "\n";
}
