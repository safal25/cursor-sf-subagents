#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');

const metadataArg = process.argv.slice(2).join(' ').replace(/\s+/g, ' ').trim();
if (!metadataArg) {
  console.error('Usage: node preview-conflicts.js "ApexClass:MyClass,LightningComponentBundle:MyLWC"');
  process.exit(1);
}

const metadataItems = metadataArg.split(/[,\s]+/).filter(Boolean);
const metadataFlags = metadataItems.map(m => `--metadata "${m}"`).join(' ');
const cmd = `sf project deploy preview ${metadataFlags} --json`;

let raw;
try {
  raw = execSync(cmd, { encoding: 'utf8', shell: true, maxBuffer: 10 * 1024 * 1024 });
} catch (err) {
  raw = err.stdout || err.output?.[1];
  if (!raw) {
    console.log(JSON.stringify({
      hasConflicts: false,
      conflicts: [],
      localChanges: [],
      error: String(err.stderr || err.message || 'Unknown error').slice(0, 300)
    }, null, 2));
    process.exit(0);
  }
}

let data;
try {
  data = JSON.parse(raw);
} catch (parseErr) {
  console.log(JSON.stringify({
    hasConflicts: false,
    conflicts: [],
    localChanges: [],
    error: 'Failed to parse sf output as JSON'
  }, null, 2));
  process.exit(0);
}

const result = data.result || data;

function inferType(filePath) {
  if (/\.cls$/.test(filePath)) return 'ApexClass';
  if (/\.trigger$/.test(filePath)) return 'ApexTrigger';
  if (/lwc\//.test(filePath)) return 'LightningComponentBundle';
  if (/aura\//.test(filePath)) return 'AuraDefinitionBundle';
  if (/objects\//.test(filePath)) return 'CustomObject';
  if (/\/labels\//.test(filePath)) return 'CustomLabels';
  return '';
}

// result.conflicts[] — every entry here is already a confirmed conflict
const rawConflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
const conflicts = rawConflicts.map(f => ({
  type: f.type || inferType(f.projectRelativePath || f.path || ''),
  filePath: f.projectRelativePath || f.path || f.fullName || '',
  state: 'Conflict'
}));

// result.toDeploy[] — local changes that are not conflicting
const rawToDeploy = Array.isArray(result.toDeploy) ? result.toDeploy : [];
const localChanges = rawToDeploy.map(f => ({
  type: f.type || inferType(f.projectRelativePath || f.path || ''),
  filePath: f.projectRelativePath || f.path || f.fullName || ''
}));

const output = {
  hasConflicts: conflicts.length > 0,
  conflicts,
  localChanges
};

console.log(JSON.stringify(output, null, 2));
process.exit(0);
