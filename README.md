# Cursor Subagents

A collection of custom subagents for [Cursor](https://cursor.com) that extend the AI agent with specialized capabilities. These subagents can be used across all your projects when installed at the user level.

## Subagents

| Subagent | Description |
|----------|-------------|
| [test-class-fixer](#test-class-fixer) | Debugging specialist for Salesforce Apex test classes |
| [sf-deploy-guard](#sf-deploy-guard) | Deployment safety guard: validates, detects org-vs-local conflicts, deploys only when safe |

---

## How to Add Subagents to Cursor (User-Level)

To use these subagents across **all your projects**, install them as user-level subagents:

1. **Create the user directories** (if they don't exist):
   ```bash
   mkdir -p ~/.cursor/agents
   mkdir -p ~/.cursor/scripts
   ```

2. **Copy the subagent file** into `~/.cursor/agents/`:
   ```bash
   cp subagents/test-class-fixer/test-class-fixer.md ~/.cursor/agents/
   ```

3. **Copy required scripts** (for subagents that use them) into `~/.cursor/scripts/`:
   ```bash
   cp subagents/test-class-fixer/scripts/run-apex-tests.js ~/.cursor/scripts/
   cp subagents/sf-deploy-guard/scripts/*.js ~/.cursor/scripts/
   ```

4. **Verify installation** — Cursor will automatically discover subagents in `~/.cursor/agents/`. You can invoke them by name in your prompts.

### Alternative: Project-Level Installation

To use a subagent only in a specific project, copy it to that project's `.cursor/agents/` directory:

```bash
mkdir -p .cursor/agents
cp subagents/test-class-fixer/test-class-fixer.md .cursor/agents/
```

The test-class-fixer subagent uses `run-apex-tests.js`, and sf-deploy-guard uses `validate-deploy.js`, `preview-conflicts.js`, `analyze-conflicts.js`, and `execute-deploy.js`. All must be in `~/.cursor/scripts/`. Ensure you've run the user-level script setup above so the scripts are available.

Project subagents take precedence over user subagents when names conflict.

### Invoking Subagents

- **Explicit invocation**: Use `/test-class-fixer` or `/sf-deploy-guard` in your prompt, e.g. `> /test-class-fixer fix MyTestClass` or `> /sf-deploy-guard deploy MyClass MyLWC`
- **Natural mention**: e.g. `> Use the test-class-fixer subagent to fix ApprovalHandlerTest` or `> Use sf-deploy-guard to deploy these components`

---

## test-class-fixer

**Purpose**: Debugging specialist for Salesforce Apex test classes.

The test-class-fixer subagent fixes failing Apex test classes by systematically analyzing errors, identifying root causes, and applying fixes to either the test class or the production class under test—whichever contains the issue.

### Dependencies

- **run-apex-tests.js** — A Node script in `~/.cursor/scripts/` that runs `sf apex run test` and outputs a condensed JSON (summary + failures with messages and stack traces). Install it using the setup steps above.

### When to Use

- When you provide one or more Apex test class names that are failing
- When you need tests fixed proactively (the subagent activates immediately when given test class names)

### Input Format

Accepts test class names as:
- Single name: `ApprovalHandlerTest`
- Comma-separated: `ClassA,ClassB,ClassC`
- Whitespace-separated: `ClassA ClassB ClassC`

### What It Does

1. **Runs tests** — Executes only the specified test classes via `node ~/.cursor/scripts/run-apex-tests.js` (a Node script that runs `sf apex run test` and returns a condensed JSON summary of results and failures)
2. **Analyzes failures** — Parses the script's JSON output for error messages, stack traces, and assertion errors
3. **Identifies root cause** — Determines whether the failure is in the test class (assertions, setup, mocking) or the production class (null pointers, logic errors)
4. **Applies fixes** — Modifies the appropriate file(s) and deploys only the changed classes
5. **Verifies** — Re-runs tests and repeats up to 5 attempts until all pass or the limit is reached

### Key Practices

- Uses `sf project deploy start --metadata ApexClass:Name1,ApexClass:Name2` to deploy only modified classes
- Fixes root causes, not symptoms (e.g., adds proper test data instead of mocking around nulls)
- Follows Salesforce best practices (Test.startTest/stopTest, proper assertions)

---

## sf-deploy-guard

**Purpose**: Salesforce deployment safety guard. Validates metadata, detects org-vs-local conflicts via diff analysis, and deploys only when safe. Stops on real conflicts and guides the user to merge org changes before deploying.

### Dependencies

Four Node scripts in `~/.cursor/scripts/`:
- **validate-deploy.js** — Runs `sf project deploy validate`, returns condensed success/errors JSON
- **preview-conflicts.js** — Runs `sf project deploy preview`, returns only conflict-flagged files
- **analyze-conflicts.js** — Retrieves org versions to `/tmp`, diffs each file, classifies real vs phantom conflicts, cleans up
- **execute-deploy.js** — Runs `sf project deploy start`, returns condensed success/failure JSON

Install all four using the setup steps above.

### When to Use

- When deploying components (Apex, LWC, Custom Objects, etc.) to a Salesforce org
- When you want to avoid overwriting someone else's org changes
- Works best with scratch orgs or sandboxes that have source tracking enabled

### Input Format

Accepts component names as:
- Bare names: `MyClass MyLWC MyObject`
- Typed: `ApexClass:MyClass LightningComponentBundle:MyLWC`
- Mixed formats, comma or space separated

### What It Does

1. **Validates** — Runs deploy validate; fixes errors up to 3 times
2. **Previews conflicts** — Checks which files have org-vs-local conflicts
3. **Analyzes conflicts** — For conflicted files, retrieves org versions and diffs; distinguishes real conflicts (org has unretrieved changes) from phantom conflicts (only local changes)
4. **Stops on real conflicts** — Explains what org changes would be overwritten, tells the user what to merge, waits for confirmation, then restarts from step 1
5. **Deploys when safe** — Asks for user confirmation, then deploys only when no real conflicts exist

### Key Practices

- Never deploys when `analyze-conflicts.js` returns any `realConflicts`
- On real conflicts: stop, explain, wait for user to merge, restart from validate
- All SF CLI calls go through scripts for token efficiency
