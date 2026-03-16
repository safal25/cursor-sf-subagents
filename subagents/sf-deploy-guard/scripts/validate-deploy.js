#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');

const metadataArg = process.argv.slice(2).join(' ').replace(/\s+/g, ' ').trim();
if (!metadataArg) {
  console.error('Usage: node validate-deploy.js "ApexClass:MyClass,LightningComponentBundle:MyLWC"');
  process.exit(1);
}

const metadataItems = metadataArg.split(/[,\s]+/).filter(Boolean);
const metadataFlags = metadataItems.map(m => `--metadata ${m}`).join(' ');
const cmd = `sf project deploy start --dry-run --test-level NoTestRun ${metadataFlags} --json`;

let raw;
try {
  raw = execSync(cmd, { encoding: 'utf8', shell: true, maxBuffer: 10 * 1024 * 1024 });
} catch (err) {
  raw = err.stdout || err.output?.[1];
  if (!raw) {
    const msg = err.stderr || err.message || 'Unknown error';
    console.log(JSON.stringify({
      success: false,
      errors: [{ file: '', line: 0, column: 0, message: String(msg).slice(0, 500), type: '' }]
    }, null, 2));
    process.exit(1);
  }
}

let data;
try {
  data = JSON.parse(raw);
} catch (parseErr) {
  console.log(JSON.stringify({
    success: false,
    errors: [{ file: '', line: 0, column: 0, message: 'Failed to parse sf output as JSON', type: '' }]
  }, null, 2));
  process.exit(1);
}

const result = data.result || data;
const status = result.status;

if (status === 'Succeeded' || status === 'SucceededPartial' || result.success) {
  console.log(JSON.stringify({ success: true, errors: [] }, null, 2));
  process.exit(0);
}

// 1. Check result.deployedSource for state:"Failed" entries (dry-run primary source)
let failures = [];

const deployedSource = result.deployedSource || [];
const sourceFailed = deployedSource.filter(f => f.state === 'Failed' || f.state === 'Error');
if (sourceFailed.length > 0) {
  failures = sourceFailed.map(f => ({
    file: f.filePath || f.fullName || '',
    line: parseInt(f.lineNumber, 10) || 0,
    column: parseInt(f.columnNumber, 10) || 0,
    message: f.error || f.problem || f.message || '',
    type: f.type || f.componentType || ''
  }));
}

// 2. Fall back to result.details.componentFailures (nested, dry-run secondary source)
if (failures.length === 0) {
  const nested = result.details?.componentFailures;
  if (nested) {
    const arr = Array.isArray(nested) ? nested : [nested];
    failures = arr.map(f => ({
      file: f.fileName || f.fullName || '',
      line: parseInt(f.lineNumber, 10) || 0,
      column: parseInt(f.columnNumber, 10) || 0,
      message: f.problem || f.message || '',
      type: f.componentType || ''
    }));
  }
}

// 3. Fall back to result.componentFailures (top-level, older CLI versions)
if (failures.length === 0 && result.componentFailures) {
  const arr = Array.isArray(result.componentFailures) ? result.componentFailures : [result.componentFailures];
  failures = arr.map(f => ({
    file: f.fileName || f.fullName || '',
    line: parseInt(f.lineNumber, 10) || 0,
    column: parseInt(f.columnNumber, 10) || 0,
    message: f.problem || f.message || '',
    type: f.componentType || ''
  }));
}

// 4. Last resort: use the top-level error message
if (failures.length === 0) {
  const msg = data.message || result.message || 'Dry-run failed with no details';
  failures = [{ file: '', line: 0, column: 0, message: String(msg).slice(0, 500), type: '' }];
}

const output = { success: false, errors: failures };
console.log(JSON.stringify(output, null, 2));
process.exit(1);
