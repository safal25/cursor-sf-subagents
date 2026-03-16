#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TMP_DIR = '/tmp/sf-deploy-guard';

const rawArgs = process.argv.slice(2);
const filePaths = rawArgs.length === 1
  ? rawArgs[0].split(/[,\n]+/).map(p => p.trim()).filter(Boolean)
  : rawArgs.map(p => p.trim()).filter(Boolean);

if (filePaths.length === 0) {
  console.error('Usage: node analyze-conflicts.js "path/to/file1.cls" "path/to/file2"');
  process.exit(1);
}

function pathToMetadata(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/force-app\/[^/]+\/[^/]+\/(.+)/) || normalized.match(/(?:^\/)?(.+)/);
  const relPath = match ? match[1] : normalized;

  // Strip -meta.xml suffix before extension matching
  const strippedPath = relPath.replace(/-meta\.xml$/, '');

  if (strippedPath.includes('classes/') && strippedPath.endsWith('.cls')) {
    const name = path.basename(strippedPath, '.cls');
    return `ApexClass:${name}`;
  }
  if (strippedPath.includes('triggers/') && strippedPath.endsWith('.trigger')) {
    const name = path.basename(strippedPath, '.trigger');
    return `ApexTrigger:${name}`;
  }
  if (relPath.includes('lwc/')) {
    const lwcMatch = relPath.match(/lwc\/([^/]+)/);
    const name = lwcMatch ? lwcMatch[1] : path.basename(path.dirname(relPath));
    return `LightningComponentBundle:${name}`;
  }
  if (relPath.includes('aura/')) {
    const auraMatch = relPath.match(/aura\/([^/]+)/);
    const name = auraMatch ? auraMatch[1] : path.basename(path.dirname(relPath));
    return `AuraDefinitionBundle:${name}`;
  }
  if (relPath.includes('objects/')) {
    const objMatch = relPath.match(/objects\/([^/]+)/);
    return objMatch ? `CustomObject:${objMatch[1]}` : null;
  }
  if (relPath.includes('labels/')) {
    return 'CustomLabels:CustomLabels';
  }
  return null;
}

function getComponentKey(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.includes('lwc/')) {
    const m = normalized.match(/(.*\/lwc\/[^/]+)/);
    return m ? m[1] : filePath;
  }
  if (normalized.includes('aura/')) {
    const m = normalized.match(/(.*\/aura\/[^/]+)/);
    return m ? m[1] : filePath;
  }
  return filePath;
}

const metadataSet = new Set();
const componentToLocalPath = new Map();

for (const fp of filePaths) {
  const meta = pathToMetadata(fp);
  if (meta) {
    metadataSet.add(meta);
    const key = getComponentKey(fp);
    if (!componentToLocalPath.has(key)) {
      componentToLocalPath.set(key, fp);
    }
  }
}

const metadataFlags = [...metadataSet].map(m => `--metadata "${m}"`).join(' ');

if (metadataSet.size === 0) {
  console.log(JSON.stringify({
    realConflicts: [],
    phantomConflicts: filePaths,
    error: 'Could not derive metadata from file paths'
  }, null, 2));
  process.exit(0);
}

if (fs.existsSync(TMP_DIR)) {
  try {
    fs.rmSync(TMP_DIR, { recursive: true });
  } catch (e) {
    console.log(JSON.stringify({
      realConflicts: [],
      phantomConflicts: filePaths,
      error: `Could not clean temp dir: ${e.message}`
    }, null, 2));
    process.exit(0);
  }
}

try {
  execSync(
    `sf project retrieve start ${metadataFlags} --output-dir "${TMP_DIR}" --json`,
    { encoding: 'utf8', shell: true, maxBuffer: 10 * 1024 * 1024 }
  );
} catch (err) {
  const msg = err.stderr || err.message || 'Retrieve failed';
  console.log(JSON.stringify({
    realConflicts: [],
    phantomConflicts: filePaths,
    error: String(msg).slice(0, 500)
  }, null, 2));
  if (fs.existsSync(TMP_DIR)) {
    try { fs.rmSync(TMP_DIR, { recursive: true }); } catch (_) {}
  }
  process.exit(0);
}

const realConflicts = [];
const phantomConflicts = [];

const processedKeys = new Set();

for (const [localPath, _] of componentToLocalPath) {
  const normalizedLocal = path.normalize(localPath).replace(/\\/g, '/');
  const isLWC = normalizedLocal.includes('/lwc/');
  const isAura = normalizedLocal.includes('/aura/');

  // sf retrieve --output-dir places files at <type-folder>/<name> (flat, no force-app nesting).
  // Strip force-app/<package>/<namespace>/ prefix to get just classes/Foo.cls etc.
  const forceAppMatch = normalizedLocal.match(/(?:force-app|src)\/[^/]+\/[^/]+\/(.+)/);
  const projectRelative = forceAppMatch
    ? forceAppMatch[1]
    : normalizedLocal.replace(/^\//, '');
  const orgPath = path.join(TMP_DIR, projectRelative);
  const localAbs = path.isAbsolute(normalizedLocal) ? normalizedLocal : path.join(process.cwd(), normalizedLocal);

  if (!fs.existsSync(localAbs)) {
    phantomConflicts.push(localPath);
    continue;
  }

  // Also check the content file (strip -meta.xml) since retrieve puts both files
  const orgContentPath = orgPath.endsWith('-meta.xml')
    ? orgPath.replace(/-meta\.xml$/, '')
    : orgPath;
  if (!fs.existsSync(orgPath) && !fs.existsSync(orgContentPath)) {
    phantomConflicts.push(localPath);
    continue;
  }

  const key = normalizedLocal;
  if (processedKeys.has(key)) continue;
  processedKeys.add(key);

  // Resolve the actual content path to diff (not the -meta.xml file)
  let orgDiffTarget = orgPath;
  let localDiffTarget = localAbs;

  if (isLWC || isAura) {
    // For LWC/Aura: diff the whole component directory
    const forceAppLwcMatch = normalizedLocal.match(/((?:force-app|src)\/.*?\/(?:lwc|aura)\/[^/]+)/);
    const compDir = forceAppLwcMatch ? forceAppLwcMatch[1] : null;
    if (compDir) {
      orgDiffTarget = path.join(TMP_DIR, compDir);
      const localCompMatch = localAbs.match(/(.*\/(?:lwc|aura)\/[^/]+)/);
      localDiffTarget = localCompMatch ? localCompMatch[1] : localAbs;
    }
  } else if (projectRelative.endsWith('-meta.xml')) {
    // For Apex/other: strip -meta.xml to get the actual content file
    const contentOrgPath = path.join(TMP_DIR, projectRelative.replace(/-meta\.xml$/, ''));
    if (fs.existsSync(contentOrgPath)) {
      orgDiffTarget = contentOrgPath;
      localDiffTarget = localAbs.replace(/-meta\.xml$/, '');
    }
  }

  let diffOutput = '';
  let hasMinusLines = false;

  try {
    if (isLWC || isAura) {
      if (fs.existsSync(orgDiffTarget) && fs.statSync(orgDiffTarget).isDirectory()) {
        diffOutput = execSync(
          `diff -ru "${orgDiffTarget}" "${localDiffTarget}" 2>/dev/null || true`,
          { encoding: 'utf8', shell: true, maxBuffer: 2 * 1024 * 1024 }
        );
      }
    } else {
      if (fs.existsSync(orgDiffTarget)) {
        diffOutput = execSync(
          `diff -u "${orgDiffTarget}" "${localDiffTarget}" 2>/dev/null || true`,
          { encoding: 'utf8', shell: true, maxBuffer: 2 * 1024 * 1024 }
        );
      }
    }

    const lines = diffOutput.split('\n');
    for (const line of lines) {
      if (line.startsWith('-') && !line.startsWith('---')) {
        hasMinusLines = true;
        break;
      }
    }
  } catch (diffErr) {
    diffOutput = diffErr.stdout || diffErr.message || '';
    const lines = diffOutput.split('\n');
    for (const line of lines) {
      if (line.startsWith('-') && !line.startsWith('---')) {
        hasMinusLines = true;
        break;
      }
    }
  }

  const orgOnlyLines = diffOutput
    .split('\n')
    .filter(l => l.startsWith('-') && !l.startsWith('---'))
    .slice(0, 50);

  if (hasMinusLines) {
    realConflicts.push({
      file: localPath,
      diff: diffOutput.slice(0, 8000),
      orgOnlyLines
    });
  } else {
    phantomConflicts.push(localPath);
  }
}

try {
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true });
  }
} catch (_) {}

console.log(JSON.stringify({ realConflicts, phantomConflicts }, null, 2));
process.exit(0);
