# Cursor Subagents

A collection of custom subagents for [Cursor](https://cursor.com) that extend the AI agent with specialized capabilities. These subagents can be used across all your projects when installed at the user level.

## Subagents

| Subagent | Description |
|----------|-------------|
| [test-class-fixer](#test-class-fixer) | Debugging specialist for Salesforce Apex test classes |

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
   ```

4. **Verify installation** — Cursor will automatically discover subagents in `~/.cursor/agents/`. You can invoke them by name in your prompts.

### Alternative: Project-Level Installation

To use a subagent only in a specific project, copy it to that project's `.cursor/agents/` directory:

```bash
mkdir -p .cursor/agents
cp subagents/test-class-fixer/test-class-fixer.md .cursor/agents/
```

The test-class-fixer subagent uses `run-apex-tests.js`, which must be in `~/.cursor/scripts/`. Ensure you've run the user-level script setup above so the script is available.

Project subagents take precedence over user subagents when names conflict.

### Invoking Subagents

- **Explicit invocation**: Use `/test-class-fixer` in your prompt, e.g. `> /test-class-fixer fix MyTestClass`
- **Natural mention**: e.g. `> Use the test-class-fixer subagent to fix ApprovalHandlerTest`

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
