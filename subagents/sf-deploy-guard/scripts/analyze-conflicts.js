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

function isSubsequence(short, long) {
  let i = 0;
  for (let j = 0; j < long.length && i < short.length; j++) {
    if (short[i] === long[j]) i++;
  }
  return i === short.length;
}

function parseDiffHunks(diffOutput) {
  const lines = diffOutput.split('\n');
  const hunks = [];
  let currentHunk = null;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = { minusLines: [], plusLines: [] };
    } else if (currentHunk) {
      if (line.startsWith('-') && !line.startsWith('---')) {
        currentHunk.minusLines.push(line.slice(1));
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        currentHunk.plusLines.push(line.slice(1));
      }
    }
  }
  if (currentHunk) hunks.push(currentHunk);

  return hunks;
}

function allMinusLinesCovered(hunks) {
  const uncoveredLines = [];

  for (const hunk of hunks) {
    for (const minusLine of hunk.minusLines) {
      const trimmedMinus = minusLine.trim();
      if (trimmedMinus === '') continue;

      const covered = hunk.plusLines.some(plusLine =>
        isSubsequence(trimmedMinus, plusLine.trim())
      );

      if (!covered) {
        uncoveredLines.push('-' + minusLine);
      }
    }
  }

  return { covered: uncoveredLines.length === 0, uncoveredLines };
}

function getAllFiles(dirPath) {
  const files = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

let _gitRepoRoot;

function getGitRepoRoot() {
  if (_gitRepoRoot !== undefined) return _gitRepoRoot;
  try {
    _gitRepoRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8', shell: true, timeout: 5000
    }).trim();
  } catch (_) {
    _gitRepoRoot = null;
  }
  return _gitRepoRoot;
}

function orgMatchesGitHistory(orgContent, localAbsPath) {
  const repoRoot = getGitRepoRoot();
  if (!repoRoot) return { matched: false, headContent: null };

  let gitRelPath;
  try {
    gitRelPath = path.relative(repoRoot, localAbsPath).replace(/\\/g, '/');
  } catch (_) {
    return { matched: false, headContent: null };
  }

  let headContent = null;
  try {
    headContent = execSync(
      `git show HEAD:"${gitRelPath}"`,
      { encoding: 'utf8', shell: true, cwd: repoRoot, timeout: 5000 }
    );
    if (headContent.trim() === orgContent.trim()) {
      return { matched: true, headContent };
    }
  } catch (_) { /* file may not exist at HEAD */ }

  let commitHashes;
  try {
    const log = execSync(
      `git log -n 10 --format=%H -- "${gitRelPath}"`,
      { encoding: 'utf8', shell: true, cwd: repoRoot, timeout: 5000 }
    ).trim();
    commitHashes = log ? log.split('\n').filter(Boolean) : [];
  } catch (_) {
    return { matched: false, headContent };
  }

  for (const hash of commitHashes) {
    try {
      const content = execSync(
        `git show ${hash}:"${gitRelPath}"`,
        { encoding: 'utf8', shell: true, cwd: repoRoot, timeout: 5000 }
      );
      if (content.trim() === orgContent.trim()) {
        return { matched: true, headContent: headContent || content };
      }
    } catch (_) {
      continue;
    }
  }

  return { matched: false, headContent };
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
    `sf project retrieve start ${metadataFlags} --target-metadata-dir "${TMP_DIR}" --unzip --json`,
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

  // Strip force-app/<package>/<namespace>/ prefix to get just classes/Foo.cls etc.
  const forceAppMatch = normalizedLocal.match(/(?:force-app|src)\/[^/]+\/[^/]+\/(.+)/);
  const projectRelative = forceAppMatch
    ? forceAppMatch[1]
    : normalizedLocal.replace(/^\//, '');

  // --target-metadata-dir --unzip uses MDAPI format: files land under <TMP_DIR>/unpackaged/unpackaged/<type>/<name>
  const ORG_BASE = path.join(TMP_DIR, 'unpackaged', 'unpackaged');
  const orgPath = path.join(ORG_BASE, projectRelative);
  const localAbs = path.isAbsolute(normalizedLocal) ? normalizedLocal : path.join(process.cwd(), normalizedLocal);

  if (!fs.existsSync(localAbs)) {
    phantomConflicts.push(localPath);
    continue;
  }

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
    orgDiffTarget = path.join(ORG_BASE, projectRelative);
    const localCompMatch = localAbs.match(/(.*\/(?:lwc|aura)\/[^/]+)/);
    localDiffTarget = localCompMatch ? localCompMatch[1] : localAbs;
  } else if (projectRelative.endsWith('-meta.xml')) {
    // For Apex/other: strip -meta.xml to get the actual content file
    const contentOrgPath = path.join(ORG_BASE, projectRelative.replace(/-meta\.xml$/, ''));
    if (fs.existsSync(contentOrgPath)) {
      orgDiffTarget = contentOrgPath;
      localDiffTarget = localAbs.replace(/-meta\.xml$/, '');
    }
  }

  // --- Phase 1: Git history match ---
  let phase1Phantom = false;

  if (isLWC || isAura) {
    if (fs.existsSync(orgDiffTarget) && fs.statSync(orgDiffTarget).isDirectory()) {
      const orgFiles = getAllFiles(orgDiffTarget);
      if (orgFiles.length > 0) {
        phase1Phantom = orgFiles.every(orgFile => {
          const relToOrg = path.relative(orgDiffTarget, orgFile);
          const correspondingLocal = path.join(localDiffTarget, relToOrg);
          if (!fs.existsSync(correspondingLocal)) return false;
          const orgFileContent = fs.readFileSync(orgFile, 'utf8');
          return orgMatchesGitHistory(orgFileContent, correspondingLocal).matched;
        });
      }
    }
  } else if (fs.existsSync(orgDiffTarget)) {
    const orgContent = fs.readFileSync(orgDiffTarget, 'utf8');
    phase1Phantom = orgMatchesGitHistory(orgContent, localDiffTarget).matched;
  }

  if (phase1Phantom) {
    phantomConflicts.push(localPath);
    continue;
  }

  // --- Phase 2: Subsequence analysis ---
  let diffOutput = '';

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
  } catch (diffErr) {
    diffOutput = diffErr.stdout || diffErr.message || '';
  }

  if (!diffOutput.trim()) {
    phantomConflicts.push(localPath);
    continue;
  }

  const hunks = parseDiffHunks(diffOutput);
  const { covered, uncoveredLines } = allMinusLinesCovered(hunks);

  if (covered) {
    phantomConflicts.push(localPath);
  } else {
    realConflicts.push({
      file: localPath,
      diff: diffOutput.slice(0, 8000),
      orgOnlyLines: uncoveredLines.slice(0, 50)
    });
  }
}

try {
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true });
  }
} catch (_) {}

console.log(JSON.stringify({ realConflicts, phantomConflicts }, null, 2));
process.exit(0);
