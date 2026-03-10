#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');

const classNames = process.argv.slice(2).join(',');
if (!classNames) {
  console.error('Usage: node run-apex-tests.js ClassName1,ClassName2,...');
  process.exit(1);
}

let raw;
try {
  raw = execSync(
    `sf apex run test --class-names ${classNames} --result-format json --wait 10`,
    { encoding: 'utf8', shell: true }
  );
} catch (err) {
  // sf exits non-zero when tests fail, but JSON is still written to stdout
  raw = err.stdout;
  if (!raw) {
    console.error('sf apex run test produced no output. stderr:', err.stderr);
    process.exit(1);
  }
}

let data;
try {
  data = JSON.parse(raw);
} catch (parseErr) {
  console.error('Failed to parse sf apex run test output as JSON.');
  console.error('Raw output:', raw);
  process.exit(1);
}

// SF CLI wraps result in data.result (status + result); older formats may have summary/tests at top level
const resultData = data.result || data;
const tests = resultData.tests || [];
const summary = resultData.summary || {};

const failures = tests
  .filter(t => t.Outcome !== 'Pass')
  .map(t => ({
    method: t.MethodName,
    class: t.ApexClass && t.ApexClass.Name,
    outcome: t.Outcome,
    message: t.Message,
    stackTrace: t.StackTrace
  }));

const result = { summary, failures };
console.log(JSON.stringify(result, null, 2));

if (failures.length > 0) {
  process.exit(1);
}
