/**
 * FlowPilot — Unit Tests for CI Base-versus-HEAD Handoff Comparator
 *
 * Verifies that evaluateHandoffComparison behaves fail-closed across:
 * - Current known BASE/HEAD failures (E10, E12b)
 * - HEAD crash with zero checks (e.g. SyntaxError)
 * - Process spawn error (e.g. ENOENT)
 * - Process signal termination (e.g. SIGKILL)
 * - Missing or inconsistent summary / line counts
 * - Missing test cases / incomplete check suite
 * - New regressions introduced on HEAD
 * - Unreviewed / unknown failures
 * - Valid all-pass verified improvement
 */
import {
  evaluateHandoffComparison,
  type ProcessRunResult,
} from "./compare-handoff-cause";

const CHECKS_31 = [
  "U1. كل سبب canonical قابل للتمثيل ويقبل التحقق",
  "U2. كل سبب له عرض مُشغّل",
  "U3. القيم غير المعروفة تفشل بأمان",
  "U4. أسباب التحويل في عقد الذكاء تُطابق الـ taxonomy",
  "U5. أسباب التحكم في المحادثة تُفرّق فشل المزود",
  "U6. رموز الأهلية",
  "U7. وحدة السبب نقية",
  "E1. طلب صريح لمسؤول",
  "E2. حالة حسّاسة",
  "E3. فجوة معرفة",
  "E4. غموض حقيقي",
  "E5. قيد مجالي",
  "E6. رد غير مدعوم",
  "E7. مخرجات مساعد غير صالحة",
  "E8. انقطاع المزود",
  "E9. استنفاد المحاولات",
  "E10. خدمة غير مُعدة/معطّلة",
  "E11. سؤال يمكن الإجابة",
  "E12. الأسبقية: حسّاس + رد مقترح",
  "E12b. ادّعاء بشري من النموذج",
  "E13. نوايا متعددة",
  "E14. معرفة + حجز",
  "E15. السبب يعبر فاصل التخزين",
  "E16. لا سبب بالٍ",
  "E17. إعادة للمساعد",
  "E18. عزل المستأجر",
  "E19. السبب لا يظهر للعميل",
  "E20. اشتقاق السبب لا يضيف استدعاء",
  "S1. المحرك لا يتخذ أي فرع",
  "S2. وحدة المُطابقة لا تقرر التحويل",
  "S3. مجموعة سبب canonical واحدة",
];

function buildMockOutput(opts: {
  failedCodes?: string[];
  omittedCodes?: string[];
  extraChecks?: string[];
}): string {
  const failed = new Set(opts.failedCodes ?? []);
  const omitted = new Set(opts.omittedCodes ?? []);

  const lines: string[] = [];
  let passedCount = 0;
  let failedCount = 0;

  for (const check of CHECKS_31) {
    const code = check.match(/^([A-Za-z0-9_-]+)\./)?.[1] ?? "";
    if (omitted.has(code)) continue;

    if (failed.has(code)) {
      lines.push(`✘ ${check}`);
      failedCount++;
    } else {
      lines.push(`✔ ${check}`);
      passedCount++;
    }
  }

  if (opts.extraChecks) {
    for (const extra of opts.extraChecks) {
      lines.push(`✔ ${extra}`);
      passedCount++;
    }
  }

  const total = passedCount + failedCount;
  const status = failedCount === 0 ? "PASS" : "FAIL";
  lines.push(`\n${status} — ${passedCount}/${total} checks passed.\n`);

  if (failedCount > 0) {
    for (const check of CHECKS_31) {
      const code = check.match(/^([A-Za-z0-9_-]+)\./)?.[1] ?? "";
      if (failed.has(code)) lines.push(`  - ${check}`);
    }
  }

  return lines.join("\n");
}

function runSuite(): void {
  console.log("========================================================");
  console.log("  CHECK: COMPARE-HANDOFF-CAUSE INTEGRITY SUITE          ");
  console.log("========================================================\n");

  const results: Array<{ label: string; pass: boolean; details?: unknown }> =
    [];
  function check(label: string, pass: boolean, details?: unknown) {
    results.push({ label, pass, details });
    console.log(`${pass ? "✔" : "✘"} ${label}`);
    if (!pass && details) console.error("  Details:", details);
  }

  // Baseline standard run (29/31 with pre-existing E10 and E12b)
  const standardBaseRun: ProcessRunResult = {
    exitCode: 1,
    rawOutput: buildMockOutput({ failedCodes: ["E10", "E12b"] }),
  };

  // 1. Current known BASE/HEAD failures -> PASS (IDENTICAL_KNOWN_FAILURES)
  {
    const standardHeadRun: ProcessRunResult = {
      exitCode: 1,
      rawOutput: buildMockOutput({ failedCodes: ["E10", "E12b"] }),
    };
    const res = evaluateHandoffComparison(standardBaseRun, standardHeadRun);
    check(
      "1. Identical pre-existing failures (E10, E12b) report PASS with IDENTICAL_KNOWN_FAILURES",
      res.pass === true && res.classification === "IDENTICAL_KNOWN_FAILURES",
      res,
    );
  }

  // 2. HEAD crash with zero checks (e.g. SyntaxError) -> FAIL closed
  {
    const crashedHeadRun: ProcessRunResult = {
      exitCode: 1,
      rawOutput:
        "SyntaxError: Unexpected token 'export'\n    at internal/modules/cjs/loader.js:123:45",
    };
    const res = evaluateHandoffComparison(standardBaseRun, crashedHeadRun);
    check(
      "2. HEAD crash with no checks fails closed (no false pass)",
      res.pass === false &&
        Boolean(res.error?.includes("missing canonical test summary line")),
      res,
    );
  }

  // 3a. Process spawn error -> FAIL closed
  {
    const spawnErrorHeadRun: ProcessRunResult = {
      exitCode: null,
      rawOutput: "",
      error: new Error("spawn pnpm ENOENT"),
    };
    const res = evaluateHandoffComparison(standardBaseRun, spawnErrorHeadRun);
    check(
      "3a. Spawn error on HEAD fails closed",
      res.pass === false && Boolean(res.error?.includes("execution error")),
      res,
    );
  }

  // 3b. Process signal termination -> FAIL closed
  {
    const signalTerminatedHeadRun: ProcessRunResult = {
      exitCode: null,
      rawOutput: "",
      signal: "SIGKILL",
    };
    const res = evaluateHandoffComparison(
      standardBaseRun,
      signalTerminatedHeadRun,
    );
    check(
      "3b. Abnormal signal termination on HEAD fails closed",
      res.pass === false &&
        Boolean(res.error?.includes("terminated abnormally")),
      res,
    );
  }

  // 4a. Summary missing / malformed -> FAIL closed
  {
    const malformedSummaryHeadRun: ProcessRunResult = {
      exitCode: 0,
      rawOutput: "✔ U1. All good\n✔ U2. All good\nDone.",
    };
    const res = evaluateHandoffComparison(
      standardBaseRun,
      malformedSummaryHeadRun,
    );
    check(
      "4a. Missing canonical summary fails closed",
      res.pass === false &&
        Boolean(res.error?.includes("missing canonical test summary line")),
      res,
    );
  }

  // 4b. Summary count inconsistent with line count -> FAIL closed
  {
    const inconsistentHeadRun: ProcessRunResult = {
      exitCode: 1,
      rawOutput:
        "✔ U1. OK\n✘ E10. Bad\n\nFAIL — 29/31 checks passed.\n  - E10. Bad",
    };
    const res = evaluateHandoffComparison(standardBaseRun, inconsistentHeadRun);
    check(
      "4b. Inconsistent line count vs summary count fails closed",
      res.pass === false && Boolean(res.error?.includes("line count")),
      res,
    );
  }

  // 5a. Incomplete check set: fewer total checks on HEAD -> FAIL closed
  {
    // HEAD executed only 29 checks by dropping E10 and E12b instead of running them
    const droppedCasesHeadRun: ProcessRunResult = {
      exitCode: 0,
      rawOutput: buildMockOutput({ omittedCodes: ["E10", "E12b"] }),
    };
    const res = evaluateHandoffComparison(standardBaseRun, droppedCasesHeadRun);
    check(
      "5a. Omitted/fewer test cases on HEAD fails closed with Incomplete check set",
      res.pass === false &&
        Boolean(res.error?.includes("Incomplete check set")),
      res,
    );
  }

  // 5b. Same total checks count but missing executed base cases -> FAIL closed
  {
    // HEAD executed 31 checks, but dropped E10 and E12b and substituted dummy checks X1 and X2
    const substitutedCasesHeadRun: ProcessRunResult = {
      exitCode: 0,
      rawOutput: buildMockOutput({
        omittedCodes: ["E10", "E12b"],
        extraChecks: ["X1. فحص بديل غير مصرح به", "X2. فحص بديل آخر"],
      }),
    };
    const res = evaluateHandoffComparison(
      standardBaseRun,
      substitutedCasesHeadRun,
    );
    check(
      "5b. Substituted/missing base test cases on HEAD fails closed with Missing executed cases",
      res.pass === false &&
        Boolean(res.error?.includes("Missing executed cases")),
      res,
    );
  }

  // 6. New regression on HEAD -> FAIL closed
  {
    // HEAD fails E3 (knowledge gap) in addition to E10 and E12b
    const regressionHeadRun: ProcessRunResult = {
      exitCode: 1,
      rawOutput: buildMockOutput({ failedCodes: ["E3", "E10", "E12b"] }),
    };
    const res = evaluateHandoffComparison(standardBaseRun, regressionHeadRun);
    check(
      "6. New regression introduced on HEAD fails closed",
      res.pass === false && Boolean(res.error?.includes("New regressions")),
      res,
    );
  }

  // 7. Unreviewed / Unknown failure on HEAD -> FAIL closed
  {
    // BASE had unknown check Z99 failed, HEAD also has it
    const baseWithUnknown: ProcessRunResult = {
      exitCode: 1,
      rawOutput:
        standardBaseRun.rawOutput.replace(
          "31 checks passed",
          "32 checks passed",
        ) + "\n✘ Z99. Unknown failure\n",
    };
    const headWithUnknown: ProcessRunResult = {
      exitCode: 1,
      rawOutput:
        standardBaseRun.rawOutput.replace(
          "31 checks passed",
          "32 checks passed",
        ) + "\n✘ Z99. Unknown failure\n",
    };
    const res = evaluateHandoffComparison(baseWithUnknown, headWithUnknown);
    check(
      "7. Unreviewed / unknown failures not in permissible set fail closed",
      res.pass === false && Boolean(res.error?.includes("Unreviewed failure")),
      res,
    );
  }

  // 8. Verified all-pass improvement -> PASS (VERIFIED_IMPROVEMENT)
  {
    const allPassHeadRun: ProcessRunResult = {
      exitCode: 0,
      rawOutput: buildMockOutput({ failedCodes: [] }),
    };
    const res = evaluateHandoffComparison(standardBaseRun, allPassHeadRun);
    check(
      "8. Genuine all-pass improvement reports PASS with VERIFIED_IMPROVEMENT",
      res.pass === true && res.classification === "VERIFIED_IMPROVEMENT",
      res,
    );
  }

  // 9. Verified partial improvement (e.g. E10 fixed, E12b remains) -> PASS (VERIFIED_IMPROVEMENT)
  {
    const partialImprovementHeadRun: ProcessRunResult = {
      exitCode: 1,
      rawOutput: buildMockOutput({ failedCodes: ["E12b"] }),
    };
    const res = evaluateHandoffComparison(
      standardBaseRun,
      partialImprovementHeadRun,
    );
    check(
      "9. Genuine partial improvement (E10 fixed) reports PASS with VERIFIED_IMPROVEMENT",
      res.pass === true && res.classification === "VERIFIED_IMPROVEMENT",
      res,
    );
  }

  const failed = results.filter((r) => !r.pass);
  console.log(
    `\nTOTAL INTEGRITY CHECKS: ${results.length} | PASSED: ${results.length - failed.length} | FAILED: ${failed.length}\n`,
  );

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

runSuite();
