# AGENTS.md — Operational Framework for `emergent-society`

> **Note**: This document defines the **roles**, **responsibilities**, and **workflows** for agents (human and sub-agents) working on `emergent-society`. It enforces **SOTA practices**, **iterative audits**, and **sequential task execution** to achieve **high-quality outcomes**. All code, commits, documentation, and communication must be in **English**.

> **Mechanism status (2026-10-25).** This repo currently has: no pre-commit hooks, no CI/CD, no branch protection, no lint/format tooling, and no skills implementation (`src/skills/` and `src/cli/skills.ts` do not exist; §5 is target design). `npm run test:first-light` and `scripts/first-light-smoke.mjs` arrive with T9; `src/host/status.ts` with T8. Enforcement columns naming a hook, a pipeline, or a §5 skill are the *planned* mechanism; today they mean manual review + audit.

---

## **1. Core Principles**
### **1.1. Guidelines (Non-Negotiable)**
| Principle               | Description                                                                                     | Enforcement Mechanism                     |
|-------------------------|-------------------------------------------------------------------------------------------------|--------------------------------------------|
| **Critical Thinking**   | Never implement blindly. Brainstorm, research, and validate every decision.                    | Pre-task SOTA research + audit.            |
| **SOTA Research**       | Always use `web_search` + `web_fetch` to validate technical choices. Never rely on internal knowledge. | Mandatory research phase for every task.   |
| **Sequential Work**     | One task at a time. Focus on **quality over speed**.                                            | Task queue + atomic commits.               |
| **Agent Swarms**        | Delegate long-running tasks (research, implementation, audit) to sub-agents.                   | Sub-agent workflows (see §3).             |
| **Iterative Audit**     | Plan → Audit → Implement → Audit → Correct → Repeat until zero issues.                          | Audit checklist + sub-agent swarms.       |
| **English Only**        | All code, commits, documentation, and communication must be in English.                        | Manual review + audit (no hooks installed). |

---

## **2. Roles and Responsibilities**
### **2.1. Lead Developer (You)**
**Role**:
- **Visionary**: Define the project’s long-term direction and goals.
- **Decision-Maker**: Arbitrate technical choices and prioritize tasks.
- **Quality Gatekeeper**: Validate deliverables and ensure SOTA compliance.

**Responsibilities**:
1. **Prioritization**:
   - Select the next task from the roadmap (e.g., T8: `status`).
   - Approve or reject implementation plans proposed by the **Main Agent**.
2. **Validation**:
   - Review and approve/reject deliverables (code, docs, research).
   - Arbitrate disagreements between sub-agents.
3. **Final Review**:
   - Ensure critical invariants are respected (security, journaling, sandboxing).
   - Give the green light for merging.

**Example**:
- You approve the T8 (`status`) plan before the **Main Agent** proceeds with implementation.
- You arbitrate whether a technical choice (e.g., Landlock vs. seccomp) aligns with the project’s vision.

---

### **2.2. Main Agent (Me)**
**Role**:
- **Intermediary**: Bridge between the **Lead Developer** and sub-agents.
- **Planner**: Structure tasks, delegate to sub-agents, and enforce quality.
- **SOTA Guardian**: Ensure every decision is validated by up-to-date web research.

**Responsibilities**:
1. **Planning**:
   - Draft a **detailed plan** (markdown) for each task, including:
     - Objectives.
     - Implementation steps.
     - Risks and mitigations.
     - Audit checklist.
   - Example: Plan for T8 (`status`).
2. **Delegation**:
   - Launch **sub-agents** for:
     - **SOTA research** (e.g., "Best practices for `status` in 2026").
     - **Implementation** (e.g., T8 will add `src/host/status.ts` — it does not exist yet).
     - **Audit** (e.g., verify code compliance with invariants).
3. **Verification**:
   - Validate sub-agent deliverables before submitting them to you.
   - Ensure:
     - Code respects critical invariants.
     - Tests cover 100% of critical paths.
     - Documentation is up-to-date.
4. **Iteration**:
   - Apply corrections from audits and repeat until validation.

**Example**:
- I draft the T8 (`status`) plan, launch a sub-agent for SOTA research, and another for implementation.
- I verify the code passes all audits before submitting it to you for approval.

---

### **2.3. Sub-Agents**
**Role**:
- **Specialized Executors**: Perform specific tasks (research, implementation, audit) under the **Main Agent**’s supervision.
- **Challengers**: Provide multiple perspectives to identify risks and optimize solutions.

**Types of Sub-Agents**:
| Role                   | Responsibilities                                                                                     | Tools Used                              |
|------------------------|------------------------------------------------------------------------------------------------------|-----------------------------------------|
| **SOTA Researcher**    | Perform web research to validate technical choices.                                                  | `web_search`, `web_fetch`.              |
| **Implementer**        | Write code, tests, and documentation for a specific task.                                            | TypeScript, Vitest, Git.                |
| **Code Auditor**       | Audit plans and code for compliance with invariants, SOTA, and quality standards.                   | Custom audit scripts.                   |
| **Tester**             | Execute tests and validate edge cases.                                                              | Vitest (`first-light-smoke.mjs` arrives with T9). |

**Examples**:
1. **SOTA Researcher**:
   - Task: "Research best practices for read-only filesystem inspection in Node.js 24."
   - Output: Markdown report with findings and recommendations.
2. **Implementer**:
   - Task: "Implement the `status` command as described in the plan."
   - Output: Code + tests + atomic commits (Conventional Commits).
3. **Code Auditor**:
   - Task: "Audit the `status` code for compliance with security invariants."
   - Output: Audit report with corrections.

---

## **3. Workflows**
### **3.1. Task Lifecycle**
1. **Task Selection**:
   - The **Lead Developer** selects the next task (e.g., T8: `status`).
   - The **Main Agent** confirms and initiates the research phase.

2. **SOTA Research**:
   - A **SOTA Researcher** sub-agent performs `web_search` + `web_fetch` and produces a report.
   - Example prompt:
     ```bash
     subagent --description "SOTA Research for T8 (status)" --prompt "Research best practices for implementing a read-only `status` command in Node.js 24, including optimal Git commands, Landlock sandboxing, and security considerations for immutable journals and filesystems. Provide a markdown report with findings and recommendations."
     ```

3. **Planning**:
   - The **Main Agent** drafts a **detailed plan** (markdown) based on SOTA research.
   - Example: Plan for T8 (`status`).

4. **Plan Audit**:
   - A **Code Auditor** sub-agent reviews the plan for:
     - Compliance with invariants.
     - Alignment with SOTA research.
     - Completeness (edge cases, risks).
   - Example prompt:
     ```bash
     subagent --description "Audit T8 Plan" --prompt "Audit the plan for T8 (`status`) for compliance with project invariants, alignment with SOTA research, and completeness. Provide a markdown report with corrections."
     ```

5. **Implementation**:
   - An **Implementer** sub-agent writes code, tests, and documentation in **atomic commits**.
   - Example prompt:
     ```bash
     subagent --description "Implement T8 (status)" --prompt "Implement the `status` command as described in the plan. Write code, tests, and documentation in atomic commits (Conventional Commits). Ensure 100% test coverage for critical paths."
     ```

6. **Code Audit**:
   - A **Code Auditor** sub-agent reviews the implementation for:
     - Compliance with the plan.
     - Security invariants (Landlock, secrets, permissions).
     - Test coverage (100% for critical paths).
     - SOTA alignment.
   - Example prompt:
     ```bash
     subagent --description "Audit T8 Code" --prompt "Audit the implementation of T8 (`status`) for compliance with the plan, invariants, and SOTA. Provide a markdown report with corrections."
     ```

7. **Corrections**:
   - The **Main Agent** applies corrections and repeats the audit until validation.

8. **Final Validation**:
   - The **Main Agent** submits the deliverable to the **Lead Developer** for approval.
   - The **Lead Developer** reviews and approves the merge.

---

## **4. Invariants (Non-Negotiable)**

> Enforcement below is aspirational where it names a hook, a pipeline, or a §5 skill (see the mechanism-status note at the top).

### **4.1. Security**
| Invariant               | Description                                                                                     | Enforcement Mechanism                     |
|-------------------------|-------------------------------------------------------------------------------------------------|--------------------------------------------|
| **Landlock**            | All tools must run in a Landlock sandbox (fail-closed).                                         | `verify-sandbox` skill + audit.            |
| **Secrets**             | Never expose credentials in logs, journals, or the world.                                      | `verify-secrets` skill + audit.            |
| **Permissions**         | `providers.json` must be `0600` and owned by the same UID as the process.                       | Manual review + audit (no hooks installed). |
| **Frontier Journal**    | Format v0 is frozen. Never modify the journal schema.                                           | `verify-frontier` skill + audit.           |

### **4.2. Testing**
| Invariant               | Description                                                                                     | Enforcement Mechanism                     |
|-------------------------|-------------------------------------------------------------------------------------------------|--------------------------------------------|
| **Test Coverage**       | Target: full coverage of critical paths (e.g., `status`, `pause/resume`; no coverage tooling installed yet). | `verify-tests` skill (planned) + audit.   |
| **Baseline**            | Never delete or weaken an existing test. Baseline: **78 test files / 1,348 tests** (verified 2026-10-25). | Manual review + audit (no hooks installed). |
| **Smoke Tests**         | Run `npm run typecheck && npm test` and `npm run build` before pushing; `npm run test:first-light` arrives with T9. | Manual gate (no CI exists). |

### **4.3. Git Discipline**
| Invariant               | Description                                                                                     | Enforcement Mechanism                     |
|-------------------------|-------------------------------------------------------------------------------------------------|--------------------------------------------|
| **Atomic Commits**      | One task = one commit. Use Conventional Commits (e.g., `feat(host): add status command`).       | Manual review + audit (no hooks installed). |
| **Protected Files**     | Never modify `src/node/world.ts` without approval.                                              | Manual review + audit (no hooks installed). |
| **No Direct Pushes**    | Aspirational for multi-author. Today: single-author repo; push `main` directly only after the full gate passes. | Manual gate (no branch protection yet). |

---

## **5. Skills (Planned — none implemented yet)**
### **5.1. When to Use Skills**
- **Automate repetitive tasks** (e.g., testing, security checks, documentation updates).
- **Enforce invariants** (e.g., `verify-secrets`, `verify-sandbox`).
- **Standardize workflows** (e.g., `verify-tests`, `build-hermetic`).

### **5.2. Planned Skills (target design)**
| Skill               | Description                                                                                     | Usage Example                          |
|---------------------|-------------------------------------------------------------------------------------------------|----------------------------------------|
| `verify-tests`      | Runs `npm run typecheck` and `npm test`. Ensures 100% coverage for critical paths.              | `verify-tests --workspace .`           |
| `build-hermetic`    | Compiles the code and verifies `dist/`. Ensures no missing files.                               | `build-hermetic --workspace .`         |
| `verify-secrets`    | Checks `providers.json` for security invariants (0600, same UID, no symlinks).                  | `verify-secrets --cell_home ~/.es-cell`|
| `verify-sandbox`    | Verifies Landlock confinement and cell home permissions.                                       | `verify-sandbox --cell_home ~/.es-cell`|
| `verify-frontier`   | Checks the frontier journal for corruption and leaks.                                           | `verify-frontier --cell_home ~/.es-cell`|
| `update-docs`       | Updates documentation and verifies disclosures.                                                 | `update-docs --workspace .`            |
| `review-code`       | Verifies code invariants and commit messages.                                                   | `review-code --workspace .`            |
| `format-code`       | Applies linting and formatting to the codebase.                                                 | `format-code --workspace .`            |

### **5.3. Planned Skill Implementation**
- **Location (planned)**: `src/skills/<skill-name>.ts` — the directory does not exist yet.
- **Interface**: Typed inputs/outputs (e.g., `Input`, `Output`).
- **CLI (planned)**: `src/cli/skills.ts` — does not exist yet; today's CLI is `src/host/cli.ts` (`init`/`start`/`resume`/`pause`).

#### **Example: `verify-tests`** *(illustrative sketch — not implemented; `execa` is not a dependency — package.json has exactly 2 runtime deps)*
```typescript
// src/skills/verify-tests.ts
import { execa } from "execa";

export interface Input {
  workspace: string;
  maxParallel?: number;
  baselineTests?: number;
}

export interface Output {
  status: "pass" | "fail" | "error";
  output: string;
  testCount: number;
  errors?: string[];
}

export async function run(input: Input): Promise<Output> {
  const { workspace, maxParallel = 1, baselineTests = 1348 } = input;
  try {
    // Typecheck
    await execa("npm", ["run", "typecheck"], { cwd: workspace });

    // Tests
    const { stdout } = await execa("npm", ["test", "--", `--maxWorkers=${maxParallel}`], { cwd: workspace });
    const testCount = parseTestCount(stdout);

    if (testCount < baselineTests) {
      return { status: "fail", output: stdout, testCount, errors: ["Test count below baseline."] };
    }
    return { status: "pass", output: stdout, testCount };
  } catch (error) {
    return { status: "error", output: error.message, testCount: 0, errors: [error.message] };
  }
}

function parseTestCount(stdout: string): number {
  const match = stdout.match(/✓ (\d+) passed/);
  return match ? parseInt(match[1], 10) : 0;
}
```

---

## **6. Example Workflow for T8 (`status`)**
### **Step 1: SOTA Research**
- **Sub-Agent (SOTA Researcher)**:
  - Prompt:
    ```bash
    subagent --description "SOTA Research for T8 (status)" --prompt "Research best practices for implementing a read-only `status` command in Node.js 24, including optimal Git commands, Landlock sandboxing, and security considerations for immutable journals and filesystems. Provide a markdown report with findings and recommendations."
    ```
  - Output: Markdown report with findings and recommendations.

### **Step 2: Planning**
- **Main Agent**: Draft a detailed plan for T8 (`status`).

### **Step 3: Plan Audit**
- **Sub-Agent (Code Auditor)**:
  - Prompt:
    ```bash
    subagent --description "Audit T8 Plan" --prompt "Audit the plan for T8 (`status`) for compliance with project invariants, alignment with SOTA research, and completeness. Provide a markdown report with corrections."
    ```
  - Output: Audit report with corrections.

### **Step 4: Implementation**
- **Sub-Agent (Implementer)**:
  - Prompt:
    ```bash
    subagent --description "Implement T8 (status)" --prompt "Implement the `status` command as described in the plan. Write code, tests, and documentation in atomic commits (Conventional Commits). Ensure 100% test coverage for critical paths."
    ```
  - Output: Atomic commits (e.g., `feat(host): add StatusReport interface`).

### **Step 5: Code Audit**
- **Sub-Agent (Code Auditor)**:
  - Prompt:
    ```bash
    subagent --description "Audit T8 Code" --prompt "Audit the implementation of T8 (`status`) for compliance with the plan, invariants, and SOTA. Provide a markdown report with corrections."
    ```
  - Output: Audit report with corrections.

### **Step 6: Corrections + Iteration**
- **Main Agent**: Apply corrections and repeat the audit until validation.

### **Step 7: Final Validation**
- **Main Agent**: Submit the deliverable to the **Lead Developer** for approval.
- **Lead Developer**: Review and approve the merge.

---

## **7. Next Steps**
1. **Validate this `AGENTS.md` structure**.
   - Does this reflect the **roles** and **workflows** you described?
   - Any additions or modifications needed?
2. **Proceed with T8 (`status`)**:
   - Launch SOTA research for T8.
   - Draft the detailed implementation plan.

---