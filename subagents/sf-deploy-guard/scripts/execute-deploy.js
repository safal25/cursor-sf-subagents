#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');

const metadataArg = process.argv.slice(2).join(' ').replace(/\s+/g, ' ').trim();
if (!metadataArg) {
  console.error('Usage: node execute-deploy.js "ApexClass:MyClass,LightningComponentBundle:MyLWC"');
  process.exit(1);
}

const metadataItems = metadataArg.split(/[,\s]+/).filter(Boolean);
const metadataFlags = metadataItems.map(m => `--metadata "${m}"`).join(' ');
const cmd = `sf project deploy start ${metadataFlags} --json`;

let raw;
try {
  raw = execSync(cmd, { encoding: 'utf8', shell: true, maxBuffer: 10 * 1024 * 1024 });
} catch (err) {
  raw = err.stdout || err.output?.[1];
  if (!raw) {
    console.log(JSON.stringify({
      success: false,
      deployed: [],
      failed: [{ file: '', error: String(err.stderr || err.message || 'Deploy failed').slice(0, 500) }]
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
    deployed: [],
    failed: [{ file: '', error: 'Failed to parse sf output as JSON' }]
  }, null, 2));
  process.exit(1);
}

const result = data.result || data;
const status = result.status;

const deployed = [];
const failed = [];

if (result.componentSuccesses) {
  const arr = Array.isArray(result.componentSuccesses) ? result.componentSuccesses : [result.componentSuccesses];
  for (const c of arr) {
    const name = c.fullName || c.fileName || c.componentType;
    if (name) deployed.push(`${c.componentType || 'Component'}:${name}`);
  }
}

if (result.componentFailures) {
  const arr = Array.isArray(result.componentFailures) ? result.componentFailures : [result.componentFailures];
  for (const f of arr) {
    failed.push({
      file: f.fileName || f.fullName || '',
      error: f.problem || f.message || ''
    });
  }
}

if (failed.length === 0 && deployed.length === 0 && status !== 'Succeeded') {
  const deployId = result.id || result.deployId;
  if (deployId) {
    try {
      const reportRaw = execSync(
        `sf project deploy report --job-id ${deployId} --json`,
        { encoding: 'utf8', shell: true, maxBuffer: 10 * 1024 * 1024 }
      );
      const report = JSON.parse(reportRaw);
      const details = report.result?.deployDetails || report.deployDetails;
      if (details?.componentSuccesses) {
        const arr = Array.isArray(details.componentSuccesses) ? details.componentSuccesses : [details.componentSuccesses];
        for (const c of arr) {
          deployed.push(`${c.componentType || 'Component'}:${c.fullName || c.fileName}`);
        }
      }
      if (details?.componentFailures) {
        const arr = Array.isArray(details.componentFailures) ? details.componentFailures : [details.componentFailures];
        for (const f of arr) {
          failed.push({ file: f.fileName || f.fullName || '', error: f.problem || f.message || '' });
        }
      }
    } catch (_) {}
  }
}

const success = status === 'Succeeded' && failed.length === 0;
const output = { success, deployed, failed };

console.log(JSON.stringify(output, null, 2));
process.exit(success ? 0 : 1);
